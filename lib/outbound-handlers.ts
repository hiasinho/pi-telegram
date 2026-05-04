/**
 * Telegram outbound handler helpers
 * Owns assistant-authored outbound markup extraction, configured artifact generation, callback actions, and Telegram outbound delivery
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { PendingTelegramTurn } from "./queue.ts";
import { buildTelegramMultipartReplyParameters } from "./replies.ts";
import { truncateTelegramQueueSummary } from "./turns.ts";
import {
  buildCommandTemplateInvocation,
  expandCommandTemplateConfigs,
  substituteCommandTemplateToken,
  type CommandTemplateObjectConfig,
} from "./command-templates.ts";

const TELEGRAM_BUTTON_CALLBACK_PREFIX = "tgbtn";
const TELEGRAM_BUTTON_ACTION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VOICE_TIMEOUT_MS = 120_000;

export type TelegramOutboundCommandTemplateConfig =
  | string
  | CommandTemplateObjectConfig;
export interface TelegramOutboundHandlerConfig extends CommandTemplateObjectConfig {
  type?: string;
  match?: string | string[];
  pipe?: TelegramOutboundCommandTemplateConfig[];
  output?: string;
  timeout?: number;
}

export interface TelegramVoiceReplyItem {
  text: string;
  lang?: string;
  rate?: string;
}

export interface TelegramVoiceReplyPlan {
  markdown: string;
  voiceText?: string;
  voiceReplies?: TelegramVoiceReplyItem[];
  lang?: string;
  rate?: string;
}

export interface TelegramVoiceExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
}

export interface TelegramVoiceExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface TelegramVoiceReplyTurnView {
  chatId: number;
  replyToMessageId: number;
}

export interface TelegramVoiceReplySenderDeps {
  execCommand: (
    command: string,
    args: string[],
    options?: TelegramVoiceExecOptions,
  ) => Promise<TelegramVoiceExecResult>;
  sendMultipart: (
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
  ) => Promise<unknown>;
  sendTextReply?: (
    chatId: number,
    replyToMessageId: number,
    text: string,
  ) => Promise<unknown>;
  getHandlers?: () => TelegramOutboundHandlerConfig[] | undefined;
  tempDir?: string;
  cwd?: string;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

interface TelegramTopLevelHtmlComment {
  raw: string;
  content: string;
  start: number;
  end: number;
}

function getMarkdownLineEnd(markdown: string, offset: number): number {
  const newlineIndex = markdown.indexOf("\n", offset);
  return newlineIndex === -1 ? markdown.length : newlineIndex + 1;
}

function getMarkdownLineText(
  markdown: string,
  offset: number,
  end: number,
): string {
  return markdown.slice(offset, end).replace(/\r?\n$/, "");
}

function getTopLevelFenceMarker(line: string): "```" | "~~~" | undefined {
  const match = line.match(/^(?: {0,3})(```|~~~)/);
  return match?.[1] as "```" | "~~~" | undefined;
}

function collectTopLevelHtmlComments(markdown: string): {
  comments: TelegramTopLevelHtmlComment[];
  openCommentStart?: number;
} {
  const comments: TelegramTopLevelHtmlComment[] = [];
  let offset = 0;
  let fenceMarker: "```" | "~~~" | undefined;
  while (offset < markdown.length) {
    const lineEnd = getMarkdownLineEnd(markdown, offset);
    const line = getMarkdownLineText(markdown, offset, lineEnd);
    if (fenceMarker) {
      if (line.startsWith(fenceMarker)) fenceMarker = undefined;
      offset = lineEnd;
      continue;
    }
    const nextFenceMarker = getTopLevelFenceMarker(line);
    if (nextFenceMarker) {
      fenceMarker = nextFenceMarker;
      offset = lineEnd;
      continue;
    }
    if (line.startsWith("<!--")) {
      const closeIndex = markdown.indexOf("-->", offset + 4);
      if (closeIndex === -1) return { comments, openCommentStart: offset };
      const end = closeIndex + 3;
      const raw = markdown.slice(offset, end);
      comments.push({ raw, content: raw.slice(4, -3), start: offset, end });
      offset = getMarkdownLineEnd(markdown, end);
      continue;
    }
    offset = lineEnd;
  }
  return { comments };
}

function replaceTopLevelHtmlComments(
  markdown: string,
  replacer: (comment: TelegramTopLevelHtmlComment) => string,
): string {
  const { comments } = collectTopLevelHtmlComments(markdown);
  if (comments.length === 0) return markdown;
  let result = "";
  let offset = 0;
  for (const comment of comments) {
    result += markdown.slice(offset, comment.start);
    result += replacer(comment);
    offset = comment.end;
  }
  return result + markdown.slice(offset);
}

function findTopLevelOpenOrPartialHtmlCommentIndex(markdown: string): number {
  const { openCommentStart } = collectTopLevelHtmlComments(markdown);
  if (openCommentStart !== undefined) return openCommentStart;
  let offset = 0;
  let fenceMarker: "```" | "~~~" | undefined;
  while (offset < markdown.length) {
    const lineEnd = getMarkdownLineEnd(markdown, offset);
    const line = getMarkdownLineText(markdown, offset, lineEnd);
    const isLastLine = lineEnd >= markdown.length;
    if (fenceMarker) {
      if (line.startsWith(fenceMarker)) fenceMarker = undefined;
      offset = lineEnd;
      continue;
    }
    const nextFenceMarker = getTopLevelFenceMarker(line);
    if (nextFenceMarker) {
      fenceMarker = nextFenceMarker;
      offset = lineEnd;
      continue;
    }
    if (isLastLine && (line === "<" || line === "<!" || line === "<!-")) {
      return offset;
    }
    offset = lineEnd;
  }
  return -1;
}

function parseTopLevelTelegramComment(
  comment: TelegramTopLevelHtmlComment,
  command: string,
): { head: string; body?: string } | undefined {
  const normalizedContent = comment.content.replace(/^\s+/, "");
  const [rawHead = "", ...bodyLines] = normalizedContent.split(/\r?\n/);
  const head = rawHead.trimStart();
  if (!head.startsWith(command)) return undefined;
  const nextChar = head[command.length];
  if (nextChar !== undefined && !/\s|:/.test(nextChar)) return undefined;
  return {
    head: head.slice(command.length),
    ...(bodyLines.length > 0 ? { body: bodyLines.join("\n") } : {}),
  };
}

function parseVoiceReplyAttributes(input: string): {
  lang?: string;
  rate?: string;
} {
  const attributes: { lang?: string; rate?: string } = {};
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    const [rawKey, ...valueParts] = token.split("=");
    const value = valueParts.join("=").trim();
    if (rawKey === "lang" && value) attributes.lang = value;
    if (rawKey === "rate" && value) attributes.rate = value;
  }
  return attributes;
}

function parseVoiceCommentBody(
  head: string,
  body: string | undefined,
): {
  attrs: string;
  text: string;
} {
  const trimmedHead = head.trim();
  if (body !== undefined) {
    return { attrs: trimmedHead.replace(/^:/, "").trim(), text: body.trim() };
  }
  if (trimmedHead.startsWith(":")) {
    return { attrs: "", text: trimmedHead.slice(1).trim() };
  }
  return { attrs: trimmedHead, text: "" };
}

function normalizeMarkdownAfterVoiceExtraction(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

export function stripTelegramCommentMarkupForPreview(markdown: string): string {
  const withoutClosedBlocks = replaceTopLevelHtmlComments(markdown, () => "");
  const openBlockIndex = findTopLevelOpenOrPartialHtmlCommentIndex(
    withoutClosedBlocks,
  );
  const previewMarkdown =
    openBlockIndex >= 0
      ? withoutClosedBlocks.slice(0, openBlockIndex)
      : withoutClosedBlocks;
  return normalizeMarkdownAfterVoiceExtraction(previewMarkdown);
}

export function stripTelegramCommentMarkupForDelivery(
  markdown: string,
): string {
  const withoutClosedBlocks = replaceTopLevelHtmlComments(markdown, () => "");
  const openBlockIndex = findTopLevelOpenOrPartialHtmlCommentIndex(
    withoutClosedBlocks,
  );
  const deliveryMarkdown =
    openBlockIndex >= 0
      ? withoutClosedBlocks.slice(0, openBlockIndex)
      : withoutClosedBlocks;
  return normalizeMarkdownAfterVoiceExtraction(deliveryMarkdown);
}

export function stripTelegramVoiceMarkupForPreview(markdown: string): string {
  return stripTelegramCommentMarkupForPreview(markdown);
}

export function planTelegramVoiceReply(
  markdown: string,
): TelegramVoiceReplyPlan {
  const voiceReplies: TelegramVoiceReplyItem[] = [];
  let lang: string | undefined;
  let rate: string | undefined;
  const stripped = replaceTopLevelHtmlComments(markdown, (comment) => {
    const command = parseTopLevelTelegramComment(comment, "telegram_voice");
    if (!command) return "";
    const parsed = parseVoiceCommentBody(command.head, command.body);
    const attrs = parseVoiceReplyAttributes(parsed.attrs);
    if (parsed.text) {
      voiceReplies.push({
        text: parsed.text,
        ...(attrs.lang ? { lang: attrs.lang } : {}),
        ...(attrs.rate ? { rate: attrs.rate } : {}),
      });
    }
    if (attrs.lang) lang = attrs.lang;
    if (attrs.rate) rate = attrs.rate;
    return "";
  });
  const voiceText = voiceReplies
    .map((reply) => reply.text)
    .join("\n\n")
    .trim();
  return {
    markdown: stripTelegramCommentMarkupForDelivery(stripped),
    ...(voiceText ? { voiceText } : {}),
    ...(voiceReplies.length > 0 ? { voiceReplies } : {}),
    ...(lang ? { lang } : {}),
    ...(rate ? { rate } : {}),
  };
}

function getVoiceReplyConfiguredTimeout(
  config: TelegramOutboundCommandTemplateConfig | undefined,
): number | undefined {
  const timeout = typeof config === "string" ? undefined : config?.timeout;
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
    ? timeout
    : undefined;
}

function getVoiceReplyTimeout(
  config: TelegramOutboundCommandTemplateConfig | undefined,
): number {
  return getVoiceReplyConfiguredTimeout(config) ?? DEFAULT_VOICE_TIMEOUT_MS;
}

function getRemainingVoiceReplyTimeout(
  timeout: number,
  startedAt: number,
): number {
  return Math.max(1, timeout - (Date.now() - startedAt));
}

function getVoiceReplyCompositionStepTimeout(
  handlerTimeout: number,
  step: TelegramOutboundCommandTemplateConfig,
  startedAt: number,
): number {
  const remaining = getRemainingVoiceReplyTimeout(handlerTimeout, startedAt);
  const stepTimeout = getVoiceReplyConfiguredTimeout(step);
  return stepTimeout === undefined ? remaining : Math.min(stepTimeout, remaining);
}

function formatVoiceReplyExecutionFailure(
  label: string,
  result: TelegramVoiceExecResult,
): string {
  const parts = [
    `${label} exited with code ${result.code}${result.killed ? " (killed)" : ""}`,
  ];
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`);
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`);
  return parts.join("\n\n");
}

function extractVoiceReplyPath(stdout: string): string {
  const path = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!path) throw new Error("Voice generator did not print an output path");
  return path;
}

async function runVoiceReplyCommand(
  label: string,
  config: TelegramOutboundCommandTemplateConfig,
  values: Record<string, string>,
  options: {
    cwd: string;
    timeout: number;
    execCommand: TelegramVoiceReplySenderDeps["execCommand"];
    stdin?: string;
  },
): Promise<TelegramVoiceExecResult> {
  const invocation = buildCommandTemplateInvocation(
    config,
    values,
    options.cwd,
    {
      emptyMessage: "Outbound voice template is empty",
      missingLabel: "outbound voice template",
    },
  );
  const result = await options.execCommand(
    invocation.command,
    invocation.args,
    {
      cwd: options.cwd,
      timeout: options.timeout,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    },
  );
  if (result.code !== 0)
    throw new Error(formatVoiceReplyExecutionFailure(label, result));
  return result;
}

function getVoiceReplyOutputPath(
  config: TelegramOutboundHandlerConfig,
  values: Record<string, string>,
  stdout: string,
): string {
  const output = config.output ?? "stdout";
  if (output === "stdout") return extractVoiceReplyPath(stdout);
  const keyMatch = output.match(/^\{?([A-Za-z_][A-Za-z0-9_-]*)\}?$/);
  if (keyMatch && Object.hasOwn(values, keyMatch[1]))
    return values[keyMatch[1]] ?? "";
  return substituteCommandTemplateToken(
    output,
    values,
    "outbound voice template",
  );
}

function getVoiceReplyTemplateValues(
  text: string,
  options: { lang?: string; rate?: string; mp3Path: string; oggPath: string },
): Record<string, string> {
  return {
    text,
    mp3: options.mp3Path,
    ogg: options.oggPath,
    ...(options.lang ? { lang: options.lang } : {}),
    ...(options.rate ? { rate: options.rate } : {}),
  };
}

function getDefaultTelegramVoiceTempDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "tmp", "telegram");
}

function normalizeOutboundHandlerStringList(
  value: string | string[] | undefined,
): string[] {
  if (Array.isArray(value))
    return value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function outboundHandlerMatchesType(
  handler: TelegramOutboundHandlerConfig,
  type: string,
): boolean {
  const selectors = [
    ...normalizeOutboundHandlerStringList(handler.type),
    ...normalizeOutboundHandlerStringList(handler.match),
  ];
  if (selectors.length === 0) return false;
  return selectors.includes(type);
}

export function findTelegramOutboundHandlers(
  handlers: TelegramOutboundHandlerConfig[] | undefined,
  type: string,
): TelegramOutboundHandlerConfig[] {
  if (!Array.isArray(handlers)) return [];
  return handlers.filter(
    (handler) =>
      !!handler &&
      typeof handler === "object" &&
      outboundHandlerMatchesType(handler, type),
  );
}

function getTelegramVoiceHandlerCompositionSteps(
  handler: TelegramOutboundHandlerConfig,
): TelegramOutboundCommandTemplateConfig[] {
  if (Array.isArray(handler.template)) {
    return expandCommandTemplateConfigs(
      handler,
    ) as TelegramOutboundCommandTemplateConfig[];
  }
  if (handler.pipe?.length) {
    return expandCommandTemplateConfigs({
      ...handler,
      template: handler.pipe,
    }) as TelegramOutboundCommandTemplateConfig[];
  }
  return [];
}

async function generateTelegramVoiceReplyFileWithHandler(
  text: string,
  options: {
    lang?: string;
    rate?: string;
    handler: TelegramOutboundHandlerConfig;
    tempDir: string;
    cwd: string;
    timeout: number;
    execCommand: TelegramVoiceReplySenderDeps["execCommand"];
  },
): Promise<string> {
  await mkdir(options.tempDir, { recursive: true });
  const artifactId = randomUUID();
  const values = getVoiceReplyTemplateValues(text, {
    lang: options.lang,
    rate: options.rate,
    mp3Path: join(options.tempDir, `${artifactId}-voice.mp3`),
    oggPath: join(options.tempDir, `${artifactId}-voice.ogg`),
  });
  const steps = getTelegramVoiceHandlerCompositionSteps(options.handler);
  if (steps.length > 0) {
    const startedAt = Date.now();
    let stdout = "";
    for (const [index, step] of steps.entries()) {
      const result = await runVoiceReplyCommand(
        `Outbound voice template step ${index + 1}`,
        step,
        values,
        {
          cwd: options.cwd,
          timeout: getVoiceReplyCompositionStepTimeout(
            options.timeout,
            step,
            startedAt,
          ),
          execCommand: options.execCommand,
          ...(index === 0 ? {} : { stdin: stdout }),
        },
      );
      stdout = result.stdout;
    }
    return getVoiceReplyOutputPath(options.handler, values, stdout);
  }
  const result = await runVoiceReplyCommand(
    "Outbound voice template",
    options.handler,
    values,
    {
      cwd: options.cwd,
      timeout: options.timeout,
      execCommand: options.execCommand,
    },
  );
  return extractVoiceReplyPath(result.stdout);
}

export async function generateTelegramVoiceReplyFile(
  text: string,
  options: {
    lang?: string;
    rate?: string;
    handler?: TelegramOutboundHandlerConfig;
    tempDir?: string;
    cwd?: string;
    execCommand: TelegramVoiceReplySenderDeps["execCommand"];
  },
): Promise<string | undefined> {
  const cwd = options.cwd ?? process.cwd();
  const handler = options.handler;
  if (!handler?.template && !handler?.pipe?.length) return undefined;
  return generateTelegramVoiceReplyFileWithHandler(text, {
    lang: options.lang,
    rate: options.rate,
    handler,
    tempDir: options.tempDir ?? getDefaultTelegramVoiceTempDir(),
    cwd,
    timeout: getVoiceReplyTimeout(handler),
    execCommand: options.execCommand,
  });
}

export interface TelegramOutboundReplyPlan<TReplyMarkup = unknown> {
  markdown: string;
  replyMarkup?: TReplyMarkup;
  voiceText?: string;
  voiceReplies?: TelegramVoiceReplyItem[];
  lang?: string;
  rate?: string;
}

export function createTelegramVoiceReplySender(
  deps: TelegramVoiceReplySenderDeps,
) {
  return async function sendVoiceReply(
    turn: TelegramVoiceReplyTurnView,
    text: string,
    options?: { lang?: string; rate?: string; replyToPrompt?: boolean },
  ): Promise<void> {
    const handlers = findTelegramOutboundHandlers(
      deps.getHandlers?.(),
      "voice",
    );
    if (handlers.length === 0) return;
    for (const handler of handlers) {
      try {
        const filePath = await generateTelegramVoiceReplyFile(text, {
          lang: options?.lang,
          rate: options?.rate,
          handler,
          tempDir: deps.tempDir,
          cwd: deps.cwd,
          execCommand: deps.execCommand,
        });
        if (!filePath) continue;
        const replyParameters = buildTelegramMultipartReplyParameters(
          options?.replyToPrompt === false ? undefined : turn.replyToMessageId,
        );
        await deps.sendMultipart(
          "sendVoice",
          {
            chat_id: String(turn.chatId),
            ...(replyParameters ? { reply_parameters: replyParameters } : {}),
          },
          "voice",
          filePath,
          basename(filePath),
        );
        return;
      } catch (error) {
        deps.recordRuntimeEvent?.("voice", error, { phase: "send" });
      }
    }
    await deps.sendTextReply?.(
      turn.chatId,
      turn.replyToMessageId,
      "Failed to send voice reply: every matching outbound voice handler failed.",
    );
  };
}

export interface TelegramOutboundButtonAction {
  text: string;
  prompt: string;
}

export interface TelegramOutboundButtonStoredAction extends TelegramOutboundButtonAction {
  createdAt: number;
}

export interface TelegramOutboundButtonMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface TelegramButtonReplyPlan {
  markdown: string;
  replyMarkup?: TelegramOutboundButtonMarkup;
}

export interface TelegramButtonActionStore {
  register: (action: TelegramOutboundButtonAction) => string;
  resolve: (
    callbackData: string | undefined,
  ) => TelegramOutboundButtonAction | undefined;
}

export interface TelegramButtonCallbackQuery {
  id: string;
  data?: string;
  message?: {
    message_id?: number;
    chat?: { id?: number };
  };
}

export interface TelegramButtonCallbackHandlerDeps<TContext = unknown> {
  resolveAction: (
    callbackData: string | undefined,
  ) => TelegramOutboundButtonAction | undefined;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  enqueueButtonPrompt: (
    query: TelegramButtonCallbackQuery,
    action: TelegramOutboundButtonAction,
    ctx: TContext,
  ) => void;
}

function nowMs(): number {
  return Date.now();
}

function normalizeMarkdownAfterButtonExtraction(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

function parseButtonsCommentAttributes(input: string): { label?: string } {
  const attributes: { label?: string } = {};
  for (const match of input.matchAll(
    /([A-Za-z_][A-Za-z0-9_-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/g,
  )) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (key === "label" && value.trim()) attributes.label = value.trim();
  }
  return attributes;
}

function parseButtonsCommentRows(
  head: string,
  body: string | undefined,
): TelegramOutboundButtonAction[][] {
  const attributes = parseButtonsCommentAttributes(head);
  const prompt = body?.trim();
  if (!attributes.label || !prompt) return [];
  return [[{ text: attributes.label, prompt }]];
}

export function createTelegramButtonActionStore(
  options: { ttlMs?: number } = {},
): TelegramButtonActionStore {
  const ttlMs = options.ttlMs ?? TELEGRAM_BUTTON_ACTION_TTL_MS;
  const actions = new Map<string, TelegramOutboundButtonStoredAction>();
  function cleanup(currentTime: number): void {
    for (const [key, action] of actions) {
      if (currentTime - action.createdAt > ttlMs) actions.delete(key);
    }
  }
  return {
    register: (action) => {
      const currentTime = nowMs();
      cleanup(currentTime);
      const key = `${TELEGRAM_BUTTON_CALLBACK_PREFIX}:${randomUUID().slice(0, 8)}`;
      actions.set(key, { ...action, createdAt: currentTime });
      return key;
    },
    resolve: (callbackData) => {
      if (!callbackData?.startsWith(`${TELEGRAM_BUTTON_CALLBACK_PREFIX}:`))
        return undefined;
      const currentTime = nowMs();
      cleanup(currentTime);
      const action = actions.get(callbackData);
      if (!action) return undefined;
      return { text: action.text, prompt: action.prompt };
    },
  };
}

export function planTelegramButtonReply(
  markdown: string,
  deps: { registerAction: (action: TelegramOutboundButtonAction) => string },
): TelegramButtonReplyPlan {
  const keyboard: TelegramOutboundButtonMarkup["inline_keyboard"] = [];
  const stripped = replaceTopLevelHtmlComments(markdown, (comment) => {
    const command = parseTopLevelTelegramComment(comment, "telegram_button");
    if (!command) return comment.raw;
    const rows = parseButtonsCommentRows(command.head, command.body);
    for (const row of rows) {
      keyboard.push(
        row.map((button) => ({
          text: button.text,
          callback_data: deps.registerAction(button),
        })),
      );
    }
    return "";
  });
  return {
    markdown: normalizeMarkdownAfterButtonExtraction(stripped),
    ...(keyboard.length > 0
      ? { replyMarkup: { inline_keyboard: keyboard } }
      : {}),
  };
}

export function createTelegramButtonReplyPlanner(
  store: Pick<TelegramButtonActionStore, "register">,
): (markdown: string) => TelegramButtonReplyPlan {
  return (markdown) =>
    planTelegramButtonReply(markdown, { registerAction: store.register });
}

export function createTelegramOutboundReplyPlanner(
  store: Pick<TelegramButtonActionStore, "register">,
): (
  markdown: string,
) => TelegramOutboundReplyPlan<TelegramOutboundButtonMarkup> {
  return (markdown) => {
    const buttonReply = planTelegramButtonReply(markdown, {
      registerAction: store.register,
    });
    const voiceReply = planTelegramVoiceReply(buttonReply.markdown);
    return {
      markdown: voiceReply.markdown,
      ...(buttonReply.replyMarkup
        ? { replyMarkup: buttonReply.replyMarkup }
        : {}),
      ...(voiceReply.voiceText ? { voiceText: voiceReply.voiceText } : {}),
      ...(voiceReply.voiceReplies
        ? { voiceReplies: voiceReply.voiceReplies }
        : {}),
      ...(voiceReply.lang ? { lang: voiceReply.lang } : {}),
      ...(voiceReply.rate ? { rate: voiceReply.rate } : {}),
    };
  };
}

export function createTelegramOutboundReplyArtifactSender(
  deps: TelegramVoiceReplySenderDeps,
) {
  const sendVoiceReply = createTelegramVoiceReplySender(deps);
  return async function sendOutboundReplyArtifacts(
    turn: TelegramVoiceReplyTurnView,
    plan: Pick<
      TelegramOutboundReplyPlan,
      "voiceText" | "voiceReplies" | "lang" | "rate"
    >,
    options?: { replyToPrompt?: boolean },
  ): Promise<void> {
    const voiceReplies = plan.voiceReplies?.length
      ? plan.voiceReplies
      : plan.voiceText
        ? [{ text: plan.voiceText, lang: plan.lang, rate: plan.rate }]
        : [];
    for (const [index, reply] of voiceReplies.entries()) {
      await sendVoiceReply(turn, reply.text, {
        lang: reply.lang ?? plan.lang,
        rate: reply.rate ?? plan.rate,
        replyToPrompt: options?.replyToPrompt === true && index === 0,
      });
    }
  };
}

export function createTelegramButtonPromptTurn(options: {
  chatId: number;
  replyToMessageId: number;
  queueOrder: number;
  action: TelegramOutboundButtonAction;
}): PendingTelegramTurn {
  const prompt = `[telegram] ${options.action.prompt}`;
  return {
    kind: "prompt",
    chatId: options.chatId,
    replyToMessageId: options.replyToMessageId,
    sourceMessageIds: [options.replyToMessageId],
    queueOrder: options.queueOrder,
    queueLane: "default",
    laneOrder: options.queueOrder,
    queuedAttachments: [],
    content: [{ type: "text", text: prompt }],
    historyText: options.action.prompt,
    statusSummary: truncateTelegramQueueSummary(
      options.action.text || options.action.prompt,
    ),
  };
}

export async function handleTelegramButtonCallbackQuery<TContext = unknown>(
  query: TelegramButtonCallbackQuery,
  ctx: TContext,
  deps: TelegramButtonCallbackHandlerDeps<TContext>,
): Promise<boolean> {
  const action = deps.resolveAction(query.data);
  if (!action) {
    if (query.data?.startsWith(`${TELEGRAM_BUTTON_CALLBACK_PREFIX}:`)) {
      await deps.answerCallbackQuery(query.id, "Button action expired.");
      return true;
    }
    return false;
  }
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (typeof chatId !== "number" || typeof messageId !== "number") {
    await deps.answerCallbackQuery(query.id, "Button action expired.");
    return true;
  }
  deps.enqueueButtonPrompt(query, action, ctx);
  await deps.answerCallbackQuery(query.id, "Queued.");
  return true;
}

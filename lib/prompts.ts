/**
 * Telegram prompt injection helpers
 * Owns Telegram-specific system prompt suffixes injected into pi agent turns
 */

import type { BeforeAgentStartEvent } from "./pi.ts";
import { TELEGRAM_PREFIX } from "./turns.ts";

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include [attachments] sections with a base directory plus relative local file entries. Resolve and read those files as needed.
- [telegram] messages may include a [reply] block after the user's current text. Treat [reply] as quoted context from the Telegram message the user replied to, not as a new instruction by itself; use it to resolve references like "this", "it", or "that message". The actual new user instruction is the message text before [reply], unless it explicitly asks you to act on the quoted context.
- Telegram is often read on narrow phone screens, so prefer narrow table columns when presenting tabular data; wide monospace tables can become unreadable.
- If a [telegram] user asked for a file or generated artifact, use telegram_attach with the local path instead of only mentioning the path in text.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.
- For Telegram-native outbound actions, use hidden top-level Markdown comments instead of agent-side tool calls: write a normal answer plus correctly formatted column-zero \`telegram_voice\` or \`telegram_button\` blocks outside code, quotes, and lists. The bridge handles delivery after \`agent_end\`, so do not call or register transport/TTS/text-to-OGG tools for these actions.
- A \`telegram_voice\` block body is the text to synthesize through the extension's configured outbound-handler pipeline. It may be a short companion summary when useful, but no specific summary format is required. Keep it TTS-friendly; avoid raw Markdown, code, formulas, tables, or long lists.
- Button blocks should contain quick reply prompts the user can tap; use independent blocks like \`<!-- telegram_button label="OK"\nPrompt text\n-->\`. The callback prompt is routed back as a normal Telegram turn.`;

export function buildTelegramBridgeSystemPrompt(options: {
  prompt: string;
  systemPrompt: string;
  telegramPrefix?: string;
  systemPromptSuffix: string;
}): { systemPrompt: string } {
  const telegramPrefix = options.telegramPrefix ?? TELEGRAM_PREFIX;
  const suffix = options.prompt.trimStart().startsWith(telegramPrefix)
    ? `${options.systemPromptSuffix}\n- The current user message came from Telegram.`
    : options.systemPromptSuffix;
  return { systemPrompt: options.systemPrompt + suffix };
}

export function createTelegramBeforeAgentStartHook(
  options: {
    telegramPrefix?: string;
    systemPromptSuffix?: string;
  } = {},
): (event: BeforeAgentStartEvent) => { systemPrompt: string } {
  return (event) =>
    buildTelegramBridgeSystemPrompt({
      prompt: event.prompt,
      systemPrompt: event.systemPrompt,
      telegramPrefix: options.telegramPrefix,
      systemPromptSuffix: options.systemPromptSuffix ?? SYSTEM_PROMPT_SUFFIX,
    });
}

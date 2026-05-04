/**
 * Regression tests for Telegram outbound handler helpers
 * Exercises assistant-authored voice/button markup extraction, artifact generation, callbacks, and Telegram upload wiring
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramButtonActionStore,
  createTelegramButtonPromptTurn,
  createTelegramOutboundReplyArtifactSender,
  createTelegramVoiceReplySender,
  generateTelegramVoiceReplyFile,
  handleTelegramButtonCallbackQuery,
  planTelegramButtonReply,
  planTelegramVoiceReply,
  stripTelegramCommentMarkupForPreview,
  stripTelegramVoiceMarkupForPreview,
} from "../lib/outbound-handlers.ts";

const testReplyMarkup = {
  inline_keyboard: [[{ text: "Continue", callback_data: "btn:1" }]],
};

test("Voice reply planner extracts multiline telegram_voice comments", () => {
  const plan = planTelegramVoiceReply(
    [
      "Technical answer.",
      "",
      "<!-- telegram_voice lang=ru rate=+20%",
      "Short speakable summary.",
      "-->",
    ].join("\n"),
  );
  assert.deepEqual(plan, {
    markdown: "Technical answer.",
    voiceText: "Short speakable summary.",
    voiceReplies: [
      { text: "Short speakable summary.", lang: "ru", rate: "+20%" },
    ],
    lang: "ru",
    rate: "+20%",
  });
});

test("Voice reply planner supports compact inline comments", () => {
  const plan = planTelegramVoiceReply(
    "Text before.\n\n<!-- telegram_voice: Inline summary. -->",
  );
  assert.deepEqual(plan, {
    markdown: "Text before.",
    voiceText: "Inline summary.",
    voiceReplies: [{ text: "Inline summary." }],
  });
});

test("Voice reply planner keeps multiple telegram_voice blocks as independent artifacts", () => {
  const plan = planTelegramVoiceReply(
    [
      "Technical answer.",
      "",
      "<!-- telegram_voice lang=ru rate=+20%",
      "First summary.",
      "-->",
      "",
      "<!-- telegram_voice lang=en rate=+10%",
      "Second summary.",
      "-->",
    ].join("\n"),
  );
  assert.deepEqual(plan, {
    markdown: "Technical answer.",
    voiceText: "First summary.\n\nSecond summary.",
    voiceReplies: [
      { text: "First summary.", lang: "ru", rate: "+20%" },
      { text: "Second summary.", lang: "en", rate: "+10%" },
    ],
    lang: "en",
    rate: "+10%",
  });
});

test("Voice reply planner strips non-voice comments from delivered markdown", () => {
  const plan = planTelegramVoiceReply(
    ["Visible text.", "", "<!-- internal note -->", "", "Visible tail."].join(
      "\n",
    ),
  );
  assert.deepEqual(plan, {
    markdown: "Visible text.\n\nVisible tail.",
  });
});

test("Voice preview stripping hides closed and currently open telegram_voice blocks", () => {
  assert.equal(
    stripTelegramVoiceMarkupForPreview(
      [
        "Visible text.",
        "",
        "<!-- telegram_voice lang=ru rate=+30%",
        "Hidden voice text streaming now",
      ].join("\n"),
    ),
    "Visible text.",
  );
  assert.equal(
    stripTelegramVoiceMarkupForPreview(
      [
        "Visible text.",
        "",
        "<!-- telegram_voice",
        "Hidden voice text.",
        "-->",
        "",
        "Visible tail.",
      ].join("\n"),
    ),
    "Visible text.\n\nVisible tail.",
  );
});

test("Comment preview stripping hides generic and partial comments", () => {
  assert.equal(
    stripTelegramCommentMarkupForPreview(
      "Visible text.\n\n<!-- hidden -->\n\nVisible tail.",
    ),
    "Visible text.\n\nVisible tail.",
  );
  assert.equal(
    stripTelegramCommentMarkupForPreview("Visible text.\n\n<"),
    "Visible text.",
  );
  assert.equal(
    stripTelegramCommentMarkupForPreview("Visible text.\n\n<!"),
    "Visible text.",
  );
  assert.equal(
    stripTelegramCommentMarkupForPreview("Visible text.\n\n<!-"),
    "Visible text.",
  );
  assert.equal(
    stripTelegramCommentMarkupForPreview(
      "Visible text.\n\n<!-- internal note streaming",
    ),
    "Visible text.",
  );
});

test("Outbound comments inside fenced code stay literal", () => {
  const markdown = [
    "Example:",
    "",
    "```md",
    "<!-- telegram_voice lang=ru",
    "Do not speak.",
    "-->",
    "",
    '<!-- telegram_button label="Run"',
    "Do not queue.",
    "-->",
    "```",
  ].join("\n");
  const actions: unknown[] = [];
  assert.deepEqual(planTelegramVoiceReply(markdown), { markdown });
  assert.deepEqual(
    planTelegramButtonReply(markdown, {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    }),
    { markdown },
  );
  assert.deepEqual(actions, []);
  assert.equal(stripTelegramCommentMarkupForPreview(markdown), markdown);
});

test("Outbound action comments require top-level column-zero markers", () => {
  const markdown = [
    "Visible answer.",
    "",
    "  <!-- telegram_voice lang=ru",
    "Indented voice.",
    "  -->",
    "",
    '> <!-- telegram_button label="OK"',
    "> Quoted prompt.",
    "> -->",
  ].join("\n");
  const actions: unknown[] = [];
  assert.deepEqual(planTelegramVoiceReply(markdown), { markdown });
  assert.deepEqual(
    planTelegramButtonReply(markdown, {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    }),
    { markdown },
  );
  assert.deepEqual(actions, []);
});

test("Button reply planner supports independent label blocks", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      "Visible answer.",
      "",
      '<!-- telegram_button label="OK"',
      "PROMPT",
      "-->",
      "",
      "<!-- telegram_button label='More'",
      "Continue with more detail",
      "-->",
    ].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );
  assert.equal(plan.markdown, "Visible answer.");
  assert.deepEqual(actions, [
    { text: "OK", prompt: "PROMPT" },
    { text: "More", prompt: "Continue with more detail" },
  ]);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [
      [{ text: "OK", callback_data: "btn:1" }],
      [{ text: "More", callback_data: "btn:2" }],
    ],
  });
});

test("Button action store resolves generated callback data", () => {
  const store = createTelegramButtonActionStore();
  const callbackData = store.register({ text: "Next", prompt: "Go next" });
  assert.match(callbackData, /^tgbtn:[a-f0-9-]+/);
  assert.deepEqual(store.resolve(callbackData), {
    text: "Next",
    prompt: "Go next",
  });
  assert.equal(store.resolve("other:1"), undefined);
});

test("Button callback handler enqueues prompt actions", async () => {
  const events: unknown[] = [];
  await assert.equal(
    await handleTelegramButtonCallbackQuery(
      {
        id: "callback-1",
        data: "btn:1",
        message: { message_id: 22, chat: { id: 7 } },
      },
      { id: "ctx" },
      {
        resolveAction: () => ({ text: "Continue", prompt: "Continue now" }),
        answerCallbackQuery: async (id, text) => {
          events.push({ answer: id, text });
        },
        enqueueButtonPrompt: (query, action, ctx) => {
          events.push({ query, action, ctx });
        },
      },
    ),
    true,
  );
  assert.deepEqual(events, [
    {
      query: {
        id: "callback-1",
        data: "btn:1",
        message: { message_id: 22, chat: { id: 7 } },
      },
      action: { text: "Continue", prompt: "Continue now" },
      ctx: { id: "ctx" },
    },
    { answer: "callback-1", text: "Queued." },
  ]);
});

test("Button callback handler consumes expired button callbacks", async () => {
  const events: unknown[] = [];
  assert.equal(
    await handleTelegramButtonCallbackQuery(
      { id: "callback-1", data: "tgbtn:missing" },
      {},
      {
        resolveAction: () => undefined,
        answerCallbackQuery: async (id, text) => {
          events.push({ id, text });
        },
        enqueueButtonPrompt: () => {
          events.push("unexpected:enqueue");
        },
      },
    ),
    true,
  );
  assert.deepEqual(events, [
    { id: "callback-1", text: "Button action expired." },
  ]);
});

test("Button prompt turns use Telegram prompt content", () => {
  assert.deepEqual(
    createTelegramButtonPromptTurn({
      chatId: 7,
      replyToMessageId: 22,
      queueOrder: 3,
      action: { text: "Continue", prompt: "Continue now" },
    }),
    {
      kind: "prompt",
      chatId: 7,
      replyToMessageId: 22,
      sourceMessageIds: [22],
      queueOrder: 3,
      queueLane: "default",
      laneOrder: 3,
      queuedAttachments: [],
      content: [{ type: "text", text: "[telegram] Continue now" }],
      historyText: "Continue now",
      statusSummary: "Continue",
    },
  );
  assert.deepEqual(testReplyMarkup, {
    inline_keyboard: [[{ text: "Continue", callback_data: "btn:1" }]],
  });
});

test("Voice reply generator invokes configured template and returns stdout path", async () => {
  const calls: unknown[] = [];
  const path = await generateTelegramVoiceReplyFile("hello world", {
    lang: "en",
    rate: "+10%",
    handler: {
      type: "voice",
      template: "/bin/voice {text} {lang=ru} {rate=+30%}",
      timeout: 1234,
    },
    execCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: "/tmp/a.ogg\n", stderr: "", code: 0, killed: false };
    },
  });
  assert.equal(path, "/tmp/a.ogg");
  assert.deepEqual(calls, [
    {
      command: "/bin/voice",
      args: ["hello world", "en", "+10%"],
      options: { cwd: process.cwd(), timeout: 1234 },
    },
  ]);
});

test("Voice reply generator uses inline placeholder defaults", async () => {
  const calls: unknown[] = [];
  const path = await generateTelegramVoiceReplyFile("hello", {
    handler: {
      type: "voice",
      template: "/bin/voice {text} {lang=ru} {rate=+30%}",
    },
    execCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: "/tmp/default.ogg\n",
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });
  assert.equal(path, "/tmp/default.ogg");
  assert.deepEqual(calls, [
    {
      command: "/bin/voice",
      args: ["hello", "ru", "+30%"],
      options: { cwd: process.cwd(), timeout: 120000 },
    },
  ]);
});

test("Voice reply generator skips voice when no outbound template is configured", async () => {
  const calls: unknown[] = [];
  const path = await generateTelegramVoiceReplyFile("hello", {
    execCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  });
  assert.equal(path, undefined);
  assert.deepEqual(calls, []);
});

test("Voice reply generator runs configured TTS to OGG pipe", async () => {
  const calls: Array<{ command: string; args: string[]; options: unknown }> =
    [];
  const path = await generateTelegramVoiceReplyFile("hello", {
    handler: {
      type: "voice",
      template: [
        "/tools/edge-say.mjs --text {text} --lang {lang} --rate {rate} --write-media {mp3}",
        "/usr/bin/ffmpeg -y -i {mp3} -c:a libopus -b:a 32k -ar 16000 -ac 1 -vbr on {ogg}",
      ],
      defaults: { lang: "ru", rate: "+30%" },
      output: "ogg",
      timeout: 1234,
    },
    execCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.command, "/tools/edge-say.mjs");
  assert.deepEqual(calls[0]?.args.slice(0, 6), [
    "--text",
    "hello",
    "--lang",
    "ru",
    "--rate",
    "+30%",
  ]);
  const mp3Path = calls[0]?.args.at(-1);
  assert.equal(calls[0]?.args.at(-2), "--write-media");
  assert.equal(calls[1]?.command, "/usr/bin/ffmpeg");
  assert.deepEqual(calls[1]?.args.slice(0, 11), [
    "-y",
    "-i",
    mp3Path,
    "-c:a",
    "libopus",
    "-b:a",
    "32k",
    "-ar",
    "16000",
    "-ac",
    "1",
  ]);
  assert.equal(calls[1]?.args.at(-3), "-vbr");
  assert.equal(calls[1]?.args.at(-2), "on");
  assert.equal(calls[1]?.args.at(-1), path);
  assert.ok(path);
  assert.match(path, /[0-9a-f-]+-voice\.ogg$/);
});

test("Voice reply generator pipes stdout to stdin and defaults composition output to stdout", async () => {
  const calls: Array<{
    command: string;
    args: string[];
    stdin?: string;
    timeout?: number;
  }> = [];
  const path = await generateTelegramVoiceReplyFile("hello", {
    handler: {
      type: "voice",
      template: [
        "/bin/prepare {text}",
        { template: "/bin/render", timeout: 222 },
      ],
      timeout: 111000,
    },
    execCommand: async (command, args, options) => {
      calls.push({
        command,
        args,
        stdin: options?.stdin,
        timeout: options?.timeout,
      });
      return {
        stdout:
          command === "/bin/prepare"
            ? "prepared text\n"
            : `/tmp/${options?.stdin?.trim()}.ogg\n`,
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });
  assert.equal(path, "/tmp/prepared text.ogg");
  assert.deepEqual(calls, [
    {
      command: "/bin/prepare",
      args: ["hello"],
      stdin: undefined,
      timeout: 111000,
    },
    {
      command: "/bin/render",
      args: [],
      stdin: "prepared text\n",
      timeout: 222,
    },
  ]);
});

test("Voice reply sender can suppress prompt reply metadata for secondary voice", async () => {
  const events: unknown[] = [];
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "/tmp/voice.ogg\n",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async (method, fields, fileField, filePath, fileName) => {
      events.push({ method, fields, fileField, filePath, fileName });
    },
    getHandlers: () => [{ type: "voice", template: "/bin/voice {text}" }],
  });
  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello", {
    replyToPrompt: false,
  });
  assert.deepEqual(events, [
    {
      method: "sendVoice",
      fields: { chat_id: "10" },
      fileField: "voice",
      filePath: "/tmp/voice.ogg",
      fileName: "voice.ogg",
    },
  ]);
});

test("Outbound artifact sender sends multiple voice replies independently", async () => {
  const events: unknown[] = [];
  const sendOutboundReplyArtifacts = createTelegramOutboundReplyArtifactSender({
    execCommand: async (_command, args) => ({
      stdout: `/tmp/${args[0]}.ogg\n`,
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async (method, fields, fileField, filePath, fileName) => {
      events.push({ method, fields, fileField, filePath, fileName });
    },
    getHandlers: () => [
      { type: "voice", template: "/bin/voice {text} {lang=ru}" },
    ],
  });
  await sendOutboundReplyArtifacts(
    { chatId: 10, replyToMessageId: 20 },
    {
      voiceReplies: [
        { text: "one", lang: "ru" },
        { text: "two", lang: "en" },
      ],
    },
    { replyToPrompt: true },
  );
  assert.deepEqual(events, [
    {
      method: "sendVoice",
      fields: {
        chat_id: "10",
        reply_parameters:
          '{"message_id":20,"allow_sending_without_reply":true}',
      },
      fileField: "voice",
      filePath: "/tmp/one.ogg",
      fileName: "one.ogg",
    },
    {
      method: "sendVoice",
      fields: { chat_id: "10" },
      fileField: "voice",
      filePath: "/tmp/two.ogg",
      fileName: "two.ogg",
    },
  ]);
});

test("Voice reply sender falls back to the next matching outbound handler", async () => {
  const events: unknown[] = [];
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async (command) => {
      if (command === "/bin/bad")
        return { stdout: "", stderr: "bad", code: 1, killed: false };
      return { stdout: "/tmp/good.ogg\n", stderr: "", code: 0, killed: false };
    },
    sendMultipart: async (method, fields, fileField, filePath, fileName) => {
      events.push({ method, fields, fileField, filePath, fileName });
    },
    getHandlers: () => [
      { type: "voice", template: "/bin/bad {text}" },
      { type: "voice", template: "/bin/good {text}" },
    ],
  });
  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello");
  assert.deepEqual(events, [
    {
      method: "sendVoice",
      fields: {
        chat_id: "10",
        reply_parameters:
          '{"message_id":20,"allow_sending_without_reply":true}',
      },
      fileField: "voice",
      filePath: "/tmp/good.ogg",
      fileName: "good.ogg",
    },
  ]);
});

test("Voice reply sender uploads generated ogg via sendVoice", async () => {
  const events: unknown[] = [];
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "/tmp/voice.ogg\n",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async (method, fields, fileField, filePath, fileName) => {
      events.push({ method, fields, fileField, filePath, fileName });
    },
    getHandlers: () => [{ type: "voice", template: "/bin/voice {text}" }],
  });
  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello");
  assert.deepEqual(events, [
    {
      method: "sendVoice",
      fields: {
        chat_id: "10",
        reply_parameters:
          '{"message_id":20,"allow_sending_without_reply":true}',
      },
      fileField: "voice",
      filePath: "/tmp/voice.ogg",
      fileName: "voice.ogg",
    },
  ]);
});

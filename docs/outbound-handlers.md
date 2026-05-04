# Outbound Handlers

`pi-telegram` maps hidden assistant-authored HTML comments to Telegram-native outbound actions.

This is intentionally prompt-driven: the agent writes normal Markdown plus small hidden top-level blocks, and the bridge performs the transport work after `agent_end`. `telegram_voice` and `telegram_button` are not pi tools. Outbound behavior is an emergent result of the assistant prompt, configured command-template handlers, generated artifacts, and reply delivery. That avoids extra agent-side tool calls, avoids fragile parameter plumbing inside the conversation, and minimizes latency because text, voice, and buttons are planned in one standard assistant reply.

This document is the local outbound adaptation of the portable [Command Template Standard](./command-templates.md).

## Standard

An outbound handler is selected by `type`. Assistant markup maps to handler types:

| Markup            | Handler type | Telegram action                                    |
| ----------------- | ------------ | -------------------------------------------------- |
| `telegram_voice`  | `voice`      | Generate OGG/Opus and call `sendVoice`             |
| `telegram_button` | Built-in     | Attach an inline keyboard button to the final text |

Configured command-template handlers provide `template`. A string is one command; an array is ordered composition. Top-level `args`, `defaults`, and `timeout` apply to all composed steps unless a step defines private values. `output` selects the primary artifact path when the handler produces a file instead of stdout text. Legacy configs may still use `pipe`, but `template: [...]` is the preferred standard shape.

## Voice Handler Config

`telegram.json` may define `outboundHandlers`:

```json
{
  "outboundHandlers": [
    {
      "type": "voice",
      "template": [
        "/path/to/tts --text {text} --lang {lang=ru} --rate {rate=+30%} --write-media {mp3}",
        "ffmpeg -y -i {mp3} -c:a libopus -b:a 32k -ar 16000 -ac 1 -vbr on {ogg}"
      ],
      "output": "ogg",
      "timeout": 120000
    }
  ]
}
```

If a matching voice handler fails, the bridge tries the next matching `type: "voice"` handler.

## Voice Markup

Assistant replies can include a hidden voice block:

```md
Full text answer stays here.

<!-- telegram_voice lang=ru rate=+30%
Text to synthesize as a Telegram voice message.
-->
```

The bridge strips the comment from Telegram text. On `agent_end`, it maps each `telegram_voice` block to `type: "voice"`, generates one file per block, and sends each file as an independent Telegram-native voice message. The opening `<!-- telegram_voice` marker must start at column zero on a top-level line outside fenced code, quotes, and lists; otherwise it is rendered as literal Markdown.

## Built-In Voice Placeholders

Voice outbound handlers receive these runtime placeholders:

| Placeholder | Value                                                    |
| ----------- | -------------------------------------------------------- |
| `{text}`    | Voice block body                                         |
| `{lang}`    | Optional markup override such as `lang=ru`               |
| `{rate}`    | Optional markup override such as `rate=+30%`             |
| `{mp3}`     | Flat temp artifact path under `~/.pi/agent/tmp/telegram` |
| `{ogg}`     | Flat temp artifact path under `~/.pi/agent/tmp/telegram` |

Temp artifacts use unique flat names such as `<uuid>-voice.mp3` and `<uuid>-voice.ogg`. The bridge does not create per-handler directory trees.

## Output

For composed handlers, `output` selects the primary artifact after the composition completes. Omitted `output` means `"stdout"`, so the final step should print the generated OGG/Opus path. `"output": "ogg"` means the generated file path comes from `{ogg}`. A value such as `"{ogg}"` is equivalent. Composition also follows the command-template standard where each step's stdout is provided as stdin to the next step by default.

For one-step `template` handlers, stdout remains the default result channel: the command should print the generated OGG/Opus path.

## Buttons Markup

Assistant replies can include independent button blocks. The block body is the prompt sent back to pi when the user taps the button:

```md
I can continue.

<!-- telegram_button label="OK"
Continue with the current plan.
-->

<!-- telegram_button label="Show risks"
List the main risks first.
-->
```

Rules:

- `telegram_button label="Label"` creates one independent button row whose prompt is the block body.
- The opening `<!-- telegram_button` marker must start at column zero on a top-level line outside fenced code, quotes, and lists; otherwise it is rendered as literal Markdown.
- Use one block per button; this mirrors HTML's singular element model and avoids a nested button DSL inside comments.
- Button actions are stored in memory with short `callback_data`; Telegram never sees the full prompt in the button payload.

Buttons are built in and do not need a command template because they are pure Telegram reply markup plus callback routing.

## Prompt Contract

The extension injects Telegram-specific system prompt guidance so agents know the fast path:

- Write the full technical answer as normal Markdown.
- Add `telegram_voice` when a Telegram-native voice message is useful; the block body is the text to synthesize and may be a companion summary, but no specific summary format is required.
- Add `telegram_button label="..."` for quick replies that should come back as normal Telegram prompts.
- Do not call or register TTS/text-to-OGG/Telegram transport tools for voice or buttons; the bridge owns the configured outbound-handler pipeline and delivery.

This keeps the agent focused on semantics and lets the bridge handle low-latency Telegram adaptation.

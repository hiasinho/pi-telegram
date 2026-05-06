# Callback Namespace Standard

Telegram `callback_data` is one bot-wide namespace. Any extension that creates inline buttons for a bot shared with `pi-telegram` must use namespaced callback data.

## Format

```text
<namespace>:<action>[:<payload>]
```

Examples:

```text
vividfish:approve:123
vividfish:deny:123
myext:page:2
```

## Rules

- Use a stable extension-owned namespace, preferably the package or extension name without scope punctuation.
- Keep the namespace lowercase ASCII: `a-z`, `0-9`, `_`, `-`.
- Do not use `pi-telegram` owned prefixes: `tgbtn:`, `menu:`, `model:`, `thinking:`, `status:`, `queue:`. Current app navigation uses `menu:`; `status:` remains reserved for legacy/owned status callbacks but is not emitted by current UI.
- Keep the full `callback_data` within Telegram's 64-byte limit.
- Put only opaque ids or small enum values in payloads; do not store secrets, full prompts, or large state.
- Treat callbacks as untrusted input. Validate namespace, action, and payload before executing side effects.

## pi-telegram fallback

If `pi-telegram` receives callback data that is not owned by its built-in prefixes and no built-in handler consumes it, it forwards the click to π as:

```text
[callback] <callback_data>
```

Layered extensions may intercept that message and handle their own namespace. If no extension handles it, the assistant may see the fallback message and should tell the user the callback was not handled and the environment may be misconfigured.

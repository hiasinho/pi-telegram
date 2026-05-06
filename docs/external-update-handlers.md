# External Update Handlers

`pi-telegram` owns a single `getUpdates` long-poll connection per bot. Other
pi extensions cannot open a competing poller against the same bot — the
Telegram Bot API uses a per-bot `offset` cursor, and two pollers race each
other and lose updates.

This document describes the registry that lets layered pi extensions
(running in the same pi process) hook into `pi-telegram`'s polling loop and
react to inbound Telegram updates **before** `pi-telegram`'s default routing
fires.

It is the runtime counterpart to
[Callback Namespaces](./callback-namespaces.md): callback namespaces define
how to share `callback_data` cleanly; external update handlers define how to
observe and optionally short-circuit the dispatch of those updates.

## When to use it

Use it when a layered extension needs to:

- Resolve out-of-band state (for example, a `tool_call` approval Promise)
  the moment a Telegram callback arrives, rather than waiting for the next
  agent turn.
- Suppress `pi-telegram`'s default routing for callbacks owned by the
  layered extension (so `pi-telegram` does not also forward them as
  `[callback] <data>` text).
- Observe arbitrary update types (messages, edits, channel posts, reactions)
  without owning the polling connection.

If the layered extension only needs to read assistant-visible callbacks, the
existing `[callback] <data>` fallback documented in
[Callback Namespaces](./callback-namespaces.md) is enough.

## Constraints

- One bot, one pi process, one `getUpdates` poller. This registry does **not**
  enable running multiple pi instances against the same bot.
- Interceptors run in the polling loop. They must return quickly; long
  awaits delay subsequent updates.
- Interceptor errors are caught and logged silently so polling never breaks.
  If you need durable error reporting, do it inside your interceptor.
- The registry lives on `globalThis`. Module instance identity is not
  required, so layered extensions can reach it without importing
  `@llblab/pi-telegram`.

## Verdicts

Each interceptor returns one of:

- `"consume"` — `pi-telegram` skips its default routing for this update.
- `"pass"` (or `void` / `undefined`) — `pi-telegram` routes the update
  normally. Other interceptors registered after this one still run for the
  same update.

The first interceptor that returns `"consume"` wins; later interceptors are
not called for that update.

## Registering an interceptor

Two equivalent paths.

### Typed import (recommended when you can depend on `@llblab/pi-telegram`)

```ts
import { onTelegramUpdate } from "@llblab/pi-telegram/lib/external-update-handlers.ts";

const off = onTelegramUpdate(async (update) => {
  const cb = (update as { callback_query?: { id?: string; data?: string } })
    .callback_query;
  if (!cb?.data?.startsWith("myext:")) return "pass";
  await resolveMyApproval(cb);
  return "consume";
});

// Later, when your extension shuts down:
off();
```

### Zero-coupling globalThis lookup

When the layered extension prefers no `import` from `@llblab/pi-telegram` (so
load order between the two extensions does not matter, and either can be
installed first):

```ts
interface PiTelegramExternalUpdateRegistry {
  readonly version: 1;
  add: (
    handler: (update: unknown) =>
      | "consume"
      | "pass"
      | void
      | Promise<"consume" | "pass" | void>,
  ) => () => void;
}

const REGISTRY_KEY = "__piTelegramExternalUpdateRegistry__";

function getOrCreateRegistry(): PiTelegramExternalUpdateRegistry {
  const g = globalThis as Record<string, unknown>;
  // Self-bootstrap so install order does not matter.
  // pi-telegram will reuse this exact object when it loads.
  // …implementation matches lib/external-update-handlers.ts…
}

const off = getOrCreateRegistry().add((update) => {
  /* … */
  return "pass";
});
```

The registry object on `globalThis.__piTelegramExternalUpdateRegistry__` is
versioned (`version: 1`) and stable across pi-telegram releases; future
breaking changes will use a new schema version and a new key.

## Interaction with built-in routing

`pi-telegram` invokes registered interceptors first, then routes the update
through its own handlers (commands, app menu, queue menu, model menu,
default prompt routing, callback namespace fallback). If any interceptor
returns `"consume"`, `pi-telegram` skips the rest of routing for that update.

This means:

- Extensions can claim callback namespaces that `pi-telegram` would
  otherwise forward as `[callback] <data>` text.
- Extensions can observe (but not consume) updates by always returning
  `"pass"`.
- Extensions must not consume updates that belong to `pi-telegram`'s own
  prefixes (`tgbtn:`, `menu:`, `model:`, `thinking:`, `status:`, `queue:`)
  unless they are deliberately replacing that behavior.

## Ownership semantics

The interceptor registry is ownership-agnostic and does not interact with
the `locks.json` singleton lock documented in [Locks](./locks.md). When the
locked polling runtime stops `pi-telegram`'s poller (for example, after
ownership is moved to another pi process), interceptors stop receiving
updates because no updates are being fetched. They are not unregistered.

If a layered extension needs to react to ownership changes, it should
observe `pi-telegram` lifecycle events through the standard pi extension
hooks rather than through the interceptor registry.

## Not a multiplexer

This registry does not multiplex one bot across multiple pi processes, and
it does not bypass Telegram's single-poller-per-bot constraint. To run
multiple pi instances on Telegram, give each instance its own bot and its
own `~/.pi/agent` directory; the registry is for layered extensions inside
**one** pi process.

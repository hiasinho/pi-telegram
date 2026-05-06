/**
 * External Telegram update interceptor registry
 * Zones: telegram transport, layered extension interop
 * Lets other pi extensions hook into the polling loop without owning their own getUpdates connection
 */

/**
 * Verdict returned by an interceptor.
 *
 * - `"consume"` — the interceptor handled this update; pi-telegram skips default routing.
 * - `"pass"` (or `void`/`undefined`) — pi-telegram routes the update normally.
 */
export type TelegramExternalUpdateVerdict = "consume" | "pass";

export type TelegramExternalUpdateInterceptor = (
  update: unknown,
) =>
  | TelegramExternalUpdateVerdict
  | void
  | Promise<TelegramExternalUpdateVerdict | void>;

export interface TelegramExternalUpdateRegistry {
  /** Schema version of this registry shape. */
  readonly version: 1;
  /**
   * Register an interceptor. Returns a disposer that removes it.
   *
   * Interceptors are invoked in registration order on every Telegram update,
   * before pi-telegram's own routing. The first interceptor that returns
   * `"consume"` wins and stops the chain for that update.
   */
  add: (handler: TelegramExternalUpdateInterceptor) => () => void;
  /**
   * Run all registered interceptors against an update.
   *
   * Used by pi-telegram's polling runtime; layered extensions should call
   * {@link onTelegramUpdate} or `add` instead of dispatching directly.
   */
  dispatch: (update: unknown) => Promise<TelegramExternalUpdateVerdict>;
}

const REGISTRY_KEY = "__piTelegramExternalUpdateRegistry__";

function getOrCreateRegistry(): TelegramExternalUpdateRegistry {
  const g = globalThis as Record<string, unknown>;
  const existing = g[REGISTRY_KEY] as
    | TelegramExternalUpdateRegistry
    | undefined;
  if (existing && existing.version === 1) return existing;
  const handlers = new Set<TelegramExternalUpdateInterceptor>();
  const registry: TelegramExternalUpdateRegistry = {
    version: 1,
    add(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async dispatch(update) {
      for (const handler of handlers) {
        try {
          const result = await handler(update);
          if (result === "consume") return "consume";
        } catch {
          // External handler errors must not break polling.
        }
      }
      return "pass";
    },
  };
  g[REGISTRY_KEY] = registry;
  return registry;
}

/**
 * Called by pi-telegram's own runtime to obtain the registry it dispatches
 * through. Layered extensions should not call this; use
 * {@link onTelegramUpdate} instead.
 */
export function getTelegramExternalUpdateRegistry(): TelegramExternalUpdateRegistry {
  return getOrCreateRegistry();
}

export interface TelegramExternalInterceptorWrapDeps<TUpdate, TContext> {
  defaultHandle: (update: TUpdate, ctx: TContext) => Promise<void>;
  registry?: TelegramExternalUpdateRegistry;
}

/**
 * Wrap a default polling `handleUpdate` with the external interceptor registry.
 *
 * Returned function dispatches `update` through registered interceptors first;
 * if any returns `"consume"`, default routing is skipped for that update.
 *
 * Composition-root callers (pi-telegram's `index.ts`) should use this builder
 * instead of writing the lifting logic inline.
 */
export function createTelegramInterceptedHandleUpdate<TUpdate, TContext>(
  deps: TelegramExternalInterceptorWrapDeps<TUpdate, TContext>,
): (update: TUpdate, ctx: TContext) => Promise<void> {
  const registry = deps.registry ?? getOrCreateRegistry();
  const { defaultHandle } = deps;
  return async function handleInterceptedUpdate(update, ctx) {
    const verdict = await registry.dispatch(update);
    if (verdict === "consume") return;
    await defaultHandle(update, ctx);
  };
}

/**
 * Register an interceptor that runs before pi-telegram routes a Telegram
 * update through its built-in handlers (commands, app menu, queue menu,
 * model menu, default prompt routing).
 *
 * This is the recommended public surface for layered extensions that share
 * the same bot and pi process with pi-telegram (single bot ↔ single
 * `getUpdates` poller).
 *
 * Returns a disposer that removes the interceptor.
 *
 * @example
 * ```ts
 * import { onTelegramUpdate } from "@llblab/pi-telegram/lib/external-update-handlers.ts";
 *
 * const off = onTelegramUpdate(async (update) => {
 *   const cb = (update as { callback_query?: { data?: string } }).callback_query;
 *   if (!cb?.data?.startsWith("myext:")) return "pass";
 *   await handleMyCallback(cb);
 *   return "consume"; // skip pi-telegram's default routing for this update
 * });
 *
 * // later, e.g. on session shutdown:
 * off();
 * ```
 *
 * Extensions that prefer zero coupling can also reach the registry directly
 * via `globalThis.__piTelegramExternalUpdateRegistry__` (versioned object,
 * see {@link TelegramExternalUpdateRegistry}). This avoids importing
 * `@llblab/pi-telegram` and tolerates either install order.
 */
export function onTelegramUpdate(
  handler: TelegramExternalUpdateInterceptor,
): () => void {
  return getOrCreateRegistry().add(handler);
}

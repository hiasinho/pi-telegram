/**
 * Regression tests for Telegram external update interceptor registry
 * Covers globalThis-shared registry semantics, dispatch order, consume short-circuit, and intercepted handleUpdate composition
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramExternalHandleUpdate,
  getTelegramExternalHandlerRegistry,
  onTelegramExternalUpdate,
  type TelegramExternalHandler,
  type TelegramExternalHandlerRegistry,
} from "../lib/external-handlers.ts";

const REGISTRY_KEY = "__piTelegramExternalHandlerRegistry__";

function clearGlobalRegistry(): void {
  delete (globalThis as Record<string, unknown>)[REGISTRY_KEY];
}

function getGlobalRegistry(): TelegramExternalHandlerRegistry | undefined {
  return (globalThis as Record<string, unknown>)[REGISTRY_KEY] as
    | TelegramExternalHandlerRegistry
    | undefined;
}

test("Registry is created lazily on first access and reused", () => {
  clearGlobalRegistry();
  assert.equal(getGlobalRegistry(), undefined);
  const first = getTelegramExternalHandlerRegistry();
  assert.equal(first.version, 1);
  const second = getTelegramExternalHandlerRegistry();
  assert.equal(first, second);
  assert.equal(getGlobalRegistry(), first);
  clearGlobalRegistry();
});

test("Registry is shared across import paths via globalThis", () => {
  clearGlobalRegistry();
  const fromHelper = getTelegramExternalHandlerRegistry();
  const fromGlobal = getGlobalRegistry();
  assert.equal(fromHelper, fromGlobal);
  clearGlobalRegistry();
});

test("Dispatch returns 'pass' when no interceptors are registered", async () => {
  clearGlobalRegistry();
  const registry = getTelegramExternalHandlerRegistry();
  const verdict = await registry.dispatch({ update_id: 1 });
  assert.equal(verdict, "pass");
  clearGlobalRegistry();
});

test("onTelegramExternalUpdate registers interceptors and disposer removes them", async () => {
  clearGlobalRegistry();
  const seen: unknown[] = [];
  const handler: TelegramExternalHandler = (update) => {
    seen.push(update);
    return "pass";
  };
  const off = onTelegramExternalUpdate(handler);
  await getTelegramExternalHandlerRegistry().dispatch({ update_id: 1 });
  assert.deepEqual(seen, [{ update_id: 1 }]);
  off();
  await getTelegramExternalHandlerRegistry().dispatch({ update_id: 2 });
  assert.deepEqual(seen, [{ update_id: 1 }]);
  clearGlobalRegistry();
});

test("Consume short-circuits later interceptors and bubbles up to dispatch", async () => {
  clearGlobalRegistry();
  const calls: string[] = [];
  const off1 = onTelegramExternalUpdate((update) => {
    calls.push("first");
    const cb = (update as { callback_query?: { data?: string } }).callback_query;
    if (cb?.data === "myext:ok") return "consume";
    return "pass";
  });
  const off2 = onTelegramExternalUpdate(() => {
    calls.push("second");
    return "pass";
  });
  const consumed = await getTelegramExternalHandlerRegistry().dispatch({
    callback_query: { data: "myext:ok" },
  });
  assert.equal(consumed, "consume");
  assert.deepEqual(calls, ["first"]);

  calls.length = 0;
  const passed = await getTelegramExternalHandlerRegistry().dispatch({
    callback_query: { data: "other" },
  });
  assert.equal(passed, "pass");
  assert.deepEqual(calls, ["first", "second"]);
  off1();
  off2();
  clearGlobalRegistry();
});

test("Interceptor errors do not break polling and do not consume the update", async () => {
  clearGlobalRegistry();
  const calls: string[] = [];
  const offThrow = onTelegramExternalUpdate(() => {
    calls.push("thrower");
    throw new Error("boom");
  });
  const offAfter = onTelegramExternalUpdate(() => {
    calls.push("after");
    return "pass";
  });
  const verdict = await getTelegramExternalHandlerRegistry().dispatch({
    update_id: 1,
  });
  assert.equal(verdict, "pass");
  assert.deepEqual(calls, ["thrower", "after"]);
  offThrow();
  offAfter();
  clearGlobalRegistry();
});

test("Void/undefined return values are treated as 'pass'", async () => {
  clearGlobalRegistry();
  const off = onTelegramExternalUpdate(() => undefined);
  const verdict = await getTelegramExternalHandlerRegistry().dispatch({
    update_id: 1,
  });
  assert.equal(verdict, "pass");
  off();
  clearGlobalRegistry();
});

test("createTelegramExternalHandleUpdate skips defaultHandle on consume", async () => {
  clearGlobalRegistry();
  const defaultCalls: number[] = [];
  const defaultHandle = async (update: { update_id: number }) => {
    defaultCalls.push(update.update_id);
  };
  const off = onTelegramExternalUpdate((update) => {
    const id = (update as { update_id?: number }).update_id;
    return id === 99 ? "consume" : "pass";
  });
  const handler = createTelegramExternalHandleUpdate({ defaultHandle });
  await handler({ update_id: 1 }, undefined);
  await handler({ update_id: 99 }, undefined);
  await handler({ update_id: 2 }, undefined);
  assert.deepEqual(defaultCalls, [1, 2]);
  off();
  clearGlobalRegistry();
});

test("createTelegramExternalHandleUpdate calls defaultHandle when no interceptors registered", async () => {
  clearGlobalRegistry();
  const defaultCalls: unknown[] = [];
  const defaultHandle = async (
    update: { update_id: number },
    ctx: string,
  ) => {
    defaultCalls.push({ update, ctx });
  };
  const handler = createTelegramExternalHandleUpdate({ defaultHandle });
  await handler({ update_id: 7 }, "ctx");
  assert.deepEqual(defaultCalls, [{ update: { update_id: 7 }, ctx: "ctx" }]);
  clearGlobalRegistry();
});

test("Pre-existing docs-style registry missing 'dispatch' is replaced with a valid one", async () => {
  // Simulate a layered extension that loaded first and installed an early
  // draft of the zero-coupling registry shape (only `version` and `add`).
  // pi-telegram must not reuse it as-is, because its polling runtime calls
  // `dispatch` on whatever it finds and would crash on the first update.
  clearGlobalRegistry();
  const docsHandlers = new Set<TelegramExternalHandler>();
  const docsStyle = {
    version: 1,
    add(handler: TelegramExternalHandler) {
      docsHandlers.add(handler);
      return () => docsHandlers.delete(handler);
    },
    // dispatch deliberately missing
  };
  (globalThis as Record<string, unknown>)[REGISTRY_KEY] = docsStyle;

  const registry = getTelegramExternalHandlerRegistry();
  assert.notEqual(registry, docsStyle as unknown);
  assert.equal(registry.version, 1);
  assert.equal(typeof registry.add, "function");
  assert.equal(typeof registry.dispatch, "function");
  // Polling loop must succeed against the replacement registry.
  const verdict = await registry.dispatch({ update_id: 1 });
  assert.equal(verdict, "pass");
  // Replacement is now the canonical registry on globalThis.
  assert.equal(getGlobalRegistry(), registry);
  clearGlobalRegistry();
});

test("Pre-existing malformed registry (wrong types) is replaced", async () => {
  clearGlobalRegistry();
  const malformed = {
    version: 1,
    add: "not a function",
    dispatch: 42,
  };
  (globalThis as Record<string, unknown>)[REGISTRY_KEY] = malformed;

  const registry = getTelegramExternalHandlerRegistry();
  assert.notEqual(registry, malformed as unknown);
  assert.equal(typeof registry.add, "function");
  assert.equal(typeof registry.dispatch, "function");
  const verdict = await registry.dispatch({ update_id: 1 });
  assert.equal(verdict, "pass");
  clearGlobalRegistry();
});

test("Pre-existing registry with future version is replaced (v1 runtime, v2 squatter)", () => {
  clearGlobalRegistry();
  const futureShape = {
    version: 2,
    add: () => () => {},
    dispatch: async () => "pass" as const,
  };
  (globalThis as Record<string, unknown>)[REGISTRY_KEY] = futureShape;

  const registry = getTelegramExternalHandlerRegistry();
  assert.notEqual(registry, futureShape as unknown);
  assert.equal(registry.version, 1);
  clearGlobalRegistry();
});

test("Pre-existing fully-formed v1 registry from a layered extension is reused", async () => {
  // Documented happy path: a layered extension implements the full v1
  // contract (including `dispatch`) before pi-telegram loads. Both sides
  // must converge on the same object so handlers registered through either
  // path see the same updates.
  clearGlobalRegistry();
  const handlers = new Set<TelegramExternalHandler>();
  const layered: TelegramExternalHandlerRegistry = {
    version: 1,
    add(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async dispatch(update) {
      for (const handler of handlers) {
        const r = await handler(update);
        if (r === "consume") return "consume";
      }
      return "pass";
    },
  };
  (globalThis as Record<string, unknown>)[REGISTRY_KEY] = layered;

  const registry = getTelegramExternalHandlerRegistry();
  assert.equal(registry, layered);

  const seen: unknown[] = [];
  const off = onTelegramExternalUpdate((update) => {
    seen.push(update);
    return "pass";
  });
  await registry.dispatch({ update_id: 1 });
  assert.deepEqual(seen, [{ update_id: 1 }]);
  off();
  clearGlobalRegistry();
});

test("Pre-existing non-object value at registry key is replaced", () => {
  clearGlobalRegistry();
  (globalThis as Record<string, unknown>)[REGISTRY_KEY] = "not an object";
  const registry = getTelegramExternalHandlerRegistry();
  assert.equal(registry.version, 1);
  assert.equal(typeof registry.dispatch, "function");
  clearGlobalRegistry();
});

test("createTelegramExternalHandleUpdate accepts an explicit registry override", async () => {
  clearGlobalRegistry();
  const seen: unknown[] = [];
  const customRegistry: TelegramExternalHandlerRegistry = {
    version: 1,
    add: () => () => {},
    async dispatch(update) {
      seen.push(update);
      return "consume";
    },
  };
  const defaultCalls: unknown[] = [];
  const handler = createTelegramExternalHandleUpdate({
    defaultHandle: async (update) => {
      defaultCalls.push(update);
    },
    registry: customRegistry,
  });
  await handler({ update_id: 1 }, undefined);
  assert.deepEqual(seen, [{ update_id: 1 }]);
  assert.deepEqual(defaultCalls, []);
  // Global registry should remain untouched.
  assert.equal(getGlobalRegistry(), undefined);
  clearGlobalRegistry();
});

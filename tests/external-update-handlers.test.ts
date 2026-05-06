/**
 * Regression tests for Telegram external update interceptor registry
 * Covers globalThis-shared registry semantics, dispatch order, consume short-circuit, and intercepted handleUpdate composition
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramInterceptedHandleUpdate,
  getTelegramExternalUpdateRegistry,
  onTelegramUpdate,
  type TelegramExternalUpdateInterceptor,
  type TelegramExternalUpdateRegistry,
} from "../lib/external-update-handlers.ts";

const REGISTRY_KEY = "__piTelegramExternalUpdateRegistry__";

function clearGlobalRegistry(): void {
  delete (globalThis as Record<string, unknown>)[REGISTRY_KEY];
}

function getGlobalRegistry(): TelegramExternalUpdateRegistry | undefined {
  return (globalThis as Record<string, unknown>)[REGISTRY_KEY] as
    | TelegramExternalUpdateRegistry
    | undefined;
}

test("Registry is created lazily on first access and reused", () => {
  clearGlobalRegistry();
  assert.equal(getGlobalRegistry(), undefined);
  const first = getTelegramExternalUpdateRegistry();
  assert.equal(first.version, 1);
  const second = getTelegramExternalUpdateRegistry();
  assert.equal(first, second);
  assert.equal(getGlobalRegistry(), first);
  clearGlobalRegistry();
});

test("Registry is shared across import paths via globalThis", () => {
  clearGlobalRegistry();
  const fromHelper = getTelegramExternalUpdateRegistry();
  const fromGlobal = getGlobalRegistry();
  assert.equal(fromHelper, fromGlobal);
  clearGlobalRegistry();
});

test("Dispatch returns 'pass' when no interceptors are registered", async () => {
  clearGlobalRegistry();
  const registry = getTelegramExternalUpdateRegistry();
  const verdict = await registry.dispatch({ update_id: 1 });
  assert.equal(verdict, "pass");
  clearGlobalRegistry();
});

test("onTelegramUpdate registers interceptors and disposer removes them", async () => {
  clearGlobalRegistry();
  const seen: unknown[] = [];
  const handler: TelegramExternalUpdateInterceptor = (update) => {
    seen.push(update);
    return "pass";
  };
  const off = onTelegramUpdate(handler);
  await getTelegramExternalUpdateRegistry().dispatch({ update_id: 1 });
  assert.deepEqual(seen, [{ update_id: 1 }]);
  off();
  await getTelegramExternalUpdateRegistry().dispatch({ update_id: 2 });
  assert.deepEqual(seen, [{ update_id: 1 }]);
  clearGlobalRegistry();
});

test("Consume short-circuits later interceptors and bubbles up to dispatch", async () => {
  clearGlobalRegistry();
  const calls: string[] = [];
  const off1 = onTelegramUpdate((update) => {
    calls.push("first");
    const cb = (update as { callback_query?: { data?: string } }).callback_query;
    if (cb?.data === "myext:ok") return "consume";
    return "pass";
  });
  const off2 = onTelegramUpdate(() => {
    calls.push("second");
    return "pass";
  });
  const consumed = await getTelegramExternalUpdateRegistry().dispatch({
    callback_query: { data: "myext:ok" },
  });
  assert.equal(consumed, "consume");
  assert.deepEqual(calls, ["first"]);

  calls.length = 0;
  const passed = await getTelegramExternalUpdateRegistry().dispatch({
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
  const offThrow = onTelegramUpdate(() => {
    calls.push("thrower");
    throw new Error("boom");
  });
  const offAfter = onTelegramUpdate(() => {
    calls.push("after");
    return "pass";
  });
  const verdict = await getTelegramExternalUpdateRegistry().dispatch({
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
  const off = onTelegramUpdate(() => undefined);
  const verdict = await getTelegramExternalUpdateRegistry().dispatch({
    update_id: 1,
  });
  assert.equal(verdict, "pass");
  off();
  clearGlobalRegistry();
});

test("createTelegramInterceptedHandleUpdate skips defaultHandle on consume", async () => {
  clearGlobalRegistry();
  const defaultCalls: number[] = [];
  const defaultHandle = async (update: { update_id: number }) => {
    defaultCalls.push(update.update_id);
  };
  const off = onTelegramUpdate((update) => {
    const id = (update as { update_id?: number }).update_id;
    return id === 99 ? "consume" : "pass";
  });
  const handler = createTelegramInterceptedHandleUpdate({ defaultHandle });
  await handler({ update_id: 1 }, undefined);
  await handler({ update_id: 99 }, undefined);
  await handler({ update_id: 2 }, undefined);
  assert.deepEqual(defaultCalls, [1, 2]);
  off();
  clearGlobalRegistry();
});

test("createTelegramInterceptedHandleUpdate calls defaultHandle when no interceptors registered", async () => {
  clearGlobalRegistry();
  const defaultCalls: unknown[] = [];
  const defaultHandle = async (
    update: { update_id: number },
    ctx: string,
  ) => {
    defaultCalls.push({ update, ctx });
  };
  const handler = createTelegramInterceptedHandleUpdate({ defaultHandle });
  await handler({ update_id: 7 }, "ctx");
  assert.deepEqual(defaultCalls, [{ update: { update_id: 7 }, ctx: "ctx" }]);
  clearGlobalRegistry();
});

test("createTelegramInterceptedHandleUpdate accepts an explicit registry override", async () => {
  clearGlobalRegistry();
  const seen: unknown[] = [];
  const customRegistry: TelegramExternalUpdateRegistry = {
    version: 1,
    add: () => () => {},
    async dispatch(update) {
      seen.push(update);
      return "consume";
    },
  };
  const defaultCalls: unknown[] = [];
  const handler = createTelegramInterceptedHandleUpdate({
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

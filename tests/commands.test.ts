import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTelegramCommandDispatcher, type TelegramCommandContext, type TelegramCommandDependencies, type TelegramCommandMessage, type TmuxCommandResult } from "../commands.ts";

const modelA = { provider: "openai", id: "gpt-5", contextWindow: 100000 } as any;
const modelB = { provider: "anthropic", id: "claude-sonnet-4", contextWindow: 200000 } as any;
const modelC = { provider: "other", id: "gpt-5", contextWindow: 50000 } as any;

function message(text: string): TelegramCommandMessage {
	return { message_id: 7, chat: { id: 42 }, from: { id: 99 }, text };
}

function context(overrides: Partial<TelegramCommandContext> = {}): TelegramCommandContext {
	return {
		model: modelA,
		sessionManager: {
			getEntries: () => [],
			scopedModels: [{ model: modelA }, { model: modelB }],
		},
		modelRegistry: { isUsingOAuth: () => false, getAvailable: () => [modelA, modelB, modelC] },
		getContextUsage: () => undefined,
		isIdle: () => true,
		compact: () => undefined,
		...overrides,
	};
}

function harness(overrides: Partial<TelegramCommandDependencies> = {}) {
	const replies: string[] = [];
	const replyOptions: any[] = [];
	const tmuxCommands: string[] = [];
	const queuedTurns: any[] = [];
	const setModels: any[] = [];
	let thinking: any = "medium";
	let preserveQueuedTurnsAsHistory = false;
	let allowedUserId: number | undefined;
	let prepared = 0;
	let rolledBack = 0;
	let tmuxResult: TmuxCommandResult = { ok: true };
	let boomerangAvailable = true;
	let abort: (() => void) | undefined;
	let aborted = false;

	const deps: TelegramCommandDependencies = {
		sendTextReply: async (_chatId, _replyToMessageId, text, options) => {
			replies.push(text);
			replyOptions.push(options);
		},
		sendTmuxCommand: async (command) => {
			tmuxCommands.push(command);
			return tmuxResult;
		},
		hasBoomerangCommands: () => boomerangAvailable,
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level) => {
			thinking = level;
		},
		setModel: async (model) => {
			setModels.push(model);
			return true;
		},
		updateStatus: () => undefined,
		currentAbort: () => abort,
		hasQueuedTurns: () => queuedTurns.length > 0,
		setPreserveQueuedTurnsAsHistory: (value) => {
			preserveQueuedTurnsAsHistory = value;
		},
		clearQueuedTurns: () => {
			queuedTurns.length = 0;
		},
		queueTurn: (turn) => {
			queuedTurns.push(turn);
		},
		removeQueuedTurn: (turn) => {
			const index = queuedTurns.indexOf(turn);
			if (index >= 0) queuedTurns.splice(index, 1);
		},
		startTypingLoop: () => undefined,
		stopTypingLoop: () => undefined,
		prepareSessionChange: async () => {
			prepared += 1;
		},
		rollbackSessionChange: async () => {
			rolledBack += 1;
		},
		getAllowedUserId: () => allowedUserId,
		setAllowedUserId: async (userId) => {
			allowedUserId = userId;
		},
		...overrides,
	};

	return {
		replies,
		replyOptions,
		tmuxCommands,
		queuedTurns,
		setModels,
		get thinking() { return thinking; },
		set thinking(value) { thinking = value; },
		get preserveQueuedTurnsAsHistory() { return preserveQueuedTurnsAsHistory; },
		get prepared() { return prepared; },
		get rolledBack() { return rolledBack; },
		set tmuxResult(value: TmuxCommandResult) { tmuxResult = value; },
		set boomerangAvailable(value: boolean) { boomerangAvailable = value; },
		set abort(value: (() => void) | undefined) { abort = value; },
		get aborted() { return aborted; },
		markAbort() { abort = () => { aborted = true; }; },
		dispatch: createTelegramCommandDispatcher(deps),
	};
}

test("non-command messages fall through", async () => {
	const h = harness();
	assert.equal(await h.dispatch(message("hello"), "hello", context()), false);
	assert.deepEqual(h.replies, []);
});

test("/think shows inline choices and sets thinking level", async () => {
	const h = harness();
	assert.equal(await h.dispatch(message("/think"), "/think", context()), true);
	assert.match(h.replies.at(-1) ?? "", /Current thinking level: medium/);
	assert.deepEqual(h.replyOptions.at(-1)?.replyMarkup.inline_keyboard[1][1], { text: "high", callback_data: "pi-tg:think:high" });

	assert.equal(await h.dispatch(message("/think high"), "/think high", context()), true);
	assert.equal(h.thinking, "high");
	assert.match(h.replies.at(-1) ?? "", /Thinking level: medium -> high\./);
});

test("/think rejects unknown levels", async () => {
	const h = harness();
	assert.equal(await h.dispatch(message("/think huge"), "/think huge", context()), true);
	assert.match(h.replies[0], /Unknown thinking level: huge/);
});

test("/model lists scoped models with inline choices and switches", async () => {
	const h = harness();
	assert.equal(await h.dispatch(message("/model"), "/model", context()), true);
	assert.match(h.replies[0], /Scoped models:/);
	assert.match(h.replies[0], /openai\/gpt-5/);
	assert.deepEqual(h.replyOptions[0]?.replyMarkup.inline_keyboard[0], [
		{ text: "Prev", callback_data: "pi-tg:model:prev" },
		{ text: "Next", callback_data: "pi-tg:model:next" },
	]);
	assert.deepEqual(h.replyOptions[0]?.replyMarkup.inline_keyboard[1][0], { text: "* 1. gpt-5", callback_data: "pi-tg:model:1" });

	assert.equal(await h.dispatch(message("/model next"), "/model next", context()), true);
	assert.deepEqual(h.setModels, [modelB]);
	assert.match(h.replies.at(-1) ?? "", /Model: openai\/gpt-5 -> anthropic\/claude-sonnet-4/);
});

test("/model switches by numeric choice", async () => {
	const h = harness();
	assert.equal(await h.dispatch(message("/model 2"), "/model 2", context()), true);
	assert.deepEqual(h.setModels, [modelB]);
});

test("/model falls back to persisted enabledModels", async () => {
	const home = join(process.cwd(), ".test-home-enabled-models");
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	try {
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await writeFile(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ enabledModels: ["anthropic/claude-sonnet-4", "openai/gpt-5"] }), "utf8");
		const h = harness();
		const ctx = context({ sessionManager: { getEntries: () => [] } });
		assert.equal(await h.dispatch(message("/model"), "/model", ctx), true);
		assert.match(h.replies[0], /anthropic\/claude-sonnet-4/);
		assert.match(h.replies[0], /openai\/gpt-5/);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	}
});

test("/model rejects ambiguous bare ids", async () => {
	const h = harness();
	const ctx = context({ sessionManager: { getEntries: () => [], scopedModels: [{ model: modelA }, { model: modelC }] } });
	assert.equal(await h.dispatch(message("/model gpt-5"), "/model gpt-5", ctx), true);
	assert.match(h.replies[0], /Ambiguous model id: gpt-5/);
	assert.deepEqual(h.setModels, []);
});

test("/model rejects switching while busy", async () => {
	const h = harness();
	assert.equal(await h.dispatch(message("/model next"), "/model next", context({ isIdle: () => false })), true);
	assert.match(h.replies[0], /Cannot switch model while pi is busy/);
	assert.deepEqual(h.setModels, []);
});

test("/boom queues a boomerang turn and injects tmux command", async () => {
	const h = harness();
	assert.equal(await h.dispatch(message("/boom Say hi"), "/boom say hi", context()), true);
	assert.deepEqual(h.tmuxCommands, ["/boomerang Say hi"]);
	assert.equal(h.queuedTurns.length, 1);
	assert.equal(h.queuedTurns[0].kind, "boomerang");
});

test("/boom removes queued turn on tmux failure", async () => {
	const h = harness();
	h.tmuxResult = { ok: false, message: "pi is not running inside tmux", missingTmux: true };
	assert.equal(await h.dispatch(message("/boom Say hi"), "/boom say hi", context()), true);
	assert.equal(h.queuedTurns.length, 0);
	assert.match(h.replies[0], /Cannot start boomerang: pi is not running inside tmux/);
});

test("/boom is hidden when boomerang commands are unavailable", async () => {
	const h = harness();
	h.boomerangAvailable = false;
	assert.equal(await h.dispatch(message("/boom Say hi"), "/boom say hi", context()), true);
	assert.match(h.replies[0], /Boomerang is not available/);
	assert.deepEqual(h.tmuxCommands, []);
});

test("/new prepares reconnect marker and injects session command", async () => {
	const h = harness();
	assert.equal(await h.dispatch(message("/new"), "/new", context()), true);
	assert.equal(h.prepared, 1);
	assert.deepEqual(h.tmuxCommands, ["/new"]);
	assert.match(h.replies[0], /Starting a new pi session/);
});

test("/reload rolls back reconnect marker on tmux failure", async () => {
	const h = harness();
	h.tmuxResult = { ok: false, message: "bad pane", missingTmux: false };
	assert.equal(await h.dispatch(message("/reload"), "/reload", context()), true);
	assert.equal(h.prepared, 1);
	assert.equal(h.rolledBack, 1);
	assert.match(h.replies[0], /Failed to reload pi: bad pane/);
});

test("/status reports model, thinking, tokens, cost, and context", async () => {
	const h = harness();
	const ctx = context({
		sessionManager: {
			getEntries: () => [
				{ type: "message", message: { role: "assistant", usage: { input: 1500, output: 2500, cacheRead: 100, cacheWrite: 50, cost: { total: 0.1234 } } } },
			],
			scopedModels: [{ model: modelA }],
		},
		getContextUsage: () => ({ percent: 12.34, contextWindow: 100000 }),
	});
	assert.equal(await h.dispatch(message("/status"), "/status", ctx), true);
	assert.match(h.replies[0], /Model: openai\/gpt-5/);
	assert.match(h.replies[0], /Thinking: medium/);
	assert.match(h.replies[0], /Usage: ↑1.5k ↓2.5k R100 W50/);
	assert.match(h.replies[0], /Cost: \$0\.123/);
	assert.match(h.replies[0], /Context: 12\.3%\/100k/);
});

test("stop aborts active turn and preserves queued history", async () => {
	const h = harness();
	h.markAbort();
	h.queuedTurns.push({});
	assert.equal(await h.dispatch(message("stop"), "stop", context()), true);
	assert.equal(h.aborted, true);
	assert.equal(h.preserveQueuedTurnsAsHistory, true);
	assert.match(h.replies[0], /Aborted current turn/);
});

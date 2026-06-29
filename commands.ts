import type { Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export interface TelegramCommandUser {
	id: number;
}

export interface TelegramCommandMessage {
	message_id: number;
	chat: { id: number };
	from?: TelegramCommandUser;
	text?: string;
	caption?: string;
}

export interface TelegramCommandContext {
	model?: Model<any>;
	sessionManager: {
		getEntries(): Iterable<any>;
		scopedModels?: ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	};
	modelRegistry: {
		isUsingOAuth(model: Model<any>): boolean;
	};
	getContextUsage(): { contextWindow?: number; percent: number | null } | undefined;
	isIdle(): boolean;
	compact(options: { onComplete(): void; onError(error: unknown): void }): void;
}

export type TmuxCommandResult = { ok: true } | { ok: false; message: string; missingTmux: boolean };

export interface TelegramCommandTurn {
	chatId: number;
	replyToMessageId: number;
	queuedAttachments: unknown[];
	content: Array<{ type: "text"; text: string }>;
	historyText: string;
	kind?: "boomerang";
	boomerangHandoffSeen?: boolean;
}

export interface TelegramCommandDependencies {
	sendTextReply(chatId: number, replyToMessageId: number, text: string): Promise<void>;
	sendTmuxCommand(command: string): Promise<TmuxCommandResult>;
	hasBoomerangCommands(): boolean;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): void;
	setModel(model: Model<any>): Promise<boolean>;
	updateStatus(ctx: TelegramCommandContext): void;
	currentAbort(): (() => void) | undefined;
	hasQueuedTurns(): boolean;
	setPreserveQueuedTurnsAsHistory(value: boolean): void;
	clearQueuedTurns(): void;
	queueTurn(turn: TelegramCommandTurn): void;
	removeQueuedTurn(turn: TelegramCommandTurn): void;
	startTypingLoop(ctx: TelegramCommandContext, chatId: number): void;
	stopTypingLoop(): void;
	prepareSessionChange(): Promise<void>;
	rollbackSessionChange(): Promise<void>;
	getAllowedUserId(): number | undefined;
	setAllowedUserId(userId: number): Promise<void>;
}

const TELEGRAM_THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function parseThinkingLevel(value: string): ThinkingLevel | undefined {
	const normalized = value.trim().toLowerCase();
	if (TELEGRAM_THINKING_LEVELS.has(normalized as ThinkingLevel)) return normalized as ThinkingLevel;
	return undefined;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatModel(model: Model<any> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "unknown";
}

export function getScopedModelList(ctx: TelegramCommandContext): Model<any>[] {
	const scopedModels = ctx.sessionManager.scopedModels;
	return Array.isArray(scopedModels) ? scopedModels.map((scoped) => scoped.model).filter(Boolean) : [];
}

export function findCurrentModelIndex(models: Model<any>[], currentModel: Model<any> | undefined): number {
	if (!currentModel) return -1;
	return models.findIndex((model) => model.provider === currentModel.provider && model.id === currentModel.id);
}

export function findScopedModel(models: Model<any>[], query: string): { model?: Model<any>; error?: string } {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return { error: "Usage: /model <provider/model-id|model-id|next|prev>" };
	const exactFull = models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === normalized);
	if (exactFull) return { model: exactFull };
	const exactIds = models.filter((model) => model.id.toLowerCase() === normalized);
	if (exactIds.length === 1) return { model: exactIds[0] };
	if (exactIds.length > 1) return { error: `Ambiguous model id: ${query}\nUse provider/model-id:\n${exactIds.map((model) => `- ${formatModel(model)}`).join("\n")}` };
	return { error: `Model is not in the scoped model list: ${query}` };
}

function createRawTelegramCommandTurn(message: TelegramCommandMessage, command: string, kind?: TelegramCommandTurn["kind"]): TelegramCommandTurn {
	return {
		chatId: message.chat.id,
		replyToMessageId: message.message_id,
		queuedAttachments: [],
		content: [{ type: "text", text: command }],
		historyText: command,
		kind,
	};
}

export function createTelegramCommandDispatcher(deps: TelegramCommandDependencies) {
	async function handleStopCommand(message: TelegramCommandMessage, ctx: TelegramCommandContext): Promise<boolean> {
		const abort = deps.currentAbort();
		if (abort) {
			if (deps.hasQueuedTurns()) deps.setPreserveQueuedTurnsAsHistory(true);
			abort();
			deps.updateStatus(ctx);
			await deps.sendTextReply(message.chat.id, message.message_id, "Aborted current turn.");
		} else {
			await deps.sendTextReply(message.chat.id, message.message_id, "No active turn.");
		}
		return true;
	}

	async function handleCompactCommand(message: TelegramCommandMessage, ctx: TelegramCommandContext): Promise<boolean> {
		if (!ctx.isIdle()) {
			await deps.sendTextReply(message.chat.id, message.message_id, "Cannot compact while pi is busy. Send \"stop\" first.");
			return true;
		}
		ctx.compact({
			onComplete: () => void deps.sendTextReply(message.chat.id, message.message_id, "Compaction completed."),
			onError: (error) => {
				const errorMessage = error instanceof Error ? error.message : String(error);
				void deps.sendTextReply(message.chat.id, message.message_id, `Compaction failed: ${errorMessage}`);
			},
		});
		await deps.sendTextReply(message.chat.id, message.message_id, "Compaction started.");
		return true;
	}

	async function handleBoomCommand(message: TelegramCommandMessage, ctx: TelegramCommandContext): Promise<boolean> {
		if (!deps.hasBoomerangCommands()) {
			await deps.sendTextReply(message.chat.id, message.message_id, "Boomerang is not available in this Pi session. Install/load the pi-boomerang extension first.");
			return true;
		}
		const rawCommand = message.text?.trim() ?? "/boom";
		const task = rawCommand.replace(/^\/(?:boom|boomerang)\b/i, "").trim();
		if (!task) {
			await deps.sendTextReply(message.chat.id, message.message_id, "Usage: /boom <task>");
			return true;
		}
		if (!ctx.isIdle()) {
			await deps.sendTextReply(message.chat.id, message.message_id, "Cannot start boomerang while pi is busy. Send \"stop\" first.");
			return true;
		}

		const command = `/boomerang ${task}`;
		const turn = createRawTelegramCommandTurn(message, command, "boomerang");
		deps.queueTurn(turn);
		deps.startTypingLoop(ctx, turn.chatId);
		deps.updateStatus(ctx);
		const result = await deps.sendTmuxCommand(command);
		if (!result.ok) {
			deps.removeQueuedTurn(turn);
			deps.stopTypingLoop();
			deps.updateStatus(ctx);
			const errorMessage = result.missingTmux ? "Cannot start boomerang: pi is not running inside tmux." : `Failed to start boomerang: ${result.message}`;
			await deps.sendTextReply(message.chat.id, message.message_id, errorMessage);
		}
		return true;
	}

	async function handleBoomCancelCommand(message: TelegramCommandMessage): Promise<boolean> {
		if (!deps.hasBoomerangCommands()) {
			await deps.sendTextReply(message.chat.id, message.message_id, "Boomerang is not available in this Pi session. Install/load the pi-boomerang extension first.");
			return true;
		}
		const result = await deps.sendTmuxCommand("/boomerang-cancel");
		if (!result.ok) {
			const errorMessage = result.missingTmux ? "Cannot cancel boomerang: pi is not running inside tmux." : `Failed to cancel boomerang: ${result.message}`;
			await deps.sendTextReply(message.chat.id, message.message_id, errorMessage);
			return true;
		}
		await deps.sendTextReply(message.chat.id, message.message_id, "Cancelling boomerang.");
		return true;
	}

	async function handleModelCommand(message: TelegramCommandMessage, ctx: TelegramCommandContext): Promise<boolean> {
		const scopedModels = getScopedModelList(ctx);
		if (scopedModels.length === 0) {
			await deps.sendTextReply(message.chat.id, message.message_id, `Current model: ${formatModel(ctx.model)}\nNo scoped models are configured for this Pi session, so Telegram model switching is disabled.`);
			return true;
		}
		const requestedModel = message.text?.slice("/model".length).trim() ?? "";
		if (!requestedModel) {
			const currentIndex = findCurrentModelIndex(scopedModels, ctx.model);
			const lines = [`Current model: ${formatModel(ctx.model)}`, `Thinking: ${deps.getThinkingLevel()}`, "", "Scoped models:"];
			for (const [index, model] of scopedModels.entries()) {
				const marker = index === currentIndex ? "*" : " ";
				lines.push(`${marker} ${index + 1}. ${formatModel(model)}`);
			}
			lines.push("", "Use /model next, /model prev, or /model provider/model-id.");
			await deps.sendTextReply(message.chat.id, message.message_id, lines.join("\n"));
			return true;
		}
		if (!ctx.isIdle()) {
			await deps.sendTextReply(message.chat.id, message.message_id, "Cannot switch model while pi is busy. Send \"stop\" first.");
			return true;
		}

		let targetModel: Model<any> | undefined;
		const currentIndex = findCurrentModelIndex(scopedModels, ctx.model);
		const normalizedRequest = requestedModel.toLowerCase();
		if (normalizedRequest === "next" || normalizedRequest === "prev") {
			const direction = normalizedRequest === "next" ? 1 : -1;
			const startIndex = currentIndex >= 0 ? currentIndex : 0;
			const targetIndex = (startIndex + direction + scopedModels.length) % scopedModels.length;
			targetModel = scopedModels[targetIndex];
		} else {
			const resolved = findScopedModel(scopedModels, requestedModel);
			if (resolved.error) {
				await deps.sendTextReply(message.chat.id, message.message_id, resolved.error);
				return true;
			}
			targetModel = resolved.model;
		}

		if (!targetModel) {
			await deps.sendTextReply(message.chat.id, message.message_id, "No target model resolved.");
			return true;
		}
		const previousModel = formatModel(ctx.model);
		const changed = await deps.setModel(targetModel);
		if (!changed) {
			await deps.sendTextReply(message.chat.id, message.message_id, `Could not switch to ${formatModel(targetModel)}: authentication is not configured.`);
			return true;
		}
		await deps.sendTextReply(message.chat.id, message.message_id, `Model: ${previousModel} -> ${formatModel(targetModel)}\nThinking: ${deps.getThinkingLevel()}`);
		return true;
	}

	async function handleThinkCommand(message: TelegramCommandMessage): Promise<boolean> {
		const requestedLevel = message.text?.slice("/think".length).trim() ?? "";
		if (!requestedLevel) {
			const currentLevel = deps.getThinkingLevel();
			await deps.sendTextReply(message.chat.id, message.message_id, `Current thinking level: ${currentLevel}\nAvailable: off, minimal, low, medium, high, xhigh`);
			return true;
		}
		const level = parseThinkingLevel(requestedLevel);
		if (!level) {
			await deps.sendTextReply(message.chat.id, message.message_id, `Unknown thinking level: ${requestedLevel}\nAvailable: off, minimal, low, medium, high, xhigh`);
			return true;
		}
		const previousLevel = deps.getThinkingLevel();
		deps.setThinkingLevel(level);
		const currentLevel = deps.getThinkingLevel();
		const clamped = currentLevel !== level ? ` Requested ${level}, but current model clamped it to ${currentLevel}.` : "";
		await deps.sendTextReply(message.chat.id, message.message_id, `Thinking level: ${previousLevel} -> ${currentLevel}.${clamped}`);
		return true;
	}

	async function handleSessionCommand(message: TelegramCommandMessage, ctx: TelegramCommandContext, command: "/new" | "/reload"): Promise<boolean> {
		const action = command === "/new" ? "start a new session" : "reload pi";
		if (!ctx.isIdle()) {
			await deps.sendTextReply(message.chat.id, message.message_id, `Cannot ${action} while pi is busy. Send "stop" first.`);
			return true;
		}
		deps.clearQueuedTurns();
		deps.setPreserveQueuedTurnsAsHistory(false);
		await deps.prepareSessionChange();
		const result = await deps.sendTmuxCommand(command);
		if (!result.ok) {
			await deps.rollbackSessionChange();
			const errorMessage = result.missingTmux ? `Cannot ${action}: pi is not running inside tmux.` : `Failed to ${action}: ${result.message}`;
			await deps.sendTextReply(message.chat.id, message.message_id, errorMessage);
			return true;
		}
		const started = command === "/new" ? "Starting a new pi session." : "Reloading pi.";
		await deps.sendTextReply(message.chat.id, message.message_id, started);
		return true;
	}

	async function handleStatusCommand(message: TelegramCommandMessage, ctx: TelegramCommandContext): Promise<boolean> {
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			totalInput += entry.message.usage.input;
			totalOutput += entry.message.usage.output;
			totalCacheRead += entry.message.usage.cacheRead;
			totalCacheWrite += entry.message.usage.cacheWrite;
			totalCost += entry.message.usage.cost.total;
		}

		const usage = ctx.getContextUsage();
		const lines: string[] = [];
		if (ctx.model) lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
		lines.push(`Thinking: ${deps.getThinkingLevel()}`);
		const tokenParts: string[] = [];
		if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
		if (tokenParts.length > 0) lines.push(`Usage: ${tokenParts.join(" ")}`);
		const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
		if (totalCost || usingSubscription) lines.push(`Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		if (usage) {
			const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
			lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
		} else {
			lines.push("Context: unknown");
		}
		if (lines.length === 0) lines.push("No usage data yet.");
		await deps.sendTextReply(message.chat.id, message.message_id, lines.join("\n"));
		return true;
	}

	async function handleHelpCommand(message: TelegramCommandMessage, ctx: TelegramCommandContext): Promise<boolean> {
		await deps.sendTextReply(
			message.chat.id,
			message.message_id,
			`Send me a message and I will forward it to pi. Commands: /status, /compact, /new, /reload, /model, /think, /boom, /boom_cancel, stop.`,
		);
		if (deps.getAllowedUserId() === undefined && message.from) {
			await deps.setAllowedUserId(message.from.id);
			deps.updateStatus(ctx);
		}
		return true;
	}

	return async function dispatchTelegramCommand(message: TelegramCommandMessage, lower: string, ctx: TelegramCommandContext): Promise<boolean> {
		if (lower === "stop" || lower === "/stop") return handleStopCommand(message, ctx);
		if (lower === "/compact") return handleCompactCommand(message, ctx);
		if (lower === "/boom" || lower.startsWith("/boom ") || lower === "/boomerang" || lower.startsWith("/boomerang ")) return handleBoomCommand(message, ctx);
		if (lower === "/boom_cancel" || lower === "/boomerang_cancel") return handleBoomCancelCommand(message);
		if (lower === "/model" || lower.startsWith("/model ")) return handleModelCommand(message, ctx);
		if (lower === "/think" || lower.startsWith("/think ")) return handleThinkCommand(message);
		if (lower === "/new" || lower === "/reload") return handleSessionCommand(message, ctx, lower);
		if (lower === "/status") return handleStatusCommand(message, ctx);
		if (lower === "/help" || lower === "/start") return handleHelpCommand(message, ctx);
		return false;
	};
}

import { createHash } from "node:crypto";

import type {
	Agent,
	AgentInputItem,
	AgentOutputType,
	RunContext,
	TextOutput,
	Tool,
} from "@openai/agents";
import { tool } from "@openai/agents";
import type { MnemonAuthorization, MnemonClient, RecallHit } from "@romanbsd/mnemon-core";
import {
	AUDIENCE_DESCRIPTIONS,
	heuristicGate,
	type MemoryAudience,
	type MemoryGate,
	MNEMON_MEMORY_INSTRUCTIONS,
	type RecallFilter,
	SECRET_PATTERNS,
} from "@romanbsd/mnemon-eve/gates";
import { z } from "zod";

import { clip, formatRecallBlock, isIdentifier, positiveInteger } from "./format.js";
import { latestUserText } from "./input.js";

export type ProposalStatus = "stored" | "duplicate" | "rejected";

export interface ProposalResult {
	status: ProposalStatus;
	/** Why the gate rejected; empty unless `status` is `"rejected"`. */
	reasons: string[];
	/** Memory id when stored or already present. */
	id?: string;
	/** Ids of related memories the stored fact replaced; they are forgotten. */
	superseded?: string[];
}

/** Metadata only: never memory bodies, facts, or auth attributes. */
export type MnemonAgentsEvent =
	| {
			type: "recall";
			slot: string;
			audience: MemoryAudience;
			partition: string;
			count: number;
			candidates?: number;
			filterFailed?: boolean;
			latencyMs: number;
			replayed: boolean;
	  }
	| {
			type: "proposal";
			slot: string;
			audience: MemoryAudience;
			callId: string;
			partition: string;
			status: ProposalStatus | "error";
			reasons: string[];
			superseded: number;
			gateMs?: number;
			writeMs?: number;
			latencyMs: number;
			replayed: boolean;
	  }
	| {
			type: "forget";
			slot: string;
			audience: MemoryAudience;
			callId: string;
			partition: string;
			status: "forgotten" | "missing" | "error";
			latencyMs: number;
			replayed: boolean;
	  };

export interface MnemonAuthContext {
	tenantId: string;
	userId?: string | null;
}

/** Mirrors `@openai/agents` tool approval; not re-exported from the package root. */
export type ForgetNeedsApproval =
	| boolean
	| ((
			runContext: RunContext,
			input: { id: string },
			callId?: string,
	  ) => Promise<boolean>);

export interface MnemonAgentsMemoryOptions<TContext = unknown> {
	client: MnemonClient;
	audience: MemoryAudience;
	/**
	 * Fixed Mnemon namespace naming this application, e.g. `"support-agent"`.
	 * Required: OpenAI Agents has no Eve-style scope key fallback.
	 */
	namespace: string;
	/**
	 * Derive tenant/user from `RunContext.context` only — never from tool args.
	 * `namespace` from options is always applied; `userId` is forced null for
	 * organization audience.
	 */
	resolveAuth: (runContext: RunContext<TContext>) => MnemonAuthContext;
	/** Memories injected per turn. Default 5. */
	recallLimit?: number;
	/** Total characters of recalled content per turn. Default 4000. */
	recallCharBudget?: number;
	/** Same-scope memories shown to the gate for duplicate checks. Default 5. */
	relatedLimit?: number;
	recallFilter?: RecallFilter;
	/**
	 * Decides which proposals are stored. Default: `heuristicGate()`.
	 * For Jev, import `jevGate` from `@romanbsd/mnemon-openai/jev` (requires `eve`).
	 */
	gate?: MemoryGate;
	/**
	 * Adds a forget tool and shows memory ids in recall. Off by default.
	 * `true` sets `needsApproval: true`. Pass `{ needsApproval }` to customize.
	 */
	forget?: boolean | { needsApproval?: ForgetNeedsApproval };
	onEvent?: (event: MnemonAgentsEvent) => void;
	/** Label used in events; default equals `audience`. */
	slot?: string;
}

export type AgentInstructions<TContext = unknown, TOutput extends AgentOutputType = TextOutput> =
	| string
	| ((
			runContext: RunContext<TContext>,
			agent: Agent<TContext, TOutput>,
	  ) => string | Promise<string>);

export interface MnemonAgentsMemory<TContext = unknown> {
	audience: MemoryAudience;
	slot: string;
	tools: Tool<TContext>[];
	/** Compose base instructions + memory policy + recalled memories. */
	buildInstructions: <TOutput extends AgentOutputType = TextOutput>(
		base: AgentInstructions<TContext, TOutput>,
	) => (
		runContext: RunContext<TContext>,
		agent: Agent<TContext, TOutput>,
	) => Promise<string>;
	recallForTurn: (
		runContext: RunContext<TContext>,
		turnInput: string | AgentInputItem[],
	) => Promise<string>;
	/** Cached recall from `onAgentStart`, or `""` if none. */
	cachedRecall: (runContext: RunContext<TContext>) => Promise<string>;
	/**
	 * Warm the recall cache for `buildInstructions`. Attach with
	 * `agent.on("agent_start", memory.onAgentStart)` or use `withMnemonMemory`.
	 */
	onAgentStart: (
		runContext: RunContext<TContext>,
		_agent: unknown,
		turnInput?: AgentInputItem[],
	) => void;
}

export class MnemonAgentsScopeError extends Error {
	override readonly name = "MnemonAgentsScopeError";
}

const MAX_QUERY_CHARS = 2000;
const MAX_NAMESPACE_CHARS = 200;
const MAX_RECALL_LIMIT = 100;

export function createMnemonMemory<TContext = unknown>(
	options: MnemonAgentsMemoryOptions<TContext>,
): MnemonAgentsMemory<TContext> {
	const { client, audience } = options;
	const slot = options.slot ?? audience;
	const recallLimit = positiveInteger(options.recallLimit ?? 5, "recallLimit", MAX_RECALL_LIMIT);
	const recallCharBudget = positiveInteger(options.recallCharBudget ?? 4000, "recallCharBudget");
	const relatedLimit = positiveInteger(options.relatedLimit ?? 5, "relatedLimit", MAX_RECALL_LIMIT);
	const gate = options.gate ?? heuristicGate();
	const namespace = options.namespace;
	if (!isIdentifier(namespace) || namespace.length > MAX_NAMESPACE_CHARS) {
		throw new MnemonAgentsScopeError(
			`namespace must be 1-${MAX_NAMESPACE_CHARS} characters without surrounding whitespace`,
		);
	}

	const forgetEnabled = Boolean(options.forget);
	const needsApproval: ForgetNeedsApproval | undefined =
		options.forget === true
			? true
			: options.forget
				? (options.forget.needsApproval ?? true)
				: undefined;

	const emit = (event: MnemonAgentsEvent) => {
		try {
			options.onEvent?.(event);
		} catch {}
	};

	const recallCache = new WeakMap<RunContext<TContext>, Promise<string>>();

	const resolveScope = (runContext: RunContext<TContext>) => {
		const base = options.resolveAuth(runContext);
		if (!isIdentifier(base.tenantId)) {
			throw new MnemonAgentsScopeError("resolveAuth must return a non-empty tenantId");
		}
		const userId = audience === "personal" ? base.userId : null;
		if (audience === "personal" && !isIdentifier(userId)) {
			throw new MnemonAgentsScopeError(
				"resolveAuth must return a non-empty userId for personal memory",
			);
		}
		const auth: MnemonAuthorization = {
			tenantId: base.tenantId,
			userId: userId ?? null,
			namespace,
		};
		return {
			auth,
			partition: digest(namespace, auth.tenantId, auth.userId ?? "").slice(0, 12),
			key: `${namespace}:${auth.tenantId}:${auth.userId ?? ""}`,
		};
	};

	const recallForTurn = async (
		runContext: RunContext<TContext>,
		turnInput: string | AgentInputItem[],
	): Promise<string> => {
		const started = performance.now();
		const scope = resolveScope(runContext);
		const query = clip(latestUserText(turnInput), MAX_QUERY_CHARS);
		let candidates: number | undefined;
		let filterFailed: boolean | undefined;
		const { value, replayed } = await client.withAuthorization(
			scope.auth,
			(tx) =>
				tx.once(`recall:${digest(scope.key, query, slot)}`, async (m) => {
					if (!query) return { text: "", count: 0 };
					const { results } = await m.recall({
						query,
						limit: options.recallFilter
							? Math.min(recallLimit * 2, MAX_RECALL_LIMIT)
							: recallLimit,
					});
					let hits = results;
					if (options.recallFilter && hits.length) {
						candidates = hits.length;
						try {
							const keep = new Set(
								await options.recallFilter({
									query,
									audience,
									memories: hits.map((h) => ({
										id: h.insight.id,
										content: clip(h.insight.content, 1000),
									})),
								}),
							);
							hits = hits.filter((h) => keep.has(h.insight.id));
						} catch {
							filterFailed = true;
						}
					}
					const selected = hits.slice(0, recallLimit);
					return {
						text: formatRecallBlock(selected, audience, recallCharBudget, forgetEnabled),
						count: selected.length,
					};
				}),
			{ embed: query ? [{ text: query, purpose: "query" }] : [] },
		);
		emit({
			type: "recall",
			slot,
			audience,
			partition: scope.partition,
			count: value.count,
			candidates,
			filterFailed,
			latencyMs: performance.now() - started,
			replayed,
		});
		return value.text;
	};

	const cachedRecall = async (runContext: RunContext<TContext>) => {
		return (await recallCache.get(runContext)) ?? "";
	};

	const onAgentStart = (
		runContext: RunContext<TContext>,
		_agent: unknown,
		turnInput?: AgentInputItem[],
	) => {
		recallCache.set(runContext, recallForTurn(runContext, turnInput ?? ""));
	};

	const buildInstructions =
		<TOutput extends AgentOutputType = TextOutput>(base: AgentInstructions<TContext, TOutput>) =>
		async (runContext: RunContext<TContext>, agent: Agent<TContext, TOutput>) => {
			const baseText =
				typeof base === "function" ? await base(runContext, agent) : base;
			const recalled = await cachedRecall(runContext);
			return [baseText, MNEMON_MEMORY_INSTRUCTIONS, recalled].filter(Boolean).join("\n\n");
		};

	const proposeName = `propose_${audience}_memory`;
	const forgetName = `forget_${audience}_memory`;

	const propose_memory = tool({
		name: proposeName,
		description: `Propose a concise, self-contained durable memory for ${audience} memory. ${AUDIENCE_DESCRIPTIONS[audience]} The memory system decides whether it is stored.`,
		parameters: z.object({
			fact: z.string().min(1).max(4000),
			reason: z.string().max(1000).optional(),
		}),
		execute: async ({ fact, reason }, runContext, details): Promise<ProposalResult> => {
			if (!runContext) {
				throw new MnemonAgentsScopeError("propose_memory requires a run context");
			}
			const started = performance.now();
			// tool() erases TContext to unknown on execute's RunContext.
			const scope = resolveScope(runContext as RunContext<TContext>);
			const callId =
				details?.toolCall &&
				"callId" in details.toolCall &&
				typeof details.toolCall.callId === "string"
					? details.toolCall.callId
					: crypto.randomUUID();
			const abortSignal = details?.signal;
			const candidate = fact.replace(/\s+/g, " ").trim();
			let gateMs: number | undefined;
			let writeMs: number | undefined;
			const report = (
				status: ProposalStatus | "error",
				value?: ProposalResult,
				replayed = false,
			) => {
				emit({
					type: "proposal",
					slot,
					audience,
					callId,
					partition: scope.partition,
					status,
					reasons: value?.reasons ?? [],
					superseded: value?.superseded?.length ?? 0,
					gateMs,
					writeMs,
					latencyMs: performance.now() - started,
					replayed,
				});
			};
			if (!candidate || SECRET_PATTERNS.some((p) => p.test(candidate))) {
				const value: ProposalResult = {
					status: "rejected",
					reasons: [candidate ? "sensitive" : "empty"],
				};
				report(value.status, value);
				return value;
			}
			const key = `propose:${digest(scope.key, callId, slot, candidate.toLowerCase())}`;
			try {
				const relatedQuery = clip(candidate, MAX_QUERY_CHARS);
				const peek = await client.withAuthorization(
					scope.auth,
					async (tx) => {
						try {
							return await tx.once(key, async (m) => {
								const related = await m.recall({
									query: relatedQuery,
									limit: relatedLimit,
								});
								throw new NotRecorded(related.results);
							});
						} catch (error) {
							if (error instanceof NotRecorded) return error;
							throw error;
						}
					},
					{ embed: [{ text: relatedQuery, purpose: "query" }] },
				);
				if (!(peek instanceof NotRecorded)) {
					const value = peek.value as ProposalResult;
					report(value.status, value, true);
					return value;
				}
				const related = peek.related;
				let t = performance.now();
				const decision = await gate({
					fact: candidate,
					reason,
					audience,
					audienceDescription: AUDIENCE_DESCRIPTIONS[audience],
					recentContext: "",
					relatedMemories: related.map((h) => ({
						id: h.insight.id,
						content: clip(h.insight.content, 1000),
					})),
					abortSignal,
				});
				gateMs = performance.now() - t;
				const outcome = await client.withAuthorization(scope.auth, (tx) =>
					tx.once(key, async (m): Promise<ProposalResult> => {
						if (!decision.accept) {
							return { status: "rejected", reasons: decision.reasons };
						}
						t = performance.now();
						const saved = await m.remember({
							content: candidate,
							category: decision.category,
							importance: decision.importance,
							source: `openai-agents:${slot}`,
							deduplicate: true,
						});
						if (saved.action !== "added") {
							writeMs = performance.now() - t;
							return {
								status: "duplicate",
								reasons: [],
								id: saved.duplicateOf ?? saved.insight.id,
							};
						}
						const shown = new Set(related.map((h) => h.insight.id));
						const superseded = [...new Set(decision.supersedes ?? [])].filter(
							(id) => shown.has(id) && id !== saved.insight.id,
						);
						for (const id of superseded) await m.forget(id);
						writeMs = performance.now() - t;
						return {
							status: "stored",
							reasons: [],
							id: saved.insight.id,
							...(superseded.length ? { superseded } : {}),
						};
					}),
					{ embed: decision.accept ? [{ text: candidate, purpose: "document" }] : [] },
				);
				report(outcome.value.status, outcome.value, outcome.replayed);
				return outcome.value;
			} catch (error) {
				report("error");
				throw error;
			}
		},
	});

	const tools: Tool<TContext>[] = [propose_memory];

	if (forgetEnabled) {
		tools.push(
			tool({
				name: forgetName,
				description: `Forget one ${audience} memory by the id shown when it was recalled. Use only when the user asks to remove or correct it.`,
				parameters: z.object({ id: z.uuid() }),
				needsApproval: needsApproval ?? true,
				execute: async ({ id }, runContext, details): Promise<{ forgotten: boolean }> => {
					if (!runContext) {
						throw new MnemonAgentsScopeError("forget_memory requires a run context");
					}
					const started = performance.now();
					const scope = resolveScope(runContext);
					const callId =
						details?.toolCall &&
						"callId" in details.toolCall &&
						typeof details.toolCall.callId === "string"
							? details.toolCall.callId
							: crypto.randomUUID();
					const report = (status: "forgotten" | "missing" | "error", replayed = false) => {
						emit({
							type: "forget",
							slot,
							audience,
							callId,
							partition: scope.partition,
							status,
							latencyMs: performance.now() - started,
							replayed,
						});
					};
					try {
						const { value, replayed } = await client.withAuthorization(scope.auth, (tx) =>
							tx.once(`forget:${digest(scope.key, callId, slot, id)}`, (m) => m.forget(id)),
						);
						report(value.forgotten ? "forgotten" : "missing", replayed);
						return { forgotten: value.forgotten };
					} catch (error) {
						report("error");
						throw error;
					}
				},
			}),
		);
	}

	return {
		audience,
		slot,
		tools,
		buildInstructions,
		recallForTurn,
		cachedRecall,
		onAgentStart,
	};
}

class NotRecorded extends Error {
	constructor(readonly related: RecallHit[]) {
		super("not recorded");
	}
}

function digest(...parts: string[]): string {
	return createHash("sha256").update(parts.join("\0")).digest("base64url");
}

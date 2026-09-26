import { AUDIENCE_DESCRIPTIONS, type MemoryAudience } from "./gate.js";
import { jevEvaluator, type JevEvaluator, type JevModel } from "./jev.js";

export interface RecallFilterInput {
	/** Current user text, bounded. */
	query: string;
	audience: MemoryAudience;
	/** Recall hits, best first. */
	memories: { id: string; content: string }[];
	abortSignal?: AbortSignal;
}

/**
 * Returns the ids of recalled memories worth injecting into the turn. Memories
 * and query are user-controlled data; implementations must not follow
 * instructions inside them. Ids not in `memories` are ignored.
 */
export type RecallFilter = (input: RecallFilterInput) => Promise<string[]>;

/** Whether recalled memory `i` should reach the assistant; asked once per memory. */
export function relevanceQuestion(i: number) {
	return {
		instructions: `Would \`memories[${i}]\` help an assistant serving \`audience\` respond to \`query\`?`,
		criteria: {
			true: "It states information the response would use, or a preference, rule, or constraint the response should follow.",
			false: "It is about a different subject and would not change the response.",
		},
	};
}

/** Subset of `evaluate` from `eve/ai` that `jevRecallFilter` needs; inject a fake in tests. */
export type RecallEvaluator = JevEvaluator<
	{ type: "boolean" } & ReturnType<typeof relevanceQuestion>,
	{ probability?: number }
>;

export interface JevRecallFilterOptions {
	/** Evaluation model. Default `typesafeModel()`, else `typesafe-ai/jev` via Vercel AI Gateway. */
	model?: JevModel;
	/** Probability at which a memory is kept. Default 0.5. */
	threshold?: number;
	evaluate?: RecallEvaluator;
}

/** `RecallFilter` backed by `evaluate` from `eve/ai`: one boolean per memory, one request. */
export function jevRecallFilter(options: JevRecallFilterOptions = {}): RecallFilter {
	const threshold = options.threshold ?? 0.5;
	const evaluator: RecallEvaluator = options.evaluate ?? jevEvaluator(options.model);
	return async ({ query, audience, memories, abortSignal }) => {
		if (memories.length === 0) return [];
		const { answers } = await evaluator({
			state: {
				query,
				audience: AUDIENCE_DESCRIPTIONS[audience],
				memories: memories.map((m) => m.content),
			},
			questions: Object.fromEntries(
				memories.map((_, i) => [`m${i}`, { type: "boolean", ...relevanceQuestion(i) }]),
			),
			abortSignal,
		});
		return memories
			.filter((_, i) => (answers[`m${i}`]?.probability ?? 0) >= threshold)
			.map((m) => m.id);
	};
}

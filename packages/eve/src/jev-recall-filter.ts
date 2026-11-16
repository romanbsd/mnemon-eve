import { AUDIENCE_DESCRIPTIONS } from "./gate.js";
import { jevEvaluator, type JevEvaluator, type JevModel } from "./jev.js";
import {
	type RecallFilter,
	relevanceQuestion,
} from "./recall-filter.js";

/** Subset of `decide` from `eve/ai` that `jevRecallFilter` needs; inject a fake in tests. */
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

/** `RecallFilter` backed by `decide` from `eve/ai`: one boolean per memory, one request. */
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

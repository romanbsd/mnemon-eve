import {
	CATEGORY_QUESTION,
	classification,
	decide,
	GATE_QUESTIONS,
	type GateFlag,
	gateState,
	IMPORTANCE_QUESTION,
	type MemoryGate,
	supersedeQuestion,
} from "./gate.js";
import { jevEvaluator, type JevEvaluator, type JevModel } from "./jev.js";

interface BooleanQuestion {
	type: "boolean";
	instructions: string;
	criteria?: { true?: string; false?: string };
}

type JevQuestion =
	| BooleanQuestion
	| ({ type: "choice" } & typeof CATEGORY_QUESTION)
	| ({ type: "score" } & typeof IMPORTANCE_QUESTION);

/**
 * Subset of `decide` from `eve/ai` that `jevGate` needs; inject a fake in
 * tests. Questions are the gate flags, `category`, `importance`, and
 * `supersedes_<i>` per related memory.
 */
export type MemoryEvaluator = JevEvaluator<
	JevQuestion,
	{
		probability?: number;
		choice?: string;
		/** Fractional level index, 0 through 4, for `importance`. */
		score?: number;
	}
>;

export interface JevGateOptions {
	/** Evaluation model. Default `typesafeModel()`, else `typesafe-ai/jev` via Vercel AI Gateway. */
	model?: JevModel;
	/** Probability at which a flag counts as true. Default 0.5. */
	threshold?: number;
	/** Probability at which a related memory counts as superseded. Default 0.8: forgetting is destructive. */
	supersedeThreshold?: number;
	evaluate?: MemoryEvaluator;
}

const FLAGS = Object.keys(GATE_QUESTIONS) as GateFlag[];

// Classification rides in the same request, so it adds no round trip.
const JEV_QUESTIONS: Record<string, JevQuestion> = {
	...Object.fromEntries(
		FLAGS.map((k) => [k, { type: "boolean", ...GATE_QUESTIONS[k] }]),
	),
	category: { type: "choice", ...CATEGORY_QUESTION },
	importance: { type: "score", ...IMPORTANCE_QUESTION },
};

/** Gate backed by `decide` from `eve/ai` (TypeSafe Jev by default). */
export function jevGate(options: JevGateOptions = {}): MemoryGate {
	const threshold = options.threshold ?? 0.5;
	const supersedeThreshold = options.supersedeThreshold ?? 0.8;
	const evaluator: MemoryEvaluator = options.evaluate ?? jevEvaluator(options.model);
	return async (input) => {
		const { answers } = await evaluator({
			state: gateState(input),
			questions: {
				...JEV_QUESTIONS,
				...Object.fromEntries(
					input.relatedMemories.map((_, i) => [
						`supersedes_${i}`,
						{ type: "boolean", ...supersedeQuestion(i) },
					]),
				),
			},
			abortSignal: input.abortSignal,
		});
		if (!FLAGS.every((k) => Number.isFinite(answers[k]?.probability))) {
			return { accept: false, reasons: ["invalid-evaluation"] };
		}
		const flag = (k: GateFlag) => (answers[k]?.probability ?? 0) >= threshold;
		const decision = decide({
			durable: flag("durable"),
			transient: flag("transient"),
			duplicate: flag("duplicate"),
			appropriateAudience: flag("appropriateAudience"),
			sensitive: flag("sensitive"),
		});
		if (!decision.accept) return decision;
		const score = answers.importance?.score;
		const supersedes = input.relatedMemories
			.filter((_, i) => (answers[`supersedes_${i}`]?.probability ?? 0) >= supersedeThreshold)
			.map((r) => r.id);
		return {
			...decision,
			...classification(
				answers.category?.choice,
				typeof score === "number" ? score + 1 : undefined,
			),
			...(supersedes.length ? { supersedes } : {}),
		};
	};
}

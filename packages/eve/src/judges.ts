import {
	CAUSAL_RELATIONS,
	type CausalJudge,
	type CausalRelation,
	DIFF_RELATIONS,
	type DiffJudge,
	type DiffRelation,
} from "@mnemon/core";
import { evaluate } from "eve/ai";

export const DIFF_RELATION_CRITERIA: Record<DiffRelation, string> = {
	duplicate: "States substantially the same information, even if worded differently.",
	refines:
		"Same subject; adds detail or narrows it without contradicting anything the existing memory says.",
	contradicts:
		"Same subject; changes a value, reverses a decision, or makes the existing memory no longer true.",
	unrelated: "About a different subject, or only shares incidental words.",
};

export const CAUSAL_RELATION_CRITERIA: Record<CausalRelation, string> = {
	existing_causes_new: "What `existing` describes caused or motivated what `newMemory` describes.",
	existing_enables_new: "What `existing` describes made what `newMemory` describes possible.",
	existing_prevents_new: "What `existing` describes blocked or ruled out what `newMemory` describes.",
	new_causes_existing: "What `newMemory` describes caused or motivated what `existing` describes.",
	new_enables_existing: "What `newMemory` describes made what `existing` describes possible.",
	new_prevents_existing: "What `newMemory` describes blocked or ruled out what `existing` describes.",
	none: "Neither explains the other; they are unrelated or only share a topic.",
};

type ChoiceQuestion = {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
};

/** Subset of `evaluate` from `eve/ai` the judges need; inject a fake in tests. */
export type JudgeEvaluator = (options: {
	state: Record<string, unknown>;
	questions: Record<string, ChoiceQuestion>;
}) => Promise<{
	answers: Record<
		string,
		{ choice: string; probabilities?: Record<string, number> } | undefined
	>;
}>;

export interface JevJudgeOptions {
	/** Evaluation model. Default `typesafe-ai/jev` via Vercel AI Gateway. */
	model?: Parameters<typeof evaluate>[0]["model"];
	evaluate?: JudgeEvaluator;
}

function evaluatorFor(options: JevJudgeOptions): JudgeEvaluator {
	return (
		options.evaluate ??
		((input) =>
			evaluate({ ...input, state: input.state as never, model: options.model }))
	);
}

/**
 * `DiffJudge` backed by `evaluate` from `eve/ai`: one choice per candidate,
 * all in a single request. Pass as `diffJudge` in the Mnemon config.
 */
export function jevDiffJudge(options: JevJudgeOptions = {}): DiffJudge {
	const evaluator = evaluatorFor(options);
	return async ({ content, candidates }) => {
		const questions = Object.fromEntries(
			candidates.map((_, i) => [
				`c${i}`,
				{
					type: "choice",
					instructions: `How does \`newMemory\` relate to \`existing[${i}]\`?`,
					criteria: DIFF_RELATION_CRITERIA,
				} satisfies ChoiceQuestion,
			]),
		);
		const { answers } = await evaluator({
			state: { newMemory: content, existing: candidates.map((c) => c.content) },
			questions,
		});
		const relations: Partial<Record<string, DiffRelation>> = {};
		candidates.forEach((c, i) => {
			const choice = answers[`c${i}`]?.choice as DiffRelation;
			if (DIFF_RELATIONS.includes(choice)) relations[c.id] = choice;
		});
		return relations;
	};
}

/**
 * `CausalJudge` backed by `evaluate` from `eve/ai`: one choice per recent
 * memory, all in a single request. Edge weight is the chosen relation's
 * probability. Pass as `causalJudge` in the Mnemon config.
 */
export function jevCausalJudge(options: JevJudgeOptions = {}): CausalJudge {
	const evaluator = evaluatorFor(options);
	return async ({ content, previous }) => {
		const questions = Object.fromEntries(
			previous.map((_, i) => [
				`p${i}`,
				{
					type: "choice",
					instructions: `Is there a causal link between \`newMemory\` and \`existing[${i}]\`, and in which direction?`,
					criteria: CAUSAL_RELATION_CRITERIA,
				} satisfies ChoiceQuestion,
			]),
		);
		const { answers } = await evaluator({
			state: { newMemory: content, existing: previous.map((p) => p.content) },
			questions,
		});
		const judged: Awaited<ReturnType<CausalJudge>> = {};
		previous.forEach((p, i) => {
			const answer = answers[`p${i}`];
			const relation = answer?.choice as CausalRelation;
			if (!CAUSAL_RELATIONS.includes(relation) || relation === "none") return;
			judged[p.id] = { relation, weight: answer?.probabilities?.[relation] ?? 1 };
		});
		return judged;
	};
}

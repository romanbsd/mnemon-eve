/**
 * Jev-backed gates and judges. Requires the `eve` package (optional peer of
 * `@romanbsd/mnemon-eve`) plus TypeSafe credentials for the default model.
 */
export {
	type JevGateOptions,
	jevGate,
	type MemoryEvaluator,
	type JevRecallFilterOptions,
	jevRecallFilter,
	type RecallEvaluator,
	CAUSAL_RELATION_CRITERIA,
	DIFF_RELATION_CRITERIA,
	type JevJudgeOptions,
	type JudgeEvaluator,
	jevCausalJudge,
	jevDiffJudge,
	type JevEvaluator,
	jevEvaluator,
	type JevModel,
	typesafeModel,
} from "@romanbsd/mnemon-eve";

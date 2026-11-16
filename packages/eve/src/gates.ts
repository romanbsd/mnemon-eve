/**
 * Framework-agnostic gate and recall-filter surface. Safe to import without
 * installing the `eve` peer (unlike the package root, which loads Eve APIs).
 */
export {
	AUDIENCE_DESCRIPTIONS,
	CATEGORY_QUESTION,
	IMPORTANCE_QUESTION,
	classification,
	decide,
	GATE_QUESTIONS,
	type GateFlag,
	gateState,
	type MemoryAudience,
	type MemoryGate,
	type MemoryGateDecision,
	type MemoryGateInput,
	supersedeQuestion,
} from "./gate.js";
export { heuristicGate, SECRET_PATTERNS } from "./heuristic-gate.js";
export { MNEMON_MEMORY_INSTRUCTIONS } from "./instructions.js";
export { type LlmGateOptions, llmGate, MnemonEveGateError } from "./llm-gate.js";
export {
	type RecallFilter,
	type RecallFilterInput,
	relevanceQuestion,
} from "./recall-filter.js";

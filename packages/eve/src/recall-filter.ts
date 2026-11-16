import type { MemoryAudience } from "./gate.js";

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

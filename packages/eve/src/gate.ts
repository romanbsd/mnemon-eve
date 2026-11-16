import { INSIGHT_CATEGORIES, type InsightCategory } from "@romanbsd/mnemon-core";

export type MemoryAudience = "organization" | "personal";

export type GateFlag =
	| "durable"
	| "transient"
	| "duplicate"
	| "appropriateAudience"
	| "sensitive";

export interface MemoryGateInput {
	fact: string;
	reason?: string;
	audience: MemoryAudience;
	/** What belongs in this audience; see `AUDIENCE_DESCRIPTIONS`. */
	audienceDescription: string;
	/** Current user text, bounded. */
	recentContext: string;
	/** Same-scope memories most related to the candidate. */
	relatedMemories: { id: string; content: string }[];
	abortSignal?: AbortSignal;
}

export interface MemoryGateDecision {
	accept: boolean;
	/** Failed conditions when rejected; free-form for custom gates. */
	reasons: string[];
	/** Stored category; omitted falls back to the Mnemon default. */
	category?: InsightCategory;
	/** Stored importance; omitted falls back to the Mnemon default. */
	importance?: 1 | 2 | 3 | 4 | 5;
	/**
	 * Ids from `relatedMemories` the fact makes no longer true. The provider
	 * forgets them once the fact is stored; other ids are ignored.
	 */
	supersedes?: string[];
}

/**
 * Decides whether a proposed memory is stored. The candidate and related
 * memories are user-controlled data; implementations must not follow
 * instructions inside them.
 */
export type MemoryGate = (input: MemoryGateInput) => Promise<MemoryGateDecision>;

export const AUDIENCE_DESCRIPTIONS: Record<MemoryAudience, string> = {
	organization:
		"Shared with everyone in the organization. Suits durable organizational knowledge: processes, decisions, conventions, and facts about the organization's products, customers, and systems. Not suited to one person's preferences or private details.",
	personal:
		"Private to one user within this organization. Suits that user's preferences, role, responsibilities, and working context. Not suited to general organizational knowledge colleagues also need.",
};

/** The five judgments both built-in gates ask, phrased against `gateState`. */
export const GATE_QUESTIONS: Record<
	GateFlag,
	{ instructions: string; criteria?: { true?: string; false?: string } }
> = {
	durable: {
		instructions:
			"Would `candidate.fact` plausibly help an assistant serving `audience` in a future, separate conversation?",
	},
	transient: {
		instructions:
			"Is `candidate.fact` mainly temporary task state: intermediate results, the current step, one-off request details, or information that expires within days?",
	},
	duplicate: {
		instructions:
			"Does one of `relatedMemories` already state substantially the same information as `candidate.fact`, even if worded differently?",
		criteria: {
			false:
				"The candidate adds new details, changes a value, or no related memory covers it.",
		},
	},
	appropriateAudience: {
		instructions:
			"Is `candidate.fact` appropriate to store for the audience described in `audience`?",
	},
	sensitive: {
		instructions:
			"Does `candidate.fact` contain credentials, passwords, access tokens, API keys, private keys, payment card or bank credentials, one-time codes, or similarly exploitable secrets?",
	},
};

/** How both built-in gates classify an accepted fact. */
export const CATEGORY_QUESTION = {
	instructions: "Which kind of memory is `candidate.fact`?",
	criteria: {
		preference: "A person's or team's likes, dislikes, or preferred way of working.",
		decision: "A choice that was made, usually with its rationale.",
		fact: "A stable fact about a person, organization, product, customer, or system.",
		insight: "A lesson learned, pattern, or conclusion drawn from experience.",
		context: "Background on a situation, role, project, or ongoing work.",
		general: "None of the other kinds fit.",
	} satisfies Record<InsightCategory, string>,
};

/** Levels map to Mnemon importance 1 through 5, lowest first. */
export const IMPORTANCE_QUESTION = {
	instructions:
		"How much would an assistant serving `audience` lose in future conversations if it forgot `candidate.fact`?",
	criteria: [
		"Trivia or a passing detail; recalling it rarely changes an answer.",
		"Occasionally useful background, such as a minor preference or a peripheral fact.",
		"Useful working knowledge that regularly helps, such as a stated preference, a routine convention, or a standing fact about a project or system.",
		"Knowledge that shapes decisions or work, such as a team decision, an owner, or a firm requirement.",
		"Forgetting it would cause serious mistakes, such as a hard constraint, a safety or compliance rule, or a core decision others depend on.",
	],
};

/** Whether the candidate replaces related memory `i`; asked once per related memory. */
export function supersedeQuestion(i: number) {
	return {
		instructions: `Does \`candidate.fact\` make \`relatedMemories[${i}].content\` no longer true, for example by changing a value, reversing a decision, or naming a replacement?`,
		criteria: {
			false:
				"The candidate agrees with it, only adds detail, or is about a different subject.",
		},
	};
}

/** Keeps only a valid category and importance; anything else is omitted. */
export function classification(
	category: unknown,
	importance: unknown,
): Pick<MemoryGateDecision, "category" | "importance"> {
	const out: Pick<MemoryGateDecision, "category" | "importance"> = {};
	if (INSIGHT_CATEGORIES.includes(category as InsightCategory)) {
		out.category = category as InsightCategory;
	}
	const rounded = typeof importance === "number" ? Math.round(importance) : NaN;
	if (rounded >= 1 && rounded <= 5) {
		out.importance = rounded as 1 | 2 | 3 | 4 | 5;
	}
	return out;
}

export function gateState(input: MemoryGateInput) {
	return {
		candidate: { fact: input.fact, reason: input.reason ?? null },
		audience: input.audienceDescription,
		recentContext: input.recentContext,
		relatedMemories: input.relatedMemories,
	};
}

/** Accept only durable, non-transient, new, audience-appropriate, non-sensitive facts. */
export function decide(flags: Record<GateFlag, boolean>): MemoryGateDecision {
	const reasons: GateFlag[] = [];
	if (!flags.durable) reasons.push("durable");
	if (flags.transient) reasons.push("transient");
	if (flags.duplicate) reasons.push("duplicate");
	if (!flags.appropriateAudience) reasons.push("appropriateAudience");
	if (flags.sensitive) reasons.push("sensitive");
	return { accept: reasons.length === 0, reasons };
}

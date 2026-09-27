import type { InsightCategory } from "@romanbsd/mnemon-core";

import { decide, type MemoryGate, type MemoryGateDecision } from "./gate.js";

// ponytail: cheap pre-filter for obvious secrets; the provider rejects these
// before any gate so they never reach a model or the database.
export const SECRET_PATTERNS = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bgh[pousr]_[A-Za-z0-9]{36,}/,
	/\bsk-[A-Za-z0-9_-]{20,}/,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/,
	/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/,
	// Value must look generated (digit, symbol, or inner capital), so prose
	// like "Token: rotate every 90 days" still reaches the gate.
	/\b(?i:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*(?=\S*[\d_]|\S*[^\s\w]|\S+[A-Z])\S{6,}/,
];

const SECRET_WORD =
	/\b(?:pin|passcode|passphrase|password|passwords|combination|alarm code|door code|access code|security code|cvv|cvc|otp|one-time code|recovery code|seed phrase|iban|account number|card number)\b/i;
const SECRET_VALUE = /\d(?:[\s-]?\d){3,}|\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{12,}\b/;
const SECRET_STATEMENT = /\b(?:password|passphrase|passcode|pin|seed phrase)\s+(?:is|was|:)\s+\S/i;
const CARD_NUMBER = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,7}\b/;

const TRANSIENT = [
	/\b(?:right now|currently|at the moment|for now|so far|just now|in progress|halfway)\b/i,
	/\b(?:today|tonight|this (?:morning|afternoon|evening|week)|yesterday|tomorrow)\b/i,
	/\bstep \d+ (?:of|\/) \d+\b/i,
	/\b\d{1,3} ?(?:%|percent)\b/i,
	/\b(?:is|are|am|I'm|we're|it's) (?:running|uploading|downloading|exporting|loading|waiting|working on|deploying|building)\b/i,
	/\b(?:build|job|run|pipeline|ticket|task) #?\d{3,}\b/i,
];

const PERSONAL = [
	/\b(?:I|I'm|I've|I'd)\b/,
	/\b(?:my|me|mine)\b/i,
	/\bthe user\b|\buser's\b/i,
	/\b[A-Z][a-z]+(?:'s)?\s+(?:prefers|likes|dislikes|loves|hates|wants|enjoys|is allergic|works from|is based in|reports to)\b/,
	/\b(?:prefers|favou?rite|allergic)\b/i,
	/\b[A-Z][a-z]+'s (?:role|manager|team|preference|schedule|calendar)\b/,
];

const ORGANIZATION = [
	/\b(?:we|our|us)\b/i,
	/\b(?:the|this) (?:team|company|organi[sz]ation|department)\b/i,
	/\b(?:policy|process|procedure|convention|customers?|clients?|vendors?|production|staging|service|repository|repo|release|deploy(?:ment|s)?|approved by|owned by|must|required)\b/i,
];

const QUESTION = /\?\s*$/;
const SMALL_TALK = /^(?:thanks|thank you|ok|okay|hi|hello|great|sounds good|got it)\b/i;

const STOPWORDS = new Set(
	"a an the and or but of to in on at by for with from as is are was were be been it its this that these those there their they them then than so do does did has have had will would can could should may might not no".split(
		" ",
	),
);

function words(text: string): Set<string> {
	const out = new Set<string>();
	for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
		if (!STOPWORDS.has(w)) out.add(w);
	}
	return out;
}

/** Same memory: every candidate word already present, or near-identical word sets. */
function isDuplicate(fact: string, existing: string): boolean {
	const a = words(fact);
	const b = words(existing);
	if (a.size === 0) return false;
	let shared = 0;
	for (const w of a) if (b.has(w)) shared += 1;
	return shared === a.size || shared / (a.size + b.size - shared) >= 0.9;
}

const CATEGORY_RULES: [RegExp, InsightCategory][] = [
	[/\b(?:prefers?|likes?|dislikes?|favou?rite|would rather)\b/i, "preference"],
	[/\b(?:decided|decision|chose|agreed|we will|going forward|switched to|adopted)\b/i, "decision"],
	[/\b(?:learned|lesson|turns out|root cause|because)\b/i, "insight"],
	[/\b(?:working on|project|currently|role is|responsible for)\b/i, "context"],
];

function classify(fact: string): Pick<MemoryGateDecision, "category" | "importance"> {
	const category = CATEGORY_RULES.find(([re]) => re.test(fact))?.[1] ?? "fact";
	if (/\b(?:compliance|legal|gdpr|hipaa|safety|security|allergic|never)\b/i.test(fact)) {
		return { category, importance: 5 };
	}
	if (/\b(?:must|always|required|mandatory|policy|approved by|owns|owned by|decided)\b/i.test(fact)) {
		return { category, importance: 4 };
	}
	return { category, importance: 3 };
}

/**
 * Gate from local rules only: no model, no network, no cost. Reliable on
 * secrets, obvious task state, and near-verbatim duplicates; weak on whether a
 * fact will matter later, so it mostly trusts the model's decision to propose.
 * Never supersedes memories.
 */
export function heuristicGate(): MemoryGate {
	return (input) => {
		const fact = input.fact;
		const personal = PERSONAL.some((re) => re.test(fact));
		const organization = ORGANIZATION.some((re) => re.test(fact));
		const transient = TRANSIENT.some((re) => re.test(fact));
		const decision = decide({
			durable:
				!transient && !QUESTION.test(fact) && !SMALL_TALK.test(fact) && words(fact).size >= 3,
			transient,
			duplicate: input.relatedMemories.some((m) => isDuplicate(fact, m.content)),
			appropriateAudience:
				input.audience === "organization"
					? !personal || organization
					: personal || !organization,
			sensitive:
				SECRET_PATTERNS.some((re) => re.test(fact)) ||
				CARD_NUMBER.test(fact) ||
				SECRET_STATEMENT.test(fact) ||
				(SECRET_WORD.test(fact) && SECRET_VALUE.test(fact)),
		});
		return Promise.resolve(decision.accept ? { ...decision, ...classify(fact) } : decision);
	};
}

import type { EdgeType, RecallIntent } from "../types.js";
import {
	ENTITY_TERMS,
	INTENT_WEIGHTS,
	TRAVERSAL_LIMITS,
	WHEN_TERMS,
	WHY_TERMS,
} from "./constants.js";

// One alternation per list, like Go's regexp: matches never overlap, so
// "tell me about" counts once, not also as "about".
export function termPattern(terms: readonly string[]): RegExp {
	const ascii = terms.filter((t) => /^[\x20-\x7e]+$/.test(t));
	const other = terms.filter((t) => !ascii.includes(t));
	// An empty alternative would match everywhere, so leave empty lists out.
	const parts = [...other];
	if (ascii.length > 0) parts.unshift(`\\b(?:${ascii.join("|")})\\b`);
	return new RegExp(parts.join("|"), "g");
}

const WHY = termPattern(WHY_TERMS);
const WHEN = termPattern(WHEN_TERMS);
const ENTITY = termPattern(ENTITY_TERMS);

function countTerms(query: string, pattern: RegExp): number {
	return query.match(pattern)?.length ?? 0;
}

export function detectIntent(query: string): RecallIntent {
	const q = query.toLowerCase();
	const why = countTerms(q, WHY);
	const when = countTerms(q, WHEN);
	const entity = countTerms(q, ENTITY);
	if (why > when && why > entity && why > 0) {
		return "WHY";
	}
	if (when > why && when > entity && when > 0) {
		return "WHEN";
	}
	if (entity > 0) {
		return "ENTITY";
	}
	return "GENERAL";
}

export function intentWeights(intent: RecallIntent): Record<EdgeType, number> {
	return INTENT_WEIGHTS[intent];
}

export function traversalLimits(intent: RecallIntent): {
	beam: number;
	depth: number;
	visited: number;
} {
	return TRAVERSAL_LIMITS[intent];
}

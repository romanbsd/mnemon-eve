import type { CausalRelation, EdgeType } from "../types.js";
import {
	CAUSAL_MIN_OVERLAP,
	CAUSAL_PHRASES,
	ENABLES_PHRASES,
	PREVENTS_PHRASES,
	SEMANTIC_EDGE_MIN_COSINE,
} from "./constants.js";
import { intersectionCount } from "./similarity.js";
import { tokenize } from "./tokenize.js";

export interface NewEdge {
	sourceId: string;
	targetId: string;
	edgeType: EdgeType;
	weight: number;
	metadata: Record<string, string>;
}

function containsPhrase(text: string, phrases: readonly string[]): boolean {
	const lower = text.toLowerCase();
	return phrases.some((p) => lower.includes(p.toLowerCase()));
}

function hasCausalPhrase(text: string): boolean {
	return containsPhrase(text, CAUSAL_PHRASES);
}

function classifyCausalSubtype(
	text: string,
): "prevents" | "enables" | "causes" {
	if (containsPhrase(text, PREVENTS_PHRASES)) {
		return "prevents";
	}
	if (containsPhrase(text, ENABLES_PHRASES)) {
		return "enables";
	}
	return "causes";
}

function causalOverlap(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) {
		return 0;
	}
	return intersectionCount(a, b) / Math.max(a.size, b.size);
}

function temporalProximityWeight(hoursDiff: number): number {
	return 1 / (1 + Math.abs(hoursDiff));
}

function hoursDifference(a: Date, b: Date): number {
	return Math.abs(a.getTime() - b.getTime()) / 3_600_000;
}

function bidirectional(
	a: string,
	b: string,
	edgeType: EdgeType,
	weight: number,
	metadata: Record<string, string>,
	reverseMetadata: Record<string, string> = metadata,
): NewEdge[] {
	return [
		{ sourceId: a, targetId: b, edgeType, weight, metadata },
		{ sourceId: b, targetId: a, edgeType, weight, metadata: reverseMetadata },
	];
}

export function buildTemporalEdges(input: {
	newId: string;
	newCreatedAt: Date;
	latestSameSource?: { id: string };
	recentWithin24h: readonly { id: string; createdAt: Date }[];
}): NewEdge[] {
	const edges: NewEdge[] = [];
	if (input.latestSameSource && input.latestSameSource.id !== input.newId) {
		edges.push(
			...bidirectional(
				input.latestSameSource.id,
				input.newId,
				"temporal",
				1,
				{ sub_type: "backbone", direction: "precedes" },
				{ sub_type: "backbone", direction: "succeeds" },
			),
		);
	}
	const backboneId = input.latestSameSource?.id;
	for (const near of input.recentWithin24h) {
		if (near.id === backboneId || near.id === input.newId) {
			continue;
		}
		const hours = hoursDifference(input.newCreatedAt, near.createdAt);
		const weight = temporalProximityWeight(hours);
		const hoursDiff = hours.toFixed(2);
		edges.push(
			...bidirectional(input.newId, near.id, "temporal", weight, {
				sub_type: "proximity",
				hours_diff: hoursDiff,
			}),
		);
	}
	return edges;
}

export function buildEntityEdges(input: {
	newId: string;
	pairs: readonly { entity: string; targetId: string }[];
}): NewEdge[] {
	const edges: NewEdge[] = [];
	for (const pair of input.pairs) {
		if (pair.targetId === input.newId) {
			continue;
		}
		edges.push(
			...bidirectional(input.newId, pair.targetId, "entity", 1, {
				entity: pair.entity,
			}),
		);
	}
	return edges;
}

export function buildCausalEdges(input: {
	newId: string;
	newContent: string;
	previous: readonly { id: string; content: string }[];
}): NewEdge[] {
	const newTokens = tokenize(input.newContent);
	if (newTokens.size === 0) {
		return [];
	}
	const newHas = hasCausalPhrase(input.newContent);
	const edges: NewEdge[] = [];
	for (const prev of input.previous) {
		const prevHas = hasCausalPhrase(prev.content);
		if (!newHas && !prevHas) {
			continue;
		}
		const overlap = causalOverlap(newTokens, tokenize(prev.content));
		if (overlap < CAUSAL_MIN_OVERLAP) {
			continue;
		}
		let sourceId = prev.id;
		let targetId = input.newId;
		if (!newHas && prevHas) {
			sourceId = input.newId;
			targetId = prev.id;
		}
		edges.push({
			sourceId,
			targetId,
			edgeType: "causal",
			weight: overlap,
			metadata: {
				overlap: overlap.toFixed(4),
				sub_type: classifyCausalSubtype(`${input.newContent} ${prev.content}`),
			},
		});
	}
	return edges;
}

/**
 * Judges causal links between a new memory and earlier ones, keyed by earlier
 * id. `weight` is in (0, 1], e.g. the judge's probability. Content is user
 * data; implementations must not follow instructions inside it.
 */
export type CausalJudge = (input: {
	content: string;
	previous: readonly { id: string; content: string }[];
}) => Promise<
	Partial<Record<string, { relation: CausalRelation; weight: number }>>
>;

/** Causal edges from judged relations; `none` and invalid entries are dropped. */
export function buildJudgedCausalEdges(input: {
	newId: string;
	judgments: Awaited<ReturnType<CausalJudge>>;
}): NewEdge[] {
	const edges: NewEdge[] = [];
	for (const [id, judged] of Object.entries(input.judgments)) {
		const match = /^(existing|new)_(causes|enables|prevents)_/.exec(
			judged?.relation ?? "",
		);
		const weight = judged?.weight ?? 0;
		if (!match || !(weight > 0 && weight <= 1) || id === input.newId) {
			continue;
		}
		const fromExisting = match[1] === "existing";
		edges.push({
			sourceId: fromExisting ? id : input.newId,
			targetId: fromExisting ? input.newId : id,
			edgeType: "causal",
			weight,
			metadata: { sub_type: match[2] as string, created_by: "judge" },
		});
	}
	return edges;
}

export function buildSemanticEdges(input: {
	newId: string;
	neighbors: readonly { id: string; cosine: number }[];
}): NewEdge[] {
	const edges: NewEdge[] = [];
	for (const n of input.neighbors) {
		if (n.cosine < SEMANTIC_EDGE_MIN_COSINE || n.id === input.newId) {
			continue;
		}
		const cosine = n.cosine.toFixed(4);
		edges.push(
			...bidirectional(input.newId, n.id, "semantic", n.cosine, {
				created_by: "auto",
				cosine,
			}),
		);
	}
	return edges;
}

export function emptyEdgeCounts(): Record<EdgeType, number> {
	return { temporal: 0, semantic: 0, causal: 0, entity: 0 };
}

export function countEdgesByType(
	edges: readonly NewEdge[],
): Record<EdgeType, number> {
	const counts = emptyEdgeCounts();
	for (const edge of edges) {
		counts[edge.edgeType]++;
	}
	return counts;
}

import { createHash } from "node:crypto";

import { MAX_LOG_LIMIT } from "./engine/constants.js";
import {
	requireLimit,
	validateRememberInput,
	validateWeight,
} from "./engine/validate.js";
import { MnemonValidationError } from "./errors.js";
import {
	EDGE_TYPES,
	type EdgeType,
	type InsightCategory,
	type Mnemon,
	type RememberAction,
} from "./types.js";

/**
 * Memory draft file, schema version "1". Same JSON shape as Go mnemon's
 * `mnemon import`, so drafts written for it import unchanged.
 */
export interface MemoryDraft {
	schema_version: "1";
	/** Default source for every insight. Default "import". */
	source?: string;
	insights: {
		content: string;
		category?: InsightCategory;
		importance?: 1 | 2 | 3 | 4 | 5;
		tags?: string[];
		entities?: string[];
		source?: string;
		/** ISO 8601 with an explicit offset. Default: import time. */
		created_at?: string;
	}[];
	/** Explicit edges between insights, by zero-based index into `insights`. */
	edges?: {
		source_index: number;
		target_index: number;
		edge_type: EdgeType;
		/** Default 0.5. */
		weight?: number;
		/** Stored as edge metadata. */
		reason?: string;
	}[];
}

export interface ImportResult {
	/** Per draft insight, in order; `id` is the existing memory when skipped. */
	insights: { index: number; id: string; action: RememberAction }[];
	edges: number;
}

function invalid(field: string, message: string): never {
	throw new MnemonValidationError(`${field}: ${message}`, field, "invalid");
}

/** Checks the whole draft before anything is written. */
export function validateDraft(draft: MemoryDraft): void {
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- parsed JSON
	if (draft?.schema_version !== "1") {
		invalid("schema_version", `unsupported schema_version, expected "1"`);
	}
	if (!Array.isArray(draft.insights) || draft.insights.length === 0) {
		invalid("insights", "nothing to import");
	}
	draft.insights.forEach((insight, i) => {
		try {
			validateRememberInput(
				{ ...insight, createdAt: insight.created_at },
				{ category: "general", importance: 3, source: "import" },
			);
		} catch (error) {
			if (!(error instanceof MnemonValidationError)) throw error;
			throw new MnemonValidationError(
				`insights[${i}]: ${error.message}`,
				`insights[${i}].${error.field}`,
				error.code,
			);
		}
	});
	const n = draft.insights.length;
	(draft.edges ?? []).forEach((edge, i) => {
		const field = `edges[${i}]`;
		for (const key of ["source_index", "target_index"] as const) {
			if (!Number.isInteger(edge[key]) || edge[key] < 0 || edge[key] >= n) {
				invalid(`${field}.${key}`, `must be an index into insights [0, ${n})`);
			}
		}
		if (edge.source_index === edge.target_index) {
			invalid(field, "source_index and target_index must differ");
		}
		if (!EDGE_TYPES.includes(edge.edge_type)) {
			invalid(`${field}.edge_type`, `invalid edge_type "${edge.edge_type}"`);
		}
		validateWeight(edge.weight ?? 0.5, `${field}.weight`);
	});
}

/**
 * Imports a draft through the normal write path: dedupe, entities, automatic
 * edges, embeddings. Duplicates are skipped and their edges attach to the
 * existing memory. Atomic only inside `withAuthorization`; add `once` to make
 * a retry safe.
 */
export async function importDraft(
	mnemon: Mnemon,
	draft: MemoryDraft,
	options: { deduplicate?: boolean } = {},
): Promise<ImportResult> {
	validateDraft(draft);
	const insights: ImportResult["insights"] = [];
	for (const [index, insight] of draft.insights.entries()) {
		const saved = await mnemon.remember({
			content: insight.content,
			category: insight.category ?? "general",
			importance: insight.importance ?? 3,
			tags: insight.tags,
			entities: insight.entities,
			source: insight.source ?? draft.source ?? "import",
			createdAt: insight.created_at,
			deduplicate: options.deduplicate ?? true,
		});
		insights.push({
			index,
			id: saved.duplicateOf ?? saved.insight.id,
			action: saved.action,
		});
	}
	let edges = 0;
	for (const edge of draft.edges ?? []) {
		const sourceId = insights[edge.source_index]?.id;
		const targetId = insights[edge.target_index]?.id;
		// Two draft insights can collapse onto one existing memory.
		if (!sourceId || !targetId || sourceId === targetId) continue;
		await mnemon.link({
			sourceId,
			targetId,
			edgeType: edge.edge_type,
			weight: edge.weight ?? 0.5,
			metadata: edge.reason ? { reason: edge.reason } : undefined,
		});
		edges += 1;
	}
	return { insights, edges };
}

export interface MemoryReceipt {
	schema: "mnemon.memory.receipt.v1";
	generatedAt: string;
	count: number;
	privacy: { rawDetailIncluded: false; hashAlgorithm: "sha256"; note: string };
	events: {
		operation: string;
		createdAt: string;
		insightIdHash?: string;
		detailHash?: string;
		detailPresent: boolean;
	}[];
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Recent operations with ids and details replaced by SHA-256 hashes, so the
 * receipt can be shared for audits without exposing memory contents.
 */
export async function memoryReceipt(
	mnemon: Mnemon,
	options: { limit?: number; now?: Date } = {},
): Promise<MemoryReceipt> {
	const limit = requireLimit(options.limit ?? 20, MAX_LOG_LIMIT);
	const entries = await mnemon.log({ limit });
	return {
		schema: "mnemon.memory.receipt.v1",
		generatedAt: (options.now ?? new Date()).toISOString(),
		count: entries.length,
		privacy: {
			rawDetailIncluded: false,
			hashAlgorithm: "sha256",
			note: "Memory contents, queries, and operation details are omitted; only hashes and operation metadata are included.",
		},
		events: entries.map((entry) => {
			const detailPresent = Object.keys(entry.detail).length > 0;
			return {
				operation: entry.operation,
				createdAt: entry.createdAt,
				...(entry.insightId ? { insightIdHash: sha256(entry.insightId) } : {}),
				...(detailPresent ? { detailHash: sha256(JSON.stringify(entry.detail)) } : {}),
				detailPresent,
			};
		}),
	};
}

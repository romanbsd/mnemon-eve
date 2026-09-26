import { MnemonDatabaseError } from "../errors.js";
import type { Edge, Insight } from "../types.js";
import type { EdgeRecord, InsightRecord } from "./schema.js";

export function asDate(value: unknown, column = "timestamp"): Date {
	const date = value instanceof Date ? value : new Date(String(value));
	if (Number.isNaN(date.getTime())) {
		throw new MnemonDatabaseError(
			`database column ${column} is not a timestamp`,
		);
	}
	return date;
}

function asStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map(String);
	}
	return [];
}

function asRequiredString(value: unknown, column: string): string {
	if (typeof value === "string") {
		return value;
	}
	throw new MnemonDatabaseError(`database column ${column} is not text`);
}

function asStringMap(value: unknown): Record<string, string> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = String(v);
		}
		return out;
	}
	return {};
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function requireFiniteVector(
	parts: readonly unknown[],
	column: string,
): number[] {
	const out: number[] = [];
	for (const part of parts) {
		const token = String(part).trim();
		if (token.length === 0) {
			throw new MnemonDatabaseError(
				`database column ${column} is not a vector`,
			);
		}
		const n = Number(token);
		if (!Number.isFinite(n)) {
			throw new MnemonDatabaseError(
				`database column ${column} is not a vector`,
			);
		}
		out.push(n);
	}
	return out;
}

function asEmbedding(value: unknown): number[] | null {
	if (value == null) {
		return null;
	}
	if (Array.isArray(value)) {
		return requireFiniteVector(value, "embedding");
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			const inner = trimmed.slice(1, -1).trim();
			if (inner.length === 0) {
				return [];
			}
			return requireFiniteVector(inner.split(","), "embedding");
		}
	}
	return null;
}

export function mapInsightRow(row: Record<string, unknown>): InsightRecord {
	return {
		namespace: asRequiredString(row.namespace, "namespace"),
		id: String(row.id),
		content: String(row.content),
		normalizedContent: String(row.normalized_content),
		contentHash: String(row.content_hash),
		searchTokens: asStringArray(row.search_tokens),
		category: row.category as InsightRecord["category"],
		importance: Number(row.importance) as InsightRecord["importance"],
		tags: asStringArray(row.tags),
		entities: asStringArray(row.entities),
		source: String(row.source),
		metadata: asObject(row.metadata),
		managed: row.managed === true,
		accessCount: Number(row.access_count),
		storedAt: asDate(row.stored_at, "stored_at"),
		createdAt: asDate(row.created_at, "created_at"),
		updatedAt: asDate(row.updated_at, "updated_at"),
		deletedAt:
			row.deleted_at == null ? null : asDate(row.deleted_at, "deleted_at"),
		lastAccessedAt:
			row.last_accessed_at == null
				? null
				: asDate(row.last_accessed_at, "last_accessed_at"),
		embedding: asEmbedding(row.embedding),
		effectiveImportance: Number(row.effective_importance),
	};
}

export function mapEdgeRow(row: Record<string, unknown>): EdgeRecord {
	return {
		namespace: asRequiredString(row.namespace, "namespace"),
		sourceId: String(row.source_id),
		targetId: String(row.target_id),
		edgeType: row.edge_type as EdgeRecord["edgeType"],
		weight: Number(row.weight),
		metadata: asStringMap(row.metadata),
		createdAt: asDate(row.created_at, "created_at"),
	};
}

export function toPublicInsight(record: InsightRecord): Insight {
	const insight: Insight = {
		id: record.id,
		content: record.content,
		category: record.category,
		importance: record.importance,
		tags: record.tags,
		entities: record.entities,
		source: record.source,
		metadata: record.metadata,
		accessCount: record.accessCount,
		storedAt: record.storedAt.toISOString(),
		createdAt: record.createdAt.toISOString(),
		updatedAt: record.updatedAt.toISOString(),
	};
	if (record.deletedAt) {
		insight.deletedAt = record.deletedAt.toISOString();
	}
	return insight;
}

export function toPublicEdge(record: EdgeRecord): Edge {
	return {
		sourceId: record.sourceId,
		targetId: record.targetId,
		edgeType: record.edgeType,
		weight: record.weight,
		metadata: record.metadata,
		createdAt: record.createdAt.toISOString(),
	};
}

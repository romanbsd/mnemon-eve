import { MnemonValidationError } from "../errors.js";
import {
	EDGE_TYPES,
	type EdgeType,
	INSIGHT_CATEGORIES,
	type InsightCategory,
	RECALL_INTENTS,
	type RecallIntent,
} from "../types.js";
import {
	DEFAULT_BRIEF_EXCERPT_CHARS,
	DEFAULT_LIST_LIMIT,
	DEFAULT_LOG_LIMIT,
	DEFAULT_RETENTION_LIMIT,
	DEFAULT_RETENTION_THRESHOLD,
	DEFAULT_SEARCH_LIMIT,
	MAX_CONTENT_CODE_POINTS,
	MAX_ENTITIES,
	MAX_ENTITY_CODE_POINTS,
	MAX_LIST_LIMIT,
	MAX_LOG_LIMIT,
	MAX_RECALL_LIMIT,
	MAX_SEARCH_LIMIT,
	MAX_SOURCE_CODE_POINTS,
	MAX_TAG_CODE_POINTS,
	MAX_TAGS,
} from "./constants.js";
import { codePointLength, uniquePreserveOrder } from "./normalize.js";

export interface ValidatedRemember {
	content: string;
	category: InsightCategory;
	importance: 1 | 2 | 3 | 4 | 5;
	tags: string[];
	entities: string[];
	source: string;
	createdAt?: Date;
	deduplicate: boolean;
}

export function validateMetadata(
	value: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
	if (value == null) return {};
	if (typeof value !== "object" || Array.isArray(value)) {
		fail("metadata", "invalid", "metadata must be an object");
	}
	try {
		return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
	} catch {
		fail("metadata", "invalid", "metadata must be JSON serializable");
	}
}

export interface ValidatedRecall {
	query: string;
	limit: number;
	intent?: RecallIntent;
	source?: string;
	category?: InsightCategory;
	brief: boolean;
	excerptChars: number;
}

export interface ValidatedLink {
	sourceId: string;
	targetId: string;
	edgeType: EdgeType;
	weight: number;
	metadata: Record<string, string>;
}

function fail(field: string, code: string, message: string): never {
	throw new MnemonValidationError(message, field, code);
}

function requireNonEmptyTrimmed(
	value: string,
	field: string,
	max: number,
): string {
	const trimmed = value.trim();
	const len = codePointLength(trimmed);
	if (len < 1) {
		fail(field, "empty", `${field} must be non-empty`);
	}
	if (len > max) {
		fail(field, "too_long", `${field} exceeds ${max} code points`);
	}
	return trimmed;
}

function requireLimit(limit: number, max: number, field = "limit"): number {
	if (!Number.isInteger(limit) || limit < 1 || limit > max) {
		fail(
			field,
			"out_of_range",
			`${field} must be an integer from 1 through ${max}`,
		);
	}
	return limit;
}

function optionalTrimmed(
	value: string | undefined,
	field: string,
	max: number,
): string | undefined {
	return value ? requireNonEmptyTrimmed(value, field, max) : undefined;
}

function requireStringList(
	values: readonly string[] | undefined,
	field: string,
	maxItems: number,
	maxLen: number,
): string[] {
	if (!values) {
		return [];
	}
	const trimmed = values.map((v) => {
		if (typeof v !== "string") {
			fail(field, "invalid", `${field} must be strings`);
		}
		return requireNonEmptyTrimmed(v, field, maxLen);
	});
	const unique = uniquePreserveOrder(trimmed);
	if (unique.length > maxItems) {
		fail(field, "too_many", `${field} exceeds ${maxItems} unique values`);
	}
	return unique;
}

export function parseTimestamp(value: string, field: string): Date {
	if (!/([zZ]|[+-]\d{2}:\d{2})$/.test(value)) {
		fail(
			field,
			"invalid_timestamp",
			`${field} must include an explicit timezone offset`,
		);
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		fail(field, "invalid_timestamp", `${field} is not a valid timestamp`);
	}
	return date;
}

export function validateEmbedding(
	vector: readonly number[],
	dimensions: number,
	field = "embedding",
): number[] {
	if (vector.length !== dimensions) {
		fail(
			field,
			"dimension_mismatch",
			`${field} dimension ${vector.length} does not match ${dimensions}`,
		);
	}
	const copy: number[] = [];
	for (const n of vector) {
		if (!Number.isFinite(n)) {
			fail(field, "not_finite", `${field} must contain only finite numbers`);
		}
		copy.push(n);
	}
	return copy;
}

export function validateWeight(weight: number, field = "weight"): number {
	if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
		fail(
			field,
			"out_of_range",
			`${field} must be a finite number from 0 through 1`,
		);
	}
	return weight;
}

export interface ValidatedAuthorization {
	tenantId: string;
	userId: string | null;
	namespace: string;
}

function requireIdentifier(value: unknown, field: string, max: number): string {
	// Identifiers are compared verbatim by RLS; reject rather than trim.
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value !== value.trim() ||
		codePointLength(value) > max
	) {
		fail(
			field,
			"invalid",
			`${field} must be a non-blank string of at most ${max} characters without surrounding whitespace`,
		);
	}
	return value;
}

export function validateAuthorization(input: {
	tenantId: string;
	userId?: string | null;
	namespace: string;
}): ValidatedAuthorization {
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JavaScript callers
	if (input == null || typeof input !== "object") {
		fail("authorization", "invalid", "authorization must be an object");
	}
	return {
		tenantId: requireIdentifier(input.tenantId, "tenantId", 1024),
		userId:
			input.userId == null
				? null
				: requireIdentifier(input.userId, "userId", 1024),
		namespace: requireIdentifier(input.namespace, "namespace", 200),
	};
}

export function validateUuid(id: string, field: string): string {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			id,
		)
	) {
		fail(field, "invalid", `${field} must be a UUID`);
	}
	return id;
}

export function validateRememberInput(
	input: {
		content: string;
		category?: InsightCategory;
		importance?: 1 | 2 | 3 | 4 | 5;
		tags?: string[];
		entities?: string[];
		source?: string;
		createdAt?: string;
		deduplicate?: boolean;
	},
	defaults: {
		category: InsightCategory;
		importance: 1 | 2 | 3 | 4 | 5;
		source: string;
	},
): ValidatedRemember {
	const content = requireNonEmptyTrimmed(
		input.content,
		"content",
		MAX_CONTENT_CODE_POINTS,
	);
	const category = input.category ?? defaults.category;
	if (!INSIGHT_CATEGORIES.includes(category)) {
		fail(
			"category",
			"invalid_enum",
			`invalid category "${category}"; valid: ${INSIGHT_CATEGORIES.join(", ")}`,
		);
	}
	const importance = requireLimit(
		input.importance ?? defaults.importance,
		5,
		"importance",
	) as 1 | 2 | 3 | 4 | 5;
	return {
		content,
		category,
		importance,
		tags: requireStringList(input.tags, "tags", MAX_TAGS, MAX_TAG_CODE_POINTS),
		entities: requireStringList(
			input.entities,
			"entities",
			MAX_ENTITIES,
			MAX_ENTITY_CODE_POINTS,
		),
		source: requireNonEmptyTrimmed(
			input.source ?? defaults.source,
			"source",
			MAX_SOURCE_CODE_POINTS,
		),
		createdAt: input.createdAt
			? parseTimestamp(input.createdAt, "createdAt")
			: undefined,
		deduplicate: input.deduplicate !== false,
	};
}

export function validateRecallInput(
	input: {
		query: string;
		limit?: number;
		intent?: RecallIntent;
		source?: string;
		category?: InsightCategory;
		brief?: boolean;
		excerptChars?: number;
	},
	defaultLimit: number,
): ValidatedRecall {
	const query = requireNonEmptyTrimmed(
		input.query,
		"query",
		MAX_CONTENT_CODE_POINTS,
	);
	const limit = requireLimit(input.limit ?? defaultLimit, MAX_RECALL_LIMIT);
	if (input.intent && !RECALL_INTENTS.includes(input.intent)) {
		fail("intent", "invalid_enum", `invalid intent "${input.intent}"`);
	}
	validateCategoryFilter(input.category);
	const brief = input.brief === true;
	const excerptChars = requireLimit(
		input.excerptChars ?? DEFAULT_BRIEF_EXCERPT_CHARS,
		MAX_CONTENT_CODE_POINTS,
		"excerptChars",
	);
	return {
		query,
		limit,
		intent: input.intent,
		source: optionalTrimmed(input.source, "source", MAX_SOURCE_CODE_POINTS),
		category: input.category,
		brief,
		excerptChars,
	};
}

export function validateSearchInput(input: {
	query: string;
	limit?: number;
	source?: string;
}): {
	query: string;
	limit: number;
	source?: string;
} {
	const query = requireNonEmptyTrimmed(
		input.query,
		"query",
		MAX_CONTENT_CODE_POINTS,
	);
	const limit = requireLimit(
		input.limit ?? DEFAULT_SEARCH_LIMIT,
		MAX_SEARCH_LIMIT,
	);
	return {
		query,
		limit,
		source: optionalTrimmed(input.source, "source", MAX_SOURCE_CODE_POINTS),
	};
}

export function validateListInput(input?: {
	limit?: number;
	source?: string;
	category?: InsightCategory;
	since?: string;
	until?: string;
}): {
	limit: number;
	source?: string;
	category?: InsightCategory;
	since?: Date;
	until?: Date;
} {
	const limit = requireLimit(
		input?.limit ?? DEFAULT_LIST_LIMIT,
		MAX_LIST_LIMIT,
	);
	validateCategoryFilter(input?.category);
	const since = input?.since ? parseTimestamp(input.since, "since") : undefined;
	const until = input?.until ? parseTimestamp(input.until, "until") : undefined;
	if (since && until && since.getTime() > until.getTime()) {
		fail("until", "invalid_range", "until must be at or after since");
	}
	return {
		limit,
		source: optionalTrimmed(input?.source, "source", MAX_SOURCE_CODE_POINTS),
		category: input?.category,
		since,
		until,
	};
}

function validateCategoryFilter(category: InsightCategory | undefined): void {
	if (category && !INSIGHT_CATEGORIES.includes(category)) {
		fail(
			"category",
			"invalid_enum",
			`invalid category "${category}"; valid: ${INSIGHT_CATEGORIES.join(", ")}`,
		);
	}
}

export function validateRetentionInput(input?: {
	threshold?: number;
	limit?: number;
}): { threshold: number; limit: number } {
	const threshold = input?.threshold ?? DEFAULT_RETENTION_THRESHOLD;
	if (!Number.isFinite(threshold) || threshold < 0) {
		fail("threshold", "out_of_range", "threshold must be a finite number >= 0");
	}
	return {
		threshold,
		limit: requireLimit(input?.limit ?? DEFAULT_RETENTION_LIMIT, MAX_LIST_LIMIT),
	};
}

export function validateLogInput(input?: {
	limit?: number;
	operation?: string;
}): {
	limit: number;
	operation?: string;
} {
	const limit = requireLimit(input?.limit ?? DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT);
	return {
		limit,
		operation: optionalTrimmed(
			input?.operation,
			"operation",
			MAX_SOURCE_CODE_POINTS,
		),
	};
}

export function validateLinkInput(input: {
	sourceId: string;
	targetId: string;
	edgeType: EdgeType;
	weight?: number;
	metadata?: Record<string, string>;
}): ValidatedLink {
	const sourceId = validateUuid(input.sourceId, "sourceId");
	const targetId = validateUuid(input.targetId, "targetId");
	if (sourceId.toLowerCase() === targetId.toLowerCase()) {
		fail("targetId", "self_link", "cannot link an insight to itself");
	}
	if (!EDGE_TYPES.includes(input.edgeType)) {
		fail("edgeType", "invalid_enum", `invalid edgeType "${input.edgeType}"`);
	}
	const metadata = input.metadata ?? {};
	for (const v of Object.values(metadata)) {
		if (typeof v !== "string") {
			fail("metadata", "invalid", "metadata values must be strings");
		}
	}
	return {
		sourceId,
		targetId,
		edgeType: input.edgeType,
		weight: validateWeight(input.weight ?? 1),
		metadata,
	};
}

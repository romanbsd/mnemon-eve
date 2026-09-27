import type { PoolClient } from "pg";
import pgvector from "pgvector";

import { quoteIdent } from "../config.js";
import {
	ANCHOR_TOP_K,
	CAUSAL_LOOKBACK,
	GRAPH_LAMBDA1,
	GRAPH_LAMBDA2,
	MAX_ENTITY_LINKS,
	MAX_TEMPORAL_PROXIMITY,
	MAX_TOTAL_ENTITY_EDGES,
	RRF_K,
	SEARCH_FTS_WEIGHT,
	SEARCH_KEYWORD_WEIGHT,
	VECTOR_ANCHOR_MIN_COSINE,
} from "../engine/constants.js";
import { intentWeights, traversalLimits } from "../engine/intent.js";
import { uniquePreserveOrder } from "../engine/normalize.js";
import {
	MnemonConfigurationError,
	MnemonDatabaseError,
	MnemonNotFoundError,
} from "../errors.js";
import type { RecallIntent } from "../types.js";
import { asDate, mapEdgeRow, mapInsightRow } from "./row-mappers.js";
import type {
	AnchorHit,
	EdgeContext,
	EdgeRecord,
	GraphWalkHit,
	InsightRecord,
	KeywordHit,
	NewEdgeRecord,
	NewInsightRecord,
	OpLogRecord,
	RelatedWalkHit,
	ScoredInsight,
	SearchStoreHit,
	StoreCounts,
	VectorHit,
} from "./schema.js";
import { withSavepoint, wrapDatabaseError } from "./transaction.js";

const UNIQUE_VIOLATION = "23505";

const TOKEN_OVERLAP = `
      CROSS JOIN LATERAL (
          SELECT count(*) AS count
          FROM unnest(i.search_tokens) AS token
          WHERE token = ANY(q.tokens)
      ) AS matched`;

const TOKEN_OVERLAP_LEFT = `
      LEFT JOIN LATERAL (
          SELECT count(*) AS count
          FROM unnest(i.search_tokens) AS token
          WHERE token = ANY(q.tokens)
      ) AS matched ON true`;

const INSIGHT_COLS = `
          namespace, id, content, normalized_content, content_hash, search_tokens, category, importance,
          tags, entities, source, metadata, managed, access_count, stored_at, created_at, updated_at, deleted_at,
          last_accessed_at, effective_importance`;

function insightSelect(embedding: boolean): string {
	return embedding ? `${INSIGHT_COLS}, embedding` : INSIGHT_COLS;
}

export class UniqueViolationError extends Error {
	readonly code = UNIQUE_VIOLATION;
}

export function isUniqueViolation(error: unknown): boolean {
	if (error instanceof UniqueViolationError) {
		return true;
	}
	if (error instanceof MnemonDatabaseError && error.code === UNIQUE_VIOLATION) {
		return true;
	}
	return error instanceof Error && error.cause instanceof UniqueViolationError;
}

export interface MnemonStore {
	withTransaction<T>(fn: (tx: MnemonStoreTx) => Promise<T>): Promise<T>;
	getActiveInsight(id: string): Promise<InsightRecord | null>;
	findExactDuplicate(contentHash: string): Promise<InsightRecord | null>;
	findKeywordCandidates(
		queryTokens: readonly string[],
		limit: number,
	): Promise<KeywordHit[]>;
	nearestEmbeddings(
		vector: readonly number[],
		options: { excludeId?: string; limit: number; minCosine?: number },
	): Promise<VectorHit[]>;
	selectRecallAnchors(input: {
		queryTokens: readonly string[];
		queryVector?: readonly number[];
		limitPerSignal: number;
		source?: string;
	}): Promise<AnchorHit[]>;
	searchInsights(input: {
		query: string;
		queryTokens: readonly string[];
		limit: number;
		source?: string;
	}): Promise<SearchStoreHit[]>;
	listOps(input: { limit: number; operation?: string }): Promise<OpLogRecord[]>;
	listInsights(input: {
		limit: number;
		source?: string;
		category?: string;
		since?: Date;
		until?: Date;
	}): Promise<InsightRecord[]>;
	counts(): Promise<StoreCounts>;
	loadScoredInsights(input: {
		ids: readonly string[];
		queryTokens: readonly string[];
		queryEntities: readonly string[];
		queryVector?: readonly number[];
	}): Promise<ScoredInsight[]>;
	getEdgesForNodeIds(ids: readonly string[]): Promise<EdgeRecord[]>;
	knownEntities(words: readonly string[]): Promise<string[]>;
	walkRecallGraph(input: {
		anchors: readonly AnchorHit[];
		intent: RecallIntent;
		queryVector?: readonly number[];
		maxCandidates: number;
	}): Promise<GraphWalkHit[]>;
	walkRelated(input: {
		startId: string;
		maxDepth: number;
		limit: number;
		edgeType?: string;
	}): Promise<RelatedWalkHit[]>;
	loadEdgeContext(input: {
		excludeId: string;
		source: string;
		createdAt: Date;
		since: Date;
		until: Date;
		entities: readonly string[];
	}): Promise<EdgeContext>;
	/** Oldest active insights with no embedding, and how many there are in total. */
	listUnembedded(
		limit: number,
	): Promise<{ total: number; insights: InsightRecord[] }>;
	/** Every active insight with its edge count. */
	listRetentionRows(): Promise<{ insight: InsightRecord; edgeCount: number }[]>;
	getSetting(key: string): Promise<unknown>;
	/** Serializes concurrent callers of the same key until the transaction ends. */
	lockOperation(key: string): Promise<void>;
	getOperation(key: string): Promise<{ value: unknown } | undefined>;
	putOperation(key: string, result: unknown): Promise<void>;
	loadInsightsByIds(
		ids: readonly string[],
		options?: { embedding?: boolean },
	): Promise<InsightRecord[]>;
}

export interface MnemonStoreTx {
	insertInsight(record: NewInsightRecord): Promise<InsightRecord>;
	upsertManagedInsight(record: NewInsightRecord): Promise<InsightRecord>;
	upsertEdges(edges: readonly NewEdgeRecord[]): Promise<EdgeRecord[]>;
	/** Removes the backbone edges between two insights, both directions. */
	deleteBackbone(a: string, b: string): Promise<void>;
	appendOp(
		operation: string,
		insightId: string | null,
		detail: Record<string, unknown>,
		at: Date,
	): Promise<void>;
	setEffectiveImportance(id: string, value: number): Promise<void>;
	setEffectiveImportances(values: ReadonlyMap<string, number>): Promise<void>;
	/** Sets embeddings only where still missing; returns how many were set. */
	setMissingEmbeddings(values: ReadonlyMap<string, readonly number[]>): Promise<number>;
	/** Returns true when both settings were already stored. */
	establishEmbeddingSettings(
		dimensions: number,
		model: string,
		at: Date,
	): Promise<boolean>;
	deleteDerivedEdges(id: string): Promise<void>;
	linkAndLog(edge: NewEdgeRecord, at: Date): Promise<EdgeRecord>;
	forgetAndLog(id: string, at: Date): Promise<boolean>;
	prune(input: {
		oplogBefore?: Date;
		operationsBefore?: Date;
		forgottenBefore?: Date;
		limit: number;
	}): Promise<{ oplog: number; operations: number; forgotten: number }>;
	incrementAccess(ids: readonly string[], at: Date, by?: number): Promise<void>;
}

function vec(values: readonly number[]): string {
	const sql = pgvector.toSql([...values]);
	if (sql == null) {
		throw new Error("invalid embedding vector");
	}
	return sql;
}

function dbString(value: unknown, column: string): string {
	if (typeof value === "string") {
		return value;
	}
	throw new MnemonDatabaseError(`database column ${column} is not text`);
}

// Every driver failure leaves the store as MnemonDatabaseError, reads included.
function wrapQueries(client: PoolClient): PoolClient {
	return new Proxy(client, {
		get(target, prop, receiver) {
			if (prop !== "query") return Reflect.get(target, prop, receiver) as unknown;
			return (...args: unknown[]) =>
				(target.query as (...a: unknown[]) => Promise<unknown>)
					.apply(target, args)
					.catch((error: unknown) => {
						throw wrapDatabaseError(error);
					});
		},
	});
}

export class PostgresMnemonStore implements MnemonStore {
	private readonly s: string;
	private readonly client: PoolClient;

	/**
	 * `client` must already be inside an authorized transaction.
	 * `vectorDimensions` casts vector search to the HNSW index's type.
	 */
	constructor(
		client: PoolClient,
		schema: string,
		private readonly namespace: string,
		vectorDimensions?: number,
	) {
		this.client = wrapQueries(client);
		this.s = quoteIdent(schema);
		this.vectorType = vectorDimensions
			? `vector(${String(vectorDimensions)})`
			: "vector";
	}

	private readonly vectorType: string;

	async withTransaction<T>(fn: (tx: MnemonStoreTx) => Promise<T>): Promise<T> {
		return withSavepoint(this.client, async (client) =>
			fn(new PostgresMnemonStoreTx(client, this.s, this.namespace)),
		);
	}

	private edgeHopJoin(fromCol: string): string {
		return `
      JOIN ${this.s}.edges AS e
        ON e.namespace = $1
       AND (e.source_id = ${fromCol} OR e.target_id = ${fromCol})
      JOIN ${this.s}.insights AS neigh
        ON neigh.namespace = e.namespace
       AND neigh.id = CASE WHEN e.source_id = ${fromCol} THEN e.target_id ELSE e.source_id END
       AND neigh.deleted_at IS NULL`;
	}

	async getActiveInsight(id: string): Promise<InsightRecord | null> {
		return this.queryInsight("id = $2::uuid", [id]);
	}

	async loadInsightsByIds(
		ids: readonly string[],
		options?: { embedding?: boolean },
	): Promise<InsightRecord[]> {
		if (ids.length === 0) {
			return [];
		}
		return this.queryInsights("id = ANY($2::uuid[])", [ids], options);
	}

	async findExactDuplicate(contentHash: string): Promise<InsightRecord | null> {
		return this.queryInsight("content_hash = $2 AND managed = false", [
			contentHash,
		]);
	}

	private async queryInsights(
		where: string,
		params: unknown[],
		options?: { embedding?: boolean; orderLimit?: string },
	): Promise<InsightRecord[]> {
		const result = await this.client.query<Record<string, unknown>>(
			`SELECT ${insightSelect(options?.embedding === true)} FROM ${this.s}.insights WHERE namespace = $1 AND deleted_at IS NULL AND (${where}) ${options?.orderLimit ?? ""}`,
			[this.namespace, ...params],
		);
		return result.rows.map((row) => mapInsightRow(row));
	}

	private async queryInsight(
		where: string,
		params: unknown[],
	): Promise<InsightRecord | null> {
		const rows = await this.queryInsights(where, params);
		return rows[0] ?? null;
	}

	async findKeywordCandidates(
		queryTokens: readonly string[],
		limit: number,
	): Promise<KeywordHit[]> {
		if (queryTokens.length === 0) {
			return [];
		}
		const result = await this.client.query<Record<string, unknown>>(
			`
      WITH q AS (
          SELECT $2::text[] AS tokens, cardinality($2::text[]) AS token_count
      )
      SELECT i.id,
             matched.count::double precision / NULLIF(q.token_count, 0) AS keyword_score
      FROM ${this.s}.insights AS i
      CROSS JOIN q
      ${TOKEN_OVERLAP}
      WHERE i.deleted_at IS NULL
        AND i.namespace = $1
        AND q.token_count > 0
        AND i.search_tokens && q.tokens
      ORDER BY keyword_score DESC, i.importance DESC, i.created_at DESC, i.id ASC
      LIMIT $3
      `,
			[this.namespace, queryTokens, limit],
		);
		return result.rows.map((row) => ({
			id: String(row.id),
			keywordScore: Number(row.keyword_score),
		}));
	}

	async nearestEmbeddings(
		vector: readonly number[],
		options: { excludeId?: string; limit: number; minCosine?: number },
	): Promise<VectorHit[]> {
		const result = await this.client.query<Record<string, unknown>>(
			`
      SELECT id, 1 - (embedding::${this.vectorType} <=> $2::${this.vectorType}) AS cosine_similarity
      FROM ${this.s}.insights
      WHERE namespace = $1
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND ($3::uuid IS NULL OR id <> $3::uuid)
        AND ($5::float8 IS NULL OR 1 - (embedding::${this.vectorType} <=> $2::${this.vectorType}) >= $5)
      ORDER BY embedding::${this.vectorType} <=> $2::${this.vectorType}, id ASC
      LIMIT $4
      `,
			[
				this.namespace,
				vec(vector),
				options.excludeId ?? null,
				options.limit,
				options.minCosine ?? null,
			],
		);
		return result.rows.map((row) => ({
			id: String(row.id),
			cosineSimilarity: Number(row.cosine_similarity),
		}));
	}

	async selectRecallAnchors(input: {
		queryTokens: readonly string[];
		queryVector?: readonly number[];
		limitPerSignal: number;
		source?: string;
	}): Promise<AnchorHit[]> {
		const limit = input.limitPerSignal || ANCHOR_TOP_K;
		const result = await this.client.query<Record<string, unknown>>(
			`
      WITH
      q AS (
          SELECT $2::text[] AS tokens,
                 cardinality($2::text[]) AS token_count
      ),
      keyword_scored AS (
          SELECT i.id,
                 matched.count::double precision / NULLIF(q.token_count, 0) AS score
          FROM ${this.s}.insights AS i
          CROSS JOIN q
          ${TOKEN_OVERLAP}
          WHERE i.deleted_at IS NULL
            AND i.namespace = $1
            AND q.token_count > 0
            AND i.search_tokens && q.tokens
            AND ($5::text IS NULL OR i.source = $5)
      ),
      keyword_ranked AS (
          SELECT id, row_number() OVER (ORDER BY score DESC, id ASC) AS rank
          FROM keyword_scored
          ORDER BY score DESC, id ASC
          LIMIT $4
      ),
      vector_nearest AS (
          SELECT i.id, i.embedding::${this.vectorType} <=> $3::${this.vectorType} AS distance
          FROM ${this.s}.insights AS i
          WHERE $3::vector IS NOT NULL
            AND i.namespace = $1
            AND i.deleted_at IS NULL
            AND i.embedding IS NOT NULL
            AND 1 - (i.embedding::${this.vectorType} <=> $3::${this.vectorType}) > ${VECTOR_ANCHOR_MIN_COSINE}
            AND ($5::text IS NULL OR i.source = $5)
          ORDER BY i.embedding::${this.vectorType} <=> $3::${this.vectorType}, i.id ASC
          LIMIT $4
      ),
      vector_ranked AS (
          SELECT id, row_number() OVER (ORDER BY distance, id ASC) AS rank
          FROM vector_nearest
      ),
      time_ranked AS (
          SELECT id, row_number() OVER (ORDER BY created_at DESC, id ASC) AS rank
          FROM ${this.s}.insights
          WHERE namespace = $1
            AND deleted_at IS NULL
            AND ($5::text IS NULL OR source = $5)
          ORDER BY created_at DESC, id ASC
          LIMIT $4
      ),
      signals AS (
          SELECT id, rank, 'keyword'::text AS signal FROM keyword_ranked
          UNION ALL
          SELECT id, rank, 'vector'::text AS signal FROM vector_ranked
          UNION ALL
          SELECT id, rank, 'time'::text AS signal FROM time_ranked
      ),
      fused AS (
          SELECT id,
                 sum(1.0 / (${RRF_K} + rank)) AS raw_score,
                 array_agg(DISTINCT signal ORDER BY signal) AS signals
          FROM signals
          GROUP BY id
      ),
      normalized AS (
          SELECT id, raw_score / max(raw_score) OVER () AS score, signals
          FROM fused
      )
      SELECT n.id, n.score,
             CASE WHEN cardinality(n.signals) > 1 THEN 'hybrid' ELSE n.signals[1] END AS matched_via,
             n.signals
      FROM normalized AS n
      ORDER BY n.score DESC, n.id ASC
      `,
			[
				this.namespace,
				input.queryTokens,
				input.queryVector ? vec(input.queryVector) : null,
				limit,
				input.source ?? null,
			],
		);
		return result.rows.map(mapAnchor);
	}

	async searchInsights(input: {
		query: string;
		queryTokens: readonly string[];
		limit: number;
		source?: string;
	}): Promise<SearchStoreHit[]> {
		const result = await this.client.query<Record<string, unknown>>(
			`
      WITH q AS (
          SELECT $2::text[] AS tokens,
                 cardinality($2::text[]) AS token_count,
                 plainto_tsquery('english', $3) AS fts
      )
      SELECT i.id,
             COALESCE(matched.count, 0)::double precision / NULLIF(q.token_count, 0) AS keyword,
             CASE WHEN q.fts <> ''::tsquery THEN ts_rank_cd(i.search_tsv, q.fts) ELSE 0 END AS fts
      FROM ${this.s}.insights AS i
      CROSS JOIN q
      ${TOKEN_OVERLAP_LEFT}
      WHERE i.deleted_at IS NULL
        AND i.namespace = $1
        AND ($5::text IS NULL OR i.source = $5)
        AND (
          (q.token_count > 0 AND i.search_tokens && q.tokens)
          OR (q.fts <> ''::tsquery AND i.search_tsv @@ q.fts)
        )
      ORDER BY
        (COALESCE(matched.count, 0)::double precision / NULLIF(q.token_count, 0) * ${SEARCH_KEYWORD_WEIGHT}
         + CASE WHEN q.fts <> ''::tsquery THEN ts_rank_cd(i.search_tsv, q.fts) ELSE 0 END * ${SEARCH_FTS_WEIGHT}) DESC NULLS LAST,
        i.id ASC
      LIMIT $4
      `,
			[
				this.namespace,
				input.queryTokens,
				input.query,
				input.limit,
				input.source ?? null,
			],
		);
		return result.rows.map((row) => ({
			id: String(row.id),
			keyword: Number(row.keyword ?? 0) || 0,
			fts: Number(row.fts ?? 0) || 0,
		}));
	}

	async listInsights(input: {
		limit: number;
		source?: string;
		category?: string;
		since?: Date;
		until?: Date;
	}): Promise<InsightRecord[]> {
		const result = await this.client.query<Record<string, unknown>>(
			`
      SELECT ${insightSelect(false)}
      FROM ${this.s}.insights
      WHERE namespace = $1
        AND deleted_at IS NULL
        AND ($3::text IS NULL OR source = $3)
        AND ($4::text IS NULL OR category = $4)
        AND ($5::timestamptz IS NULL OR created_at >= $5)
        AND ($6::timestamptz IS NULL OR created_at <= $6)
      ORDER BY created_at DESC, id ASC
      LIMIT $2
      `,
			[
				this.namespace,
				input.limit,
				input.source ?? null,
				input.category ?? null,
				input.since ?? null,
				input.until ?? null,
			],
		);
		return result.rows.map((row) => mapInsightRow(row));
	}

	async listOps(input: {
		limit: number;
		operation?: string;
	}): Promise<OpLogRecord[]> {
		const result = await this.client.query<Record<string, unknown>>(
			`
      SELECT id, operation, insight_id, detail, created_at
      FROM ${this.s}.oplog
      WHERE namespace = $1
        AND ($3::text IS NULL OR operation = $3)
      ORDER BY created_at DESC, id DESC
      LIMIT $2
      `,
			[this.namespace, input.limit, input.operation ?? null],
		);
		return result.rows.map((row) => ({
			namespace: this.namespace,
			id: String(row.id),
			operation: String(row.operation),
			insightId:
				row.insight_id == null ? null : dbString(row.insight_id, "insight_id"),
			detail: (row.detail ?? {}) as Record<string, unknown>,
			createdAt: asDate(row.created_at, "created_at"),
		}));
	}

	async counts(): Promise<StoreCounts> {
		const result = await this.client.query<Record<string, unknown>>(
			`
      SELECT
        (SELECT count(*)::int FROM ${this.s}.insights WHERE namespace = $1 AND deleted_at IS NULL) AS insights,
        (SELECT count(*)::int FROM ${this.s}.insights WHERE namespace = $1 AND deleted_at IS NULL AND embedding IS NOT NULL) AS embeddings,
        (SELECT count(*)::int FROM ${this.s}.edges WHERE namespace = $1) AS edges
      `,
			[this.namespace],
		);
		const row = result.rows[0] ?? {};
		return {
			insights: Number(row.insights ?? 0),
			embeddings: Number(row.embeddings ?? 0),
			edges: Number(row.edges ?? 0),
		};
	}

	async loadScoredInsights(input: {
		ids: readonly string[];
		queryTokens: readonly string[];
		queryEntities: readonly string[];
		queryVector?: readonly number[];
	}): Promise<ScoredInsight[]> {
		if (input.ids.length === 0) {
			return [];
		}
		const queryEntities = uniquePreserveOrder(
			input.queryEntities
				.map((e) => e.toLowerCase())
				.filter((e) => e.length > 0),
		);
		const result = await this.client.query<Record<string, unknown>>(
			`
      SELECT ${insightSelect(false)},
             COALESCE(tok.count, 0)::double precision / NULLIF(cardinality($3::text[]), 0) AS keyword,
             COALESCE(ent.count, 0)::double precision / GREATEST(1, cardinality($4::text[])) AS entity,
             CASE
               WHEN $5::vector IS NULL OR i.embedding IS NULL THEN 0
               ELSE GREATEST(0, 1 - (i.embedding <=> $5::vector))
             END AS similarity
      FROM ${this.s}.insights AS i
      LEFT JOIN LATERAL (
          SELECT count(*) AS count
          FROM unnest(i.search_tokens) AS token
          WHERE token = ANY($3::text[])
      ) AS tok ON true
      LEFT JOIN LATERAL (
          SELECT count(*) AS count
          FROM jsonb_array_elements_text(i.entities) AS e
          WHERE lower(e) = ANY($4::text[])
      ) AS ent ON true
      WHERE i.deleted_at IS NULL
        AND i.namespace = $1
        AND i.id = ANY($2::uuid[])
      `,
			[
				this.namespace,
				input.ids,
				input.queryTokens,
				queryEntities,
				input.queryVector ? vec(input.queryVector) : null,
			],
		);
		return result.rows.map((row) => {
			const rec = row;
			return {
				insight: mapInsightRow(rec),
				signals: {
					id: String(rec.id),
					keyword: Number(rec.keyword ?? 0) || 0,
					entity: Number(rec.entity ?? 0) || 0,
					similarity: Number(rec.similarity ?? 0) || 0,
				},
			};
		});
	}

	async walkRelated(input: {
		startId: string;
		maxDepth: number;
		limit: number;
		edgeType?: string;
	}): Promise<RelatedWalkHit[]> {
		const seen = new Set<string>([input.startId]);
		let frontier = [input.startId];
		const hits: RelatedWalkHit[] = [];
		for (
			let depth = 1;
			depth <= input.maxDepth && frontier.length > 0 && hits.length < input.limit;
			depth++
		) {
			const hop = await this.client.query<Record<string, unknown>>(
				`
        SELECT * FROM (
            SELECT DISTINCT ON (neigh.id) neigh.id, e.weight, e.edge_type AS via
            FROM unnest($2::uuid[]) AS f(id)
            ${this.edgeHopJoin("f.id")}
            WHERE ($3::text IS NULL OR e.edge_type = $3)
              AND NOT neigh.id = ANY ($4::uuid[])
            ORDER BY neigh.id, e.created_at ASC, e.ctid ASC
        ) AS hop
        -- Same order as the final sort, so capping a hop never changes the result.
        ORDER BY weight DESC, id ASC
        LIMIT $5
        `,
				[
					this.namespace,
					frontier,
					input.edgeType ?? null,
					[...seen],
					input.limit - hits.length,
				],
			);
			frontier = [];
			for (const row of hop.rows) {
				const id = String(row.id);
				if (seen.has(id)) {
					continue;
				}
				seen.add(id);
				frontier.push(id);
				hits.push({
					id,
					depth,
					weight: Number(row.weight),
					viaEdgeType: row.via == null ? undefined : dbString(row.via, "via"),
				});
			}
		}
		return hits
			.sort(
				(a, b) =>
					a.depth - b.depth || b.weight - a.weight || a.id.localeCompare(b.id),
			)
			.slice(0, input.limit);
	}

	async loadEdgeContext(input: {
		excludeId: string;
		source: string;
		createdAt: Date;
		since: Date;
		until: Date;
		entities: readonly string[];
	}): Promise<EdgeContext> {
		const result = await this.client.query<Record<string, unknown>>(
			`
      WITH
      latest AS (
          SELECT id, content, created_at
          FROM ${this.s}.insights
          WHERE namespace = $1 AND deleted_at IS NULL AND id <> $2::uuid AND source = $3
            AND created_at <= $9
          ORDER BY created_at DESC, id ASC
          LIMIT 1
      ),
      following AS (
          SELECT id, content, created_at
          FROM ${this.s}.insights
          WHERE namespace = $1 AND deleted_at IS NULL AND id <> $2::uuid AND source = $3
            AND created_at > $9
          ORDER BY created_at ASC, id ASC
          LIMIT 1
      ),
      windowed AS (
          SELECT id, content, created_at
          FROM ${this.s}.insights
          WHERE namespace = $1 AND deleted_at IS NULL AND id <> $2::uuid
            AND created_at >= $4 AND created_at <= $10
          ORDER BY created_at DESC, id ASC
          LIMIT $5
      ),
      causal AS (
          SELECT id, content, created_at
          FROM ${this.s}.insights
          WHERE namespace = $1 AND deleted_at IS NULL AND id <> $2::uuid AND source = $3
          ORDER BY created_at DESC, id ASC
          LIMIT $6
      ),
      entity_ranked AS (
          SELECT e.entity, e.ord, i.id AS target_id,
                 row_number() OVER (PARTITION BY e.entity ORDER BY i.created_at DESC, i.id ASC) AS rn
          FROM unnest($7::text[]) WITH ORDINALITY AS e(entity, ord)
          JOIN ${this.s}.insights AS i
            ON i.namespace = $1
           AND i.deleted_at IS NULL
           AND i.id <> $2::uuid
           -- Matches insights_entities_lower_gin_idx.
           AND lower(i.entities::text)::jsonb @> jsonb_build_array(lower(e.entity))
      )
      SELECT 'latest' AS bucket, id, content, created_at, NULL::text AS entity, NULL::uuid AS target_id, NULL::int AS ord, NULL::int AS rn
      FROM latest
      UNION ALL
      SELECT 'next', id, content, created_at, NULL::text, NULL::uuid, NULL::int, NULL::int FROM following
      UNION ALL
      SELECT 'window', id, content, created_at, NULL::text, NULL::uuid, NULL::int, NULL::int FROM windowed
      UNION ALL
      SELECT 'causal', id, content, created_at, NULL::text, NULL::uuid, NULL::int, NULL::int FROM causal
      UNION ALL
      SELECT 'entity', NULL::uuid, NULL::text, NULL::timestamptz, entity, target_id, ord::int, rn::int
      FROM entity_ranked
      WHERE rn <= $8
      ORDER BY bucket, created_at DESC NULLS LAST, ord ASC NULLS LAST, rn ASC NULLS LAST, id ASC NULLS LAST
      `,
			[
				this.namespace,
				input.excludeId,
				input.source,
				input.since,
				MAX_TEMPORAL_PROXIMITY,
				CAUSAL_LOOKBACK,
				input.entities,
				MAX_ENTITY_LINKS,
				input.createdAt,
				input.until,
			],
		);

		const context: EdgeContext = {
			recentWithin24h: [],
			causalPrevious: [],
			entityPairs: [],
		};
		const maxPairs = MAX_TOTAL_ENTITY_EDGES / 2;
		for (const row of result.rows) {
			const bucket = String(row.bucket);
			if (bucket === "latest" && row.id) {
				context.latestSameSource = {
					id: dbString(row.id, "id"),
					content: dbString(row.content, "content"),
					createdAt: asDate(row.created_at, "created_at"),
				};
			} else if (bucket === "next" && row.id) {
				context.nextSameSource = {
					id: dbString(row.id, "id"),
					content: dbString(row.content, "content"),
					createdAt: asDate(row.created_at, "created_at"),
				};
			} else if (bucket === "window" && row.id) {
				context.recentWithin24h.push({
					id: dbString(row.id, "id"),
					content: dbString(row.content, "content"),
					createdAt: asDate(row.created_at, "created_at"),
				});
			} else if (bucket === "causal" && row.id) {
				context.causalPrevious.push({
					id: dbString(row.id, "id"),
					content: dbString(row.content, "content"),
				});
			} else if (
				bucket === "entity" &&
				row.entity &&
				row.target_id &&
				context.entityPairs.length < maxPairs
			) {
				context.entityPairs.push({
					entity: dbString(row.entity, "entity"),
					targetId: dbString(row.target_id, "target_id"),
				});
			}
		}
		return context;
	}

	async getEdgesForNodeIds(ids: readonly string[]): Promise<EdgeRecord[]> {
		if (ids.length === 0) {
			return [];
		}
		const result = await this.client.query<Record<string, unknown>>(
			`
      SELECT * FROM ${this.s}.edges
      WHERE namespace = $1
        AND (source_id = ANY($2::uuid[]) OR target_id = ANY($2::uuid[]))
      `,
			[this.namespace, ids],
		);
		return result.rows.map((row) => mapEdgeRow(row));
	}

	async knownEntities(words: readonly string[]): Promise<string[]> {
		if (words.length === 0) {
			return [];
		}
		const result = await this.client.query<Record<string, unknown>>(
			`
      SELECT w AS entity
      FROM unnest($2::text[]) AS w
      WHERE EXISTS (
          SELECT 1 FROM ${this.s}.insights AS i
          WHERE i.namespace = $1
            AND i.deleted_at IS NULL
            AND i.entities @> jsonb_build_array(w)
      )
      `,
			[this.namespace, [...new Set(words)]],
		);
		return result.rows.map((row) => dbString(row.entity, "entity"));
	}

	async walkRecallGraph(input: {
		anchors: readonly AnchorHit[];
		intent: RecallIntent;
		queryVector?: readonly number[];
		maxCandidates: number;
	}): Promise<GraphWalkHit[]> {
		if (input.anchors.length === 0) {
			return [];
		}
		const limits = traversalLimits(input.intent);
		const weights = intentWeights(input.intent);
		const best = new Map<string, { score: number; via: string }>();
		for (const anchor of input.anchors) {
			best.set(anchor.id, { score: anchor.score, via: anchor.matchedVia });
		}
		const seen = new Map<string, Set<string>>();
		let frontier = input.anchors.map((anchor) => ({
			id: anchor.id,
			anchorId: anchor.id,
			score: anchor.score,
		}));
		for (const anchor of input.anchors) {
			seen.set(anchor.id, new Set([anchor.id]));
		}

		for (let depth = 0; depth < limits.depth && frontier.length > 0; depth++) {
			const open = frontier.filter(
				(row) => (seen.get(row.anchorId)?.size ?? 0) < limits.visited,
			);
			if (open.length === 0) {
				break;
			}
			const hop = await this.client.query<Record<string, unknown>>(
				`
        SELECT s.anchor_id, neigh.id,
               s.score + $2::float8 * COALESCE(($3::jsonb ->> e.edge_type)::float8, 0) * e.weight
                        + $4::float8 * CASE
                          WHEN $5::vector IS NULL OR neigh.embedding IS NULL THEN 0::float8
                          ELSE GREATEST(0::float8, 1 - (neigh.embedding <=> $5::vector))
                        END AS score,
               e.edge_type AS via
        FROM unnest($6::uuid[], $7::uuid[], $8::float8[]) AS s(id, anchor_id, score)
        ${this.edgeHopJoin("s.id")}
        ORDER BY 3 DESC, neigh.id ASC, s.anchor_id ASC, e.edge_type ASC
        `,
				[
					this.namespace,
					GRAPH_LAMBDA1,
					JSON.stringify(weights),
					GRAPH_LAMBDA2,
					input.queryVector ? vec(input.queryVector) : null,
					open.map((row) => row.id),
					open.map((row) => row.anchorId),
					open.map((row) => row.score),
				],
			);

			const nextByAnchor = new Map<
				string,
				{ id: string; score: number }[]
			>();
			for (const row of hop.rows) {
				const id = String(row.id);
				const anchorId = String(row.anchor_id);
				const score = Number(row.score);
				const via = String(row.via);
				const prev = best.get(id);
				if (!prev || score > prev.score) {
					best.set(id, { score, via });
				}
				const local = seen.get(anchorId) ?? new Set<string>();
				if (local.has(id) || local.size >= limits.visited) {
					continue;
				}
				local.add(id);
				seen.set(anchorId, local);
				const bucket = nextByAnchor.get(anchorId) ?? [];
				bucket.push({ id, score });
				nextByAnchor.set(anchorId, bucket);
			}

			frontier = [];
			for (const [anchorId, bucket] of nextByAnchor) {
				bucket.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
				for (const row of bucket.slice(0, limits.beam)) {
					frontier.push({ id: row.id, anchorId, score: row.score });
				}
			}
		}

		return [...best.entries()]
			.sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
			.slice(0, input.maxCandidates)
			.map(([id, row]) => ({ id, score: row.score, via: row.via }));
	}

	async listUnembedded(
		limit: number,
	): Promise<{ total: number; insights: InsightRecord[] }> {
		const [insights, count] = await Promise.all([
			this.queryInsights("embedding IS NULL", [limit], {
				orderLimit: "ORDER BY created_at ASC, id ASC LIMIT $2",
			}),
			this.client.query<{ total: number }>(
				`SELECT count(*)::int AS total FROM ${this.s}.insights WHERE namespace = $1 AND deleted_at IS NULL AND embedding IS NULL`,
				[this.namespace],
			),
		]);
		return { total: count.rows[0]?.total ?? 0, insights };
	}

	// ponytail: loads the whole namespace; page by effective_importance if namespaces grow past ~100k rows.
	async listRetentionRows(): Promise<
		{ insight: InsightRecord; edgeCount: number }[]
	> {
		const result = await this.client.query<Record<string, unknown>>(
			`
      WITH ends AS (
        SELECT source_id AS id FROM ${this.s}.edges WHERE namespace = $1
        UNION ALL
        SELECT target_id FROM ${this.s}.edges WHERE namespace = $1 AND target_id <> source_id
      ), counts AS (SELECT id, count(*) AS n FROM ends GROUP BY id)
      SELECT ${insightSelect(false)}, coalesce(c.n, 0) AS edge_count
      FROM ${this.s}.insights AS i
      LEFT JOIN counts AS c USING (id)
      WHERE i.namespace = $1 AND i.deleted_at IS NULL
      `,
			[this.namespace],
		);
		return result.rows.map((row) => ({
			insight: mapInsightRow(row),
			edgeCount: Number(row.edge_count),
		}));
	}

	async getSetting(key: string): Promise<unknown> {
		const result = await this.client.query<Record<string, unknown>>(
			`SELECT value FROM ${this.s}.settings WHERE key = $1`,
			[key],
		);
		return result.rows[0]?.value;
	}

	async lockOperation(key: string): Promise<void> {
		await this.client.query(
			`SELECT pg_advisory_xact_lock(hashtextextended(
         jsonb_build_array(current_setting('mnemon.tenant_id'), $1::text, $2::text)::text, 0))`,
			[this.namespace, key],
		);
	}

	async getOperation(key: string): Promise<{ value: unknown } | undefined> {
		const result = await this.client.query<Record<string, unknown>>(
			`SELECT result FROM ${this.s}.operations WHERE namespace = $1 AND key = $2`,
			[this.namespace, key],
		);
		const row = result.rows[0];
		return row ? { value: row.result } : undefined;
	}

	async putOperation(key: string, result: unknown): Promise<void> {
		await this.client.query(
			`INSERT INTO ${this.s}.operations (namespace, key, result) VALUES ($1, $2, $3::jsonb)`,
			[this.namespace, key, JSON.stringify(result)],
		);
	}
}

function insertInsightSql(s: string): string {
	return `
      INSERT INTO ${s}.insights (
        namespace, id, content, normalized_content, content_hash, search_tokens, category, importance,
        tags, entities, source, metadata, managed, created_at, updated_at, embedding, effective_importance
      ) VALUES (
        $1, $2::uuid, $3, $4, $5, $6::text[], $7, $8, $9::jsonb, $10::jsonb, $11, $12::jsonb, $13, $14, $15, $16::vector, $17
      )`;
}

function insightParams(namespace: string, record: NewInsightRecord): unknown[] {
	return [
		namespace,
		record.id,
		record.content,
		record.normalizedContent,
		record.contentHash,
		record.searchTokens,
		record.category,
		record.importance,
		JSON.stringify(record.tags),
		JSON.stringify(record.entities),
		record.source,
		JSON.stringify(record.metadata),
		record.managed,
		record.createdAt,
		record.updatedAt,
		record.embedding ? vec(record.embedding) : null,
		record.effectiveImportance,
	];
}

class PostgresMnemonStoreTx implements MnemonStoreTx {
	constructor(
		private readonly client: PoolClient,
		private readonly s: string,
		private readonly namespace: string,
	) {}

	async insertInsight(record: NewInsightRecord): Promise<InsightRecord> {
		try {
			const result = await this.client.query<Record<string, unknown>>(
				`${insertInsightSql(this.s)} RETURNING ${insightSelect(true)}`,
				insightParams(this.namespace, record),
			);
			const row = result.rows[0];
			if (!row) {
				throw new MnemonDatabaseError("insert did not return an insight");
			}
			const inserted = mapInsightRow(row);
			inserted.embedding = record.embedding;
			return inserted;
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code === UNIQUE_VIOLATION) {
				throw new UniqueViolationError("active content hash already exists");
			}
			throw wrapDatabaseError(error);
		}
	}

	async upsertManagedInsight(record: NewInsightRecord): Promise<InsightRecord> {
		const result = await this.client.query<Record<string, unknown>>(
			`
      ${insertInsightSql(this.s)}
      ON CONFLICT (tenant_id, namespace, id) DO UPDATE SET
        content = EXCLUDED.content,
        normalized_content = EXCLUDED.normalized_content,
        content_hash = EXCLUDED.content_hash,
        search_tokens = EXCLUDED.search_tokens,
        category = EXCLUDED.category,
        importance = EXCLUDED.importance,
        tags = EXCLUDED.tags,
        entities = EXCLUDED.entities,
        source = EXCLUDED.source,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL,
        embedding = EXCLUDED.embedding,
        effective_importance = EXCLUDED.effective_importance
      WHERE ${this.s}.insights.managed = true
      RETURNING ${insightSelect(true)}
      `,
			insightParams(this.namespace, { ...record, managed: true }),
		);
		const row = result.rows[0];
		if (!row) {
			throw new MnemonDatabaseError(
				`insight ${record.id} is not managed and cannot be replaced`,
			);
		}
		const persisted = mapInsightRow(row);
		persisted.embedding = record.embedding;
		return persisted;
	}

	private async lockActiveInsightIds(
		ids: readonly string[],
	): Promise<Set<string>> {
		const unique = [...new Set(ids)].sort();
		if (unique.length === 0) {
			return new Set();
		}
		const result = await this.client.query<{
			id: string;
			deleted_at: Date | null;
		}>(
			`
      SELECT id, deleted_at
      FROM ${this.s}.insights
      WHERE namespace = $1
        AND id = ANY($2::uuid[])
      ORDER BY id
      FOR UPDATE
      `,
			[this.namespace, unique],
		);
		return new Set(
			result.rows.filter((row) => row.deleted_at == null).map((row) => row.id),
		);
	}

	async upsertEdges(edges: readonly NewEdgeRecord[]): Promise<EdgeRecord[]> {
		if (edges.length === 0) {
			return [];
		}
		const unique = new Map<string, NewEdgeRecord>();
		for (const edge of edges) {
			unique.set(`${edge.sourceId}\0${edge.targetId}\0${edge.edgeType}`, edge);
		}
		const active = await this.lockActiveInsightIds(
			[...unique.values()].flatMap((edge) => [edge.sourceId, edge.targetId]),
		);
		const deduped = [...unique.values()].filter(
			(edge) => active.has(edge.sourceId) && active.has(edge.targetId),
		);
		return this.upsertEdgeRows(deduped);
	}

	async deleteDerivedEdges(id: string): Promise<void> {
		await this.client.query(
			`DELETE FROM ${this.s}.edges
       WHERE namespace = $1 AND derived AND (source_id = $2::uuid OR target_id = $2::uuid)`,
			[this.namespace, id],
		);
	}

	async deleteBackbone(a: string, b: string): Promise<void> {
		await this.client.query(
			`DELETE FROM ${this.s}.edges
       WHERE namespace = $1 AND edge_type = 'temporal' AND metadata->>'sub_type' = 'backbone'
         AND ((source_id = $2::uuid AND target_id = $3::uuid) OR (source_id = $3::uuid AND target_id = $2::uuid))`,
			[this.namespace, a, b],
		);
	}

	private async upsertEdgeRows(
		edges: readonly NewEdgeRecord[],
	): Promise<EdgeRecord[]> {
		if (edges.length === 0) {
			return [];
		}
		const sourceIds = edges.map((e) => e.sourceId);
		const targetIds = edges.map((e) => e.targetId);
		const types = edges.map((e) => e.edgeType);
		const weights = edges.map((e) => e.weight);
		const metas = edges.map((e) => JSON.stringify(e.metadata));
		const created = edges.map((e) => e.createdAt);
		const derived = edges.map((e) => e.derived ?? false);
		const result = await this.client.query<Record<string, unknown>>(
			`
      INSERT INTO ${this.s}.edges (namespace, source_id, target_id, edge_type, weight, metadata, created_at, derived)
      SELECT $1, edge_rows.*
      FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::float8[], $6::jsonb[], $7::timestamptz[], $8::boolean[])
        AS edge_rows(source_id, target_id, edge_type, weight, metadata, created_at, derived)
      ON CONFLICT (tenant_id, namespace, source_id, target_id, edge_type)
      DO UPDATE SET
          weight = EXCLUDED.weight,
          metadata = EXCLUDED.metadata,
          created_at = EXCLUDED.created_at,
          -- An explicit link stays explicit.
          derived = ${this.s}.edges.derived AND EXCLUDED.derived
      RETURNING *
      `,
			[this.namespace, sourceIds, targetIds, types, weights, metas, created, derived],
		);
		return result.rows.map((row) => mapEdgeRow(row));
	}

	async appendOp(
		operation: string,
		insightId: string | null,
		detail: Record<string, unknown>,
		at: Date,
	): Promise<void> {
		await this.client.query(
			`INSERT INTO ${this.s}.oplog (namespace, operation, insight_id, detail, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)`,
			[this.namespace, operation, insightId, JSON.stringify(detail), at],
		);
	}

	async setEffectiveImportance(id: string, value: number): Promise<void> {
		await this.client.query(
			`UPDATE ${this.s}.insights SET effective_importance = $3 WHERE namespace = $1 AND id = $2::uuid`,
			[this.namespace, id, value],
		);
	}

	async setEffectiveImportances(values: ReadonlyMap<string, number>): Promise<void> {
		if (values.size === 0) {
			return;
		}
		await this.client.query(
			`
      UPDATE ${this.s}.insights AS i
      SET effective_importance = u.value
      FROM unnest($2::uuid[], $3::float8[]) AS u(id, value)
      WHERE i.namespace = $1 AND i.id = u.id
      `,
			[this.namespace, [...values.keys()], [...values.values()]],
		);
	}

	async setMissingEmbeddings(
		values: ReadonlyMap<string, readonly number[]>,
	): Promise<number> {
		if (values.size === 0) {
			return 0;
		}
		const result = await this.client.query(
			`
      UPDATE ${this.s}.insights AS i
      SET embedding = u.embedding::vector
      FROM unnest($2::uuid[], $3::text[]) AS u(id, embedding)
      WHERE i.namespace = $1 AND i.id = u.id
        AND i.deleted_at IS NULL AND i.embedding IS NULL
      `,
			[this.namespace, [...values.keys()], [...values.values()].map(vec)],
		);
		return result.rowCount ?? 0;
	}

	async establishEmbeddingSettings(
		dimensions: number,
		model: string,
		at: Date,
	): Promise<boolean> {
		// Plain read first: once both settings exist, writers take no row lock.
		const read = () =>
			this.client.query<Record<string, unknown>>(
				`
      SELECT (SELECT value FROM ${this.s}.settings WHERE key = 'embedding_dimensions') AS dimensions,
             (SELECT value FROM ${this.s}.settings WHERE key = 'embedding_model') AS model
      `,
			);
		let dim = await read();
		const stored = dim.rows[0]?.dimensions != null && dim.rows[0].model != null;
		if (!stored) {
			await this.client.query(
				`
        INSERT INTO ${this.s}.settings (key, value, updated_at)
        VALUES ('embedding_dimensions', to_jsonb($1::int), $3),
               ('embedding_model', to_jsonb($2::text), $3)
        ON CONFLICT (key) DO NOTHING
        `,
				[dimensions, model, at],
			);
			dim = await read();
		}
		const row = dim.rows[0];
		if (Number(row?.dimensions) !== dimensions) {
			throw new MnemonConfigurationError(
				`embedding dimension mismatch: store has ${String(row?.dimensions)}, got ${dimensions}`,
			);
		}
		if (String(row?.model) !== model) {
			throw new MnemonConfigurationError(
				`embedding model mismatch: store has ${String(row?.model)}, got ${model}`,
			);
		}
		return stored;
	}

	async linkAndLog(edge: NewEdgeRecord, at: Date): Promise<EdgeRecord> {
		const active = await this.lockActiveInsightIds([
			edge.sourceId,
			edge.targetId,
		]);
		if (!active.has(edge.sourceId)) {
			throw new MnemonNotFoundError(
				`insight ${edge.sourceId} not found`,
				edge.sourceId,
			);
		}
		if (!active.has(edge.targetId)) {
			throw new MnemonNotFoundError(
				`insight ${edge.targetId} not found`,
				edge.targetId,
			);
		}
		const [persisted] = await this.upsertEdgeRows([edge]);
		if (!persisted) {
			throw new Error("link failed to persist edge");
		}
		await this.appendOp(
			"link",
			edge.sourceId,
			{
				source_id: edge.sourceId,
				target_id: edge.targetId,
				edge_type: edge.edgeType,
			},
			at,
		);
		return persisted;
	}

	async forgetAndLog(id: string, at: Date): Promise<boolean> {
		const locked = await this.client.query(
			`SELECT id FROM ${this.s}.insights WHERE namespace = $1 AND id = $2::uuid AND deleted_at IS NULL FOR UPDATE`,
			[this.namespace, id],
		);
		if ((locked.rowCount ?? 0) === 0) {
			return false;
		}
		await this.client.query(
			`
      WITH tombstone AS (
        UPDATE ${this.s}.insights
        SET deleted_at = $3, updated_at = $3
        WHERE namespace = $1 AND id = $2::uuid AND deleted_at IS NULL
        RETURNING id
      ),
      removed AS (
        DELETE FROM ${this.s}.edges
        WHERE namespace = $1
          AND (source_id = $2::uuid OR target_id = $2::uuid)
      )
      INSERT INTO ${this.s}.oplog (namespace, operation, insight_id, detail, created_at)
      SELECT $1, 'forget', id, '{}'::jsonb, $3 FROM tombstone
      `,
			[this.namespace, id, at],
		);
		return true;
	}

	async prune(input: {
		oplogBefore?: Date;
		operationsBefore?: Date;
		forgottenBefore?: Date;
		limit: number;
	}): Promise<{ oplog: number; operations: number; forgotten: number }> {
		const count = async (sql: string, cutoff: Date | undefined) =>
			cutoff
				? ((await this.client.query(sql, [this.namespace, cutoff, input.limit])).rowCount ?? 0)
				: 0;
		const oplog = await count(
			`DELETE FROM ${this.s}.oplog WHERE id IN (
				SELECT id FROM ${this.s}.oplog WHERE namespace = $1 AND created_at < $2 LIMIT $3
			)`,
			input.oplogBefore,
		);
		const operations = await count(
			`DELETE FROM ${this.s}.operations WHERE namespace = $1 AND key IN (
				SELECT key FROM ${this.s}.operations WHERE namespace = $1 AND created_at < $2 LIMIT $3
			)`,
			input.operationsBefore,
		);
		// Kept op-log entries lose their link to a deleted memory, not the entry.
		const forgotten = await count(
			`
      WITH gone AS (
        SELECT id FROM ${this.s}.insights
        WHERE namespace = $1 AND deleted_at < $2
        LIMIT $3
      ),
      unlinked AS (
        UPDATE ${this.s}.oplog SET insight_id = NULL
        WHERE namespace = $1 AND insight_id IN (SELECT id FROM gone)
      )
      DELETE FROM ${this.s}.insights
      WHERE namespace = $1 AND id IN (SELECT id FROM gone)
      `,
			input.forgottenBefore,
		);
		return { oplog, operations, forgotten };
	}

	async incrementAccess(ids: readonly string[], at: Date, by = 1): Promise<void> {
		if (ids.length === 0) {
			return;
		}
		await this.client.query(
			`
      UPDATE ${this.s}.insights
      SET access_count = access_count + $4,
          last_accessed_at = $3,
          updated_at = GREATEST(updated_at, $3)
      WHERE namespace = $1
        AND id = ANY($2::uuid[])
        AND deleted_at IS NULL
      `,
			[this.namespace, ids, at, by],
		);
	}
}

function mapAnchor(row: Record<string, unknown>): AnchorHit {
	return {
		id: String(row.id),
		score: Number(row.score),
		matchedVia: row.matched_via as AnchorHit["matchedVia"],
		signals: Array.isArray(row.signals) ? row.signals.map(String) : [],
	};
}

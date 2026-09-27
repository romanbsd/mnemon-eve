import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import pgvector from "pgvector/pg";

import {
	type MnemonConfig,
	quoteIdent,
	type ResolvedConfig,
	resolveConfig,
} from "./config.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import { makeBriefExcerpt } from "./engine/brief.js";
import {
	ALGORITHM_VERSION,
	ANCHOR_TOP_K,
	DEDUP_CANDIDATE_LIMIT,
	HNSW_MAX_DIMENSIONS,
	MAX_CONTENT_CODE_POINTS,
	DEFAULT_RELATED_DEPTH,
	DEFAULT_RELATED_LIMIT,
	KEEP_ACCESS_BOOST,
	MAX_LIST_LIMIT,
	MAX_RELATED_DEPTH,
	MAX_RELATED_LIMIT,
	MAX_SEMANTIC_EDGES,
	SEARCH_FTS_WEIGHT,
	SEARCH_KEYWORD_WEIGHT,
	SEMANTIC_CANDIDATE_MIN_COSINE,
	TEMPORAL_WINDOW_HOURS,
} from "./engine/constants.js";
import {
	applyDiffJudgments,
	classifyDiff,
	classifySafeDuplicate,
	type DiffResult,
	scoreDuplicateCandidate,
} from "./engine/diff.js";
import {
	buildCausalEdges,
	buildEntityEdges,
	buildJudgedCausalEdges,
	buildSemanticEdges,
	buildTemporalEdges,
	countEdgesByType,
	emptyEdgeCounts,
} from "./engine/edges.js";
import {
	candidateWords,
	extractEntitiesIndexed,
	mergeEntities,
} from "./engine/entities.js";
import { detectIntent } from "./engine/intent.js";
import {
	codePointLength,
	contentHash,
	normalizeContent,
} from "./engine/normalize.js";
import {
	causalTopologicalOrder,
	compareRecallHits,
	composeFinalScore,
	normalizeEliteGraph,
} from "./engine/recall.js";
import { effectiveImportance, isImmune } from "./engine/retention.js";
import { sortedSearchTokens, sortedTokens } from "./engine/tokenize.js";
import {
	requireLimit,
	validateEmbedding,
	validateLinkInput,
	validateListInput,
	validateLogInput,
	validateMetadata,
	validateRecallInput,
	validateRememberInput,
	validatePruneInput,
	validateRetentionInput,
	validateSearchInput,
	validateAuthorization,
	validateUuid,
} from "./engine/validate.js";
import {
	MnemonConfigurationError,
	MnemonEmbeddingError,
	MnemonError,
	MnemonNotFoundError,
} from "./errors.js";
import {
	assertPgvectorVersion,
	assertRlsEnforced,
	ensureUserScopePolicy,
	ensureVectorIndex,
	runMigrations,
} from "./postgres/migrations.js";
import { toPublicEdge, toPublicInsight } from "./postgres/row-mappers.js";
import type { InsightRecord, NewInsightRecord } from "./postgres/schema.js";
import {
	isUniqueViolation,
	type MnemonStore,
	type MnemonStoreTx,
	PostgresMnemonStore,
} from "./postgres/store.js";
import { withTransaction, wrapDatabaseError } from "./postgres/transaction.js";
import {
	EDGE_TYPES,
	type Edge,
	type EdgeType,
	type EmbedMissingResult,
	type ForgetResult,
	type Insight,
	type LinkInput,
	type ListInput,
	type LogInput,
	type ManagedInsightInput,
	type AuthorizationOptions,
	type Mnemon,
	type MnemonAuthorization,
	type MnemonClient,
	type MnemonStatus,
	type OnceResult,
	type OpLogEntry,
	type PruneInput,
	type PruneResult,
	type RecallHit,
	type RecallInput,
	type RecallResult,
	type RelatedInsight,
	type RememberInput,
	type RememberResult,
	type RetentionInput,
	type RetentionResult,
	type SearchInput,
	type SearchResult,
	type SimilarMemory,
} from "./types.js";

function primitiveSetting(value: unknown): string {
	if (typeof value === "string" || typeof value === "number") {
		return String(value);
	}
	throw new MnemonConfigurationError("stored embedding setting is invalid");
}

export function createMnemon(config: MnemonConfig): MnemonClient {
	return new PostgresMnemonClient(resolveConfig(config));
}

const SCOPED_METHODS = [
	"remember",
	"upsert",
	"recall",
	"link",
	"related",
	"forget",
	"get",
	"search",
	"list",
	"log",
	"status",
	"retentionCandidates",
	"keep",
	"prune",
	"embedMissing",
	"once",
] as const satisfies readonly (keyof Mnemon)[];

class PostgresMnemonClient implements MnemonClient {
	private readonly ownsPool: boolean;
	private readonly pool: Pool;
	private readonly typedClients = new WeakSet<PoolClient>();
	private initPromise: Promise<void> | undefined;
	private closed = false;

	/**
	 * Set once the store's embedding settings are known to match. Never reset:
	 * settings do not change under a live client, so recreate the client after
	 * dropping or recreating the schema.
	 */
	private readonly embeddingSettings = { confirmed: false };

	/** Set when vector search runs on the HNSW index. */
	private readonly vectorDimensions: number | undefined;

	constructor(private readonly config: ResolvedConfig) {
		this.ownsPool = config.pool === undefined;
		this.pool = config.pool ?? new Pool({ connectionString: config.databaseUrl });
		const dimensions = config.embeddingProvider?.dimensions;
		// ponytail: HNSW on `vector` stops at 2000 dimensions; larger models scan. halfvec would reach 4000.
		this.vectorDimensions =
			dimensions !== undefined && dimensions <= HNSW_MAX_DIMENSIONS
				? dimensions
				: undefined;
	}

	async initialize(): Promise<void> {
		this.initPromise ??= this.doInitialize().catch((error: unknown) => {
			this.initPromise = undefined;
			throw error;
		});
		return this.initPromise;
	}

	private async doInitialize(): Promise<void> {
		if (!this.config.allowRlsBypass) {
			await assertRlsEnforced(this.pool);
		}
		await runMigrations(this.pool, this.config.schema);
		if (this.config.enforceUserScope) {
			await ensureUserScopePolicy(this.pool, this.config.schema).catch(
				(error: unknown) => {
					throw wrapDatabaseError(error);
				},
			);
		}
		if (this.config.embeddingProvider) {
			await assertPgvectorVersion(this.pool).catch((error: unknown) => {
				throw wrapDatabaseError(error);
			});
			// Before the index, so a wrong provider cannot build it for its dimensions.
			await this.checkStoreSetting(
				"embedding_dimensions",
				this.config.embeddingProvider.dimensions,
				"embedding provider dimension",
			);
			await this.checkStoreSetting(
				"embedding_model",
				this.config.embeddingProvider.model,
				"embedding provider model",
			);
		}
		if (this.vectorDimensions !== undefined) {
			await ensureVectorIndex(
				this.pool,
				this.config.schema,
				this.vectorDimensions,
			).catch((error: unknown) => {
				throw error instanceof MnemonError ? error : wrapDatabaseError(error);
			});
		}
	}

	private async checkStoreSetting(
		key: "embedding_dimensions" | "embedding_model",
		expected: number | string,
		label: string,
	): Promise<void> {
		const result = await this.pool
			.query<{ value: unknown }>(
				`SELECT value FROM ${quoteIdent(this.config.schema)}.settings WHERE key = $1`,
				[key],
			)
			.catch((error: unknown) => {
				throw wrapDatabaseError(error);
			});
		const stored = result.rows[0]?.value;
		if (stored !== undefined && primitiveSetting(stored) !== String(expected)) {
			throw new MnemonConfigurationError(
				`${label} ${String(expected)} does not match store ${primitiveSetting(stored)}`,
			);
		}
	}

	async withAuthorization<T>(
		authorization: MnemonAuthorization,
		fn: (mnemon: Mnemon) => Promise<T>,
		options?: AuthorizationOptions,
	): Promise<T> {
		const auth = validateAuthorization(authorization);
		if (this.closed) {
			throw new MnemonConfigurationError("mnemon is closed");
		}
		await this.initialize();
		const prepared = await this.prepareEmbeddings(options?.embed ?? []);
		// Caller errors must surface unchanged; withTransaction only masks
		// driver errors. Box them through the rollback and unbox after.
		const boxed = { error: undefined as unknown, failed: false };
		try {
			return await withTransaction(this.pool, async (client) => {
				await this.registerVectorTypes(client);
				// is_local = true: settings vanish at COMMIT/ROLLBACK, so a pooled
				// connection never carries one caller's identity into the next.
				// Filtered HNSW scans keep going until LIMIT rows pass RLS and namespace.
				// Only set with the index: pgvector < 0.8 rejects the unknown setting.
				const hnsw =
					this.vectorDimensions === undefined
						? ""
						: ", set_config('hnsw.iterative_scan', 'strict_order', true)";
				await client.query(
					`SELECT set_config('mnemon.tenant_id', $1, true), set_config('mnemon.user_id', $2, true)${hnsw}`,
					[auth.tenantId, auth.userId ?? ""],
				);
				try {
					return await fn(
						new MnemonService(
							this.config,
							new PostgresMnemonStore(
								client,
								this.config.schema,
								auth.namespace,
								this.vectorDimensions,
							),
							auth.namespace,
							prepared,
							this.embeddingSettings,
						),
					);
				} catch (error) {
					if (!(error instanceof MnemonError)) {
						boxed.error = error;
						boxed.failed = true;
					}
					throw error;
				}
			});
		} catch (error) {
			throw boxed.failed ? boxed.error : error;
		}
	}

	scope(authorization: MnemonAuthorization): Mnemon {
		const view = {} as Record<string, unknown>;
		for (const method of SCOPED_METHODS) {
			view[method] = (...args: unknown[]) =>
				this.withAuthorization(
					authorization,
					(m) => (m[method] as (...a: unknown[]) => Promise<unknown>)(...args),
					{ embed: embedRequests(method, args[0]) },
				);
		}
		return view as unknown as Mnemon;
	}

	/** Embeds before BEGIN so no transaction idles on the provider. */
	private async prepareEmbeddings(
		requests: readonly EmbedRequest[],
	): Promise<Map<string, number[]>> {
		const prepared = new Map<string, number[]>();
		const provider = this.config.embeddingProvider;
		if (!provider) {
			return prepared;
		}
		for (const { text, purpose } of requests) {
			const trimmed = text.trim();
			const length = codePointLength(trimmed);
			// Invalid text fails validation inside, not as an embedding error here.
			if (length === 0 || length > MAX_CONTENT_CODE_POINTS) {
				continue;
			}
			const key = embeddingKey(trimmed, purpose);
			if (!prepared.has(key)) {
				prepared.set(key, await embedWith(provider, trimmed, purpose));
			}
		}
		return prepared;
	}

	private async registerVectorTypes(client: PoolClient): Promise<void> {
		if (this.typedClients.has(client)) {
			return;
		}
		await pgvector.registerTypes(client);
		this.typedClients.add(client);
	}

	async close(): Promise<void> {
		this.closed = true;
		try {
			await this.initPromise;
		} catch {}
		if (this.ownsPool) {
			await this.pool.end();
		}
	}
}

class MnemonService implements Mnemon {
	constructor(
		private readonly config: ResolvedConfig,
		private readonly store: MnemonStore,
		private readonly namespace: string,
		private readonly prepared: ReadonlyMap<string, number[]> = new Map(),
		private readonly embeddingSettings = { confirmed: false },
	) {}

	private insertedEmbeddingSettings = false;

	async once<T>(
		key: string,
		fn: (mnemon: Mnemon) => Promise<T>,
	): Promise<OnceResult<T>> {
		if (typeof key !== "string" || key.length === 0 || key.length > 512) {
			throw new MnemonConfigurationError(
				"once key must be a string of 1-512 characters",
			);
		}
		await this.store.lockOperation(key);
		const stored = await this.store.getOperation(key);
		if (stored) {
			return { value: stored.value as T, replayed: true };
		}
		const value = await fn(this);
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- fn may resolve to undefined
		await this.store.putOperation(key, value ?? null);
		return { value, replayed: false };
	}

	async remember(input: RememberInput): Promise<RememberResult> {
		const validated = validateRememberInput(input, this.config.defaults);
		const now = this.config.clock.now();
		const hash = contentHash(normalizeContent(validated.content));

		const exact = await this.store.findExactDuplicate(hash);
		if (exact) {
			return this.skipDuplicate(exact, now);
		}

		let embedding: number[] | undefined;
		if (this.config.embeddingProvider) {
			embedding = await this.embed(validated.content, "document");
		}

		const near = await this.findNearDuplicates(validated.content, embedding);
		let diff = classifyDiff(validated.content, near);
		if (validated.deduplicate) {
			const classified = classifySafeDuplicate(validated.content, near);
			if (classified) {
				const existing = await this.store.getActiveInsight(classified.id);
				if (existing) {
					return this.skipDuplicate(existing, now, classified.id, diff);
				}
			}
		}
		diff = await this.judgeDiff(validated.content, near, diff);

		const { record, generated } = await this.buildRecord(
			validated,
			{ id: randomUUID(), metadata: {}, managed: false },
			embedding,
			now,
		);

		try {
			const { insight, edges } = await this.store.withTransaction(
				async (tx) => {
					const persisted = await this.persistRecord(tx, record, generated, now);
					await tx.appendOp(
						"remember",
						record.id,
						{
							edge_counts: countEdgesByType(generated),
							embedding_model: this.config.embeddingProvider?.model ?? null,
						},
						now,
					);
					return persisted;
				},
			);

			const semanticCandidates = await this.semanticCandidates(insight);
			return {
				action: "added",
				insight: toPublicInsight(insight),
				suggestion: diff.suggestion,
				diff: diff.matches,
				semanticCandidates,
				edgeCounts: countEdgesByType(edges),
			};
		} catch (error) {
			if (isUniqueViolation(error)) {
				const winner = await this.store.findExactDuplicate(hash);
				if (winner) {
					return this.skipDuplicate(winner, now);
				}
			}
			throw error;
		}
	}

	async upsert(input: ManagedInsightInput): Promise<Insight> {
		const id = validateUuid(input.id, "id");
		const validated = validateRememberInput(input, this.config.defaults);
		const metadata = validateMetadata(input.metadata);
		const now = this.config.clock.now();
		const embedding = this.config.embeddingProvider
			? await this.embed(validated.content, "document")
			: undefined;
		const { record, generated } = await this.buildRecord(
			validated,
			{ id, metadata, managed: true },
			embedding,
			now,
		);
		const insight = await this.store.withTransaction(async (tx) => {
			const { insight: persisted, edges } = await this.persistRecord(
				tx,
				record,
				generated,
				now,
			);
			await tx.appendOp(
				"upsert",
				id,
				{ edge_counts: countEdgesByType(edges) },
				now,
			);
			return persisted;
		});
		return toPublicInsight(insight);
	}

	/** Entities, search tokens, and candidate edges for a memory about to be written. */
	private async buildRecord(
		validated: ReturnType<typeof validateRememberInput>,
		fields: Pick<NewInsightRecord, "id" | "metadata" | "managed">,
		embedding: number[] | undefined,
		now: Date,
	) {
		const known = new Set(
			await this.store.knownEntities(candidateWords(validated.content)),
		);
		const entities = mergeEntities(
			validated.entities,
			extractEntitiesIndexed(validated.content, known),
		);
		const createdAt = validated.createdAt ?? now;
		const normalized = normalizeContent(validated.content);
		const record: NewInsightRecord = {
			...fields,
			content: validated.content,
			normalizedContent: normalized,
			contentHash: contentHash(normalized),
			searchTokens: sortedSearchTokens(
				validated.content,
				validated.tags,
				entities,
			),
			category: validated.category,
			importance: validated.importance,
			tags: validated.tags,
			entities,
			source: validated.source,
			createdAt,
			updatedAt: now,
			embedding: embedding ?? null,
			effectiveImportance: 0.5,
		};
		const generated = await this.generateEdges({ ...record, embedding });
		return { record, generated };
	}

	// Only settings committed before this transaction are cached: its own
	// insert is visible to later reads here but could still roll back.
	private async establishEmbeddingSettings(
		tx: MnemonStoreTx,
		provider: EmbeddingProvider,
		now: Date,
	): Promise<void> {
		if (this.embeddingSettings.confirmed) return;
		const stored = await tx.establishEmbeddingSettings(
			provider.dimensions,
			provider.model,
			now,
		);
		if (!stored) this.insertedEmbeddingSettings = true;
		else if (!this.insertedEmbeddingSettings) this.embeddingSettings.confirmed = true;
	}

	/** Writes the record (managed ones upsert) and its edges, then scores it. */
	private async persistRecord(
		tx: MnemonStoreTx,
		record: NewInsightRecord,
		generated: Awaited<ReturnType<MnemonService["generateEdges"]>>,
		now: Date,
	) {
		if (record.embedding && this.config.embeddingProvider) {
			await this.establishEmbeddingSettings(tx, this.config.embeddingProvider, now);
		}
		const insight = record.managed
			? await tx.upsertManagedInsight(record)
			: await tx.insertInsight(record);
		// A backdated insight lands between two neighbours: it replaces their link.
		const backbone = (direction: "into" | "out") =>
			generated.find(
				(e) =>
					e.metadata.sub_type === "backbone" &&
					e.metadata.direction === "precedes" &&
					(direction === "into" ? e.targetId : e.sourceId) === record.id,
			);
		const previous = backbone("into")?.sourceId;
		const next = backbone("out")?.targetId;
		if (previous && next) {
			await tx.deleteBackbone(previous, next);
		}
		if (record.managed) {
			// Replaced content: edges derived from the old version are stale.
			await tx.deleteDerivedEdges(record.id);
		}
		const edges = await tx.upsertEdges(
			generated.map((edge) => ({ ...edge, createdAt: now, derived: true })),
		);
		const ei = effectiveImportance({
			importance: insight.importance,
			accessCount: insight.accessCount,
			daysSinceAccess: 0,
			edgeCount: edges.length,
		});
		await tx.setEffectiveImportance(insight.id, ei);
		insight.effectiveImportance = ei;
		return { insight, edges };
	}

	async recall(input: RecallInput): Promise<RecallResult> {
		const validated = validateRecallInput(
			input,
			this.config.defaults.recallLimit,
		);
		const now = this.config.clock.now();

		let queryVector: number[] | undefined;
		if (this.config.embeddingProvider) {
			queryVector = await this.embed(validated.query, "query");
		}

		const intent = validated.intent ?? detectIntent(validated.query);
		const intentSource = validated.intent ? "override" : "auto";
		const queryTokens = sortedTokens(validated.query);
		const known = new Set(
			await this.store.knownEntities(candidateWords(validated.query)),
		);
		const queryEntities = extractEntitiesIndexed(validated.query, known);

		const anchors = await this.store.selectRecallAnchors({
			queryTokens,
			queryVector,
			limitPerSignal: ANCHOR_TOP_K,
			source: validated.source,
		});

		const walked = await this.store.walkRecallGraph({
			anchors,
			intent,
			queryVector,
			maxCandidates: this.config.limits.maxRecallCandidates,
		});
		const graphRaw = new Map(walked.map((row) => [row.id, row.score]));
		const viaById = new Map(walked.map((row) => [row.id, row.via]));
		const candidateIds = walked.map((row) => row.id);
		const scored = await this.store.loadScoredInsights({
			ids: candidateIds,
			queryTokens,
			queryEntities,
			queryVector,
		});
		const scoredById = new Map(scored.map((row) => [row.insight.id, row]));
		const graphById = normalizeEliteGraph(
			scored.map((row) => ({
				id: row.insight.id,
				keyword: row.signals.keyword,
				similarity: row.signals.similarity,
				graphRaw: graphRaw.get(row.insight.id) ?? 0,
			})),
			queryVector !== undefined,
		);

		let hits: RecallHit[] = [];
		for (const id of candidateIds) {
			const row = scoredById.get(id);
			if (!row) {
				continue;
			}
			const insight = row.insight;
			if (validated.category && insight.category !== validated.category) {
				continue;
			}
			const signals = row.signals;
			const graph = graphById.get(id) ?? 0;
			const score = composeFinalScore({
				keyword: signals.keyword,
				entity: signals.entity,
				similarity: signals.similarity,
				graph,
				hasQueryEmbedding: queryVector !== undefined,
			});
			const via = viaById.get(id) ?? "keyword";
			hits.push({
				insight: toPublicInsight(insight),
				score,
				intent,
				matchedVia: via as RecallHit["matchedVia"],
				signals: {
					keyword: signals.keyword,
					entity: signals.entity,
					similarity: signals.similarity,
					graph,
				},
			});
		}

		hits.sort((a, b) =>
			compareRecallHits(
				{ score: a.score, importance: a.insight.importance },
				{ score: b.score, importance: b.insight.importance },
			),
		);

		if (intent === "WHY") {
			const causal = (await this.store.getEdgesForNodeIds(candidateIds)).filter(
				(e) => e.edgeType === "causal",
			);
			const ranked = hits.slice(0, validated.limit);
			hits = causalTopologicalOrder(
				ranked.map((h) => ({ ...h, id: h.insight.id })),
				causal,
			);
		} else {
			hits = hits.slice(0, validated.limit);
		}

		if (validated.brief) {
			hits = hits.map((hit) => {
				const excerpt = makeBriefExcerpt(
					hit.insight.content,
					validated.excerptChars,
				);
				return {
					...hit,
					excerpt,
					insight: { ...hit.insight, content: excerpt },
				};
			});
		}

		const returnedIds = hits.map((h) => h.insight.id);
		await this.store.withTransaction(async (tx) => {
			await tx.incrementAccess(returnedIds, now);
			await tx.appendOp(
				"recall",
				null,
				{
					query_hash: createHash("sha256")
						.update(validated.query, "utf8")
						.digest("hex"),
					hit_count: returnedIds.length,
					intent,
					algorithm_version: ALGORITHM_VERSION,
				},
				now,
			);
		});

		const result: RecallResult = {
			results: hits,
			meta: {
				intent,
				intentSource,
				anchorCount: anchors.length,
				traversed: walked.length,
				algorithmVersion: ALGORITHM_VERSION,
			},
		};
		if (hits.length === 0 || hits.length < validated.limit / 2) {
			result.meta.hint = "sparse_results";
		}
		return result;
	}

	async link(input: LinkInput): Promise<Edge> {
		const validated = validateLinkInput(input);
		const now = this.config.clock.now();
		const edge = await this.store.withTransaction(async (tx) => {
			const linked = await tx.linkAndLog(
				{
					sourceId: validated.sourceId,
					targetId: validated.targetId,
					edgeType: validated.edgeType,
					weight: validated.weight,
					metadata: validated.metadata,
					createdAt: now,
				},
				now,
			);
			// The edge bonus changed for both ends.
			await this.refreshEffectiveImportance(tx, validated.sourceId, now);
			await this.refreshEffectiveImportance(tx, validated.targetId, now);
			return linked;
		});
		return toPublicEdge(edge);
	}

	async related(
		id: string,
		options?: { maxDepth?: number; limit?: number; edgeType?: EdgeType },
	): Promise<RelatedInsight[]> {
		validateUuid(id, "id");
		const maxDepth = requireLimit(
			options?.maxDepth ?? DEFAULT_RELATED_DEPTH,
			MAX_RELATED_DEPTH,
			"maxDepth",
		);
		const limit = requireLimit(
			options?.limit ?? DEFAULT_RELATED_LIMIT,
			MAX_RELATED_LIMIT,
		);
		const start = await this.store.getActiveInsight(id);
		if (!start) {
			throw new MnemonNotFoundError(`insight ${id} not found`, id);
		}
		const walked = await this.store.walkRelated({
			startId: id,
			maxDepth,
			limit,
			edgeType: options?.edgeType,
		});
		return flatMapJoined(
			walked,
			await this.store.loadInsightsByIds(walked.map((o) => o.id)),
			(o, insight) => {
				const via = o.viaEdgeType;
				const row: RelatedInsight = {
					...toPublicInsight(insight),
					depth: o.depth,
				};
				if (via && (EDGE_TYPES as readonly string[]).includes(via)) {
					row.viaEdgeType = via as RelatedInsight["viaEdgeType"];
				}
				return row;
			},
		);
	}

	async forget(id: string): Promise<ForgetResult> {
		validateUuid(id, "id");
		const now = this.config.clock.now();
		const forgotten = await this.store.withTransaction((tx) =>
			tx.forgetAndLog(id, now),
		);
		return { forgotten, id };
	}

	async get(id: string): Promise<Insight | null> {
		validateUuid(id, "id");
		const record = await this.store.getActiveInsight(id);
		return record ? toPublicInsight(record) : null;
	}

	async list(input?: ListInput): Promise<Insight[]> {
		const validated = validateListInput(input);
		const rows = await this.store.listInsights(validated);
		return rows.map(toPublicInsight);
	}

	async search(input: SearchInput): Promise<SearchResult> {
		const validated = validateSearchInput(input);
		const queryTokens = sortedTokens(validated.query);
		const hits = await this.store.searchInsights({
			query: validated.query,
			queryTokens,
			limit: validated.limit,
			source: validated.source,
		});
		return {
			results: flatMapJoined(
				hits,
				await this.store.loadInsightsByIds(hits.map((h) => h.id)),
				(hit, insight) => {
					let via: "keyword" | "fts" | "hybrid" = "keyword";
					if (hit.keyword > 0 && hit.fts > 0) {
						via = "hybrid";
					} else if (hit.fts > hit.keyword) {
						via = "fts";
					}
					return {
						insight: toPublicInsight(insight),
						score:
							SEARCH_KEYWORD_WEIGHT * hit.keyword + SEARCH_FTS_WEIGHT * hit.fts,
						matchedVia: via,
						signals: { keyword: hit.keyword, fts: hit.fts },
					};
				},
			),
		};
	}

	async log(input?: LogInput): Promise<OpLogEntry[]> {
		const validated = validateLogInput(input);
		const rows = await this.store.listOps(validated);
		return rows.map((row) => {
			const entry: OpLogEntry = {
				id: row.id,
				operation: row.operation,
				detail: row.detail,
				createdAt: row.createdAt.toISOString(),
			};
			if (row.insightId) {
				entry.insightId = row.insightId;
			}
			return entry;
		});
	}

	async retentionCandidates(input?: RetentionInput): Promise<RetentionResult> {
		const { threshold, limit } = validateRetentionInput(input);
		const now = this.config.clock.now();
		const scored = (await this.store.listRetentionRows()).map(
			({ insight, edgeCount }) => {
				const since = insight.lastAccessedAt ?? insight.createdAt;
				const daysSinceAccess = Math.max(
					0,
					(now.getTime() - since.getTime()) / 86_400_000,
				);
				return {
					insight,
					edgeCount,
					daysSinceAccess,
					effectiveImportance: effectiveImportance({
						importance: insight.importance,
						accessCount: insight.accessCount,
						daysSinceAccess,
						edgeCount,
					}),
				};
			},
		);
		// Write back only material changes: a read must not rewrite the namespace.
		const changed = scored.filter(
			(s) => Math.abs(s.effectiveImportance - s.insight.effectiveImportance) >= 0.01,
		);
		if (changed.length > 0) {
			await this.store.withTransaction((tx) =>
				tx.setEffectiveImportances(
					new Map(changed.map((s) => [s.insight.id, s.effectiveImportance])),
				),
			);
		}
		const candidates = scored
			.filter(
				(s) =>
					s.effectiveImportance < threshold &&
					!isImmune(s.insight.importance, s.insight.accessCount),
			)
			.sort(
				(a, b) =>
					a.effectiveImportance - b.effectiveImportance ||
					a.insight.id.localeCompare(b.insight.id),
			);
		return {
			total: candidates.length,
			candidates: candidates
				.slice(0, limit)
				.map((c) => ({ ...c, insight: toPublicInsight(c.insight) })),
		};
	}

	async embedMissing(input?: {
		limit?: number;
	}): Promise<EmbedMissingResult> {
		const provider = this.config.embeddingProvider;
		if (!provider) {
			throw new MnemonConfigurationError(
				"embedding provider is not configured",
			);
		}
		const limit = requireLimit(input?.limit ?? 100, MAX_LIST_LIMIT);
		const { total, insights } = await this.store.listUnembedded(limit);
		const vectors = new Map<string, number[]>();
		// ponytail: sequential; batch provider calls if backfills get large.
		for (const insight of insights) {
			vectors.set(insight.id, await this.embed(insight.content, "document"));
		}
		const now = this.config.clock.now();
		const embedded = await this.store.withTransaction(async (tx) => {
			if (vectors.size > 0) {
				await this.establishEmbeddingSettings(tx, provider, now);
			}
			const count = await tx.setMissingEmbeddings(vectors);
			if (count > 0) {
				await tx.appendOp(
					"embed:backfill",
					null,
					{ embedded: count, model: provider.model },
					now,
				);
			}
			return count;
		});
		return { embedded, remaining: Math.max(0, total - embedded) };
	}

	async prune(input: PruneInput): Promise<PruneResult> {
		const pruneInput = validatePruneInput(input);
		return this.store.withTransaction((tx) => tx.prune(pruneInput));
	}

	async keep(id: string): Promise<Insight> {
		validateUuid(id, "id");
		const now = this.config.clock.now();
		const kept = await this.store.withTransaction(async (tx) => {
			await tx.incrementAccess([id], now, KEEP_ACCESS_BOOST);
			const record = await this.refreshEffectiveImportance(tx, id, now);
			if (!record) {
				return null;
			}
			await tx.appendOp(
				"gc_keep",
				id,
				{ effective_importance: record.effectiveImportance },
				now,
			);
			return record;
		});
		if (!kept) {
			throw new MnemonNotFoundError(`insight ${id} not found`, id);
		}
		return toPublicInsight(kept);
	}

	/** Recomputes and stores the cached effective importance of one active insight. */
	private async refreshEffectiveImportance(
		tx: MnemonStoreTx,
		id: string,
		now: Date,
	): Promise<InsightRecord | null> {
		const record = await this.store.getActiveInsight(id);
		if (!record) {
			return null;
		}
		const since = record.lastAccessedAt ?? record.createdAt;
		record.effectiveImportance = effectiveImportance({
			importance: record.importance,
			accessCount: record.accessCount,
			daysSinceAccess: Math.max(0, (now.getTime() - since.getTime()) / 86_400_000),
			edgeCount: (await this.store.getEdgesForNodeIds([id])).length,
		});
		await tx.setEffectiveImportance(id, record.effectiveImportance);
		return record;
	}

	async status(): Promise<MnemonStatus> {
		const counts = await this.store.counts();
		const model = await this.store.getSetting("embedding_model");
		const dimensions = await this.store.getSetting("embedding_dimensions");
		const status: MnemonStatus = {
			namespace: this.namespace,
			schema: this.config.schema,
			algorithmVersion: ALGORITHM_VERSION,
			insights: counts.insights,
			embeddings: counts.embeddings,
			edges: counts.edges,
		};
		if (typeof model === "string" && model.length > 0) {
			status.embeddingModel = model;
		}
		if (typeof dimensions === "number" && Number.isFinite(dimensions)) {
			status.embeddingDimensions = dimensions;
		}
		return status;
	}

	private async embed(
		text: string,
		purpose: "document" | "query",
	): Promise<number[]> {
		const provider = this.config.embeddingProvider;
		if (!provider) {
			throw new MnemonConfigurationError(
				"embedding provider is not configured",
			);
		}
		return (
			this.prepared.get(embeddingKey(text, purpose)) ??
			embedWith(provider, text, purpose)
		);
	}

	private async judgeDiff(
		content: string,
		candidates: readonly { id: string; content: string }[],
		diff: DiffResult,
	): Promise<DiffResult> {
		const judge = this.config.diffJudge;
		if (!judge || candidates.length === 0) {
			return diff;
		}
		try {
			const relations = await judge({
				content,
				candidates: candidates.map(({ id, content }) => ({ id, content })),
			});
			return applyDiffJudgments(diff, relations);
		} catch {
			// ponytail: the suggestion is informational, so a judge outage must not
			// fail the write; the heuristic result stands. Add a hook to observe
			// judge failures if silent fallback hides a misconfiguration.
			return diff;
		}
	}

	private async skipDuplicate(
		existing: InsightRecord,
		now: Date,
		duplicateOf?: string,
		diff = classifyDiff(existing.content, [
			{ id: existing.id, content: existing.content, cosineSimilarity: 1 },
		]),
	): Promise<RememberResult> {
		await this.store.withTransaction((tx) =>
			tx.appendOp(
				"remember_skipped",
				existing.id,
				{ duplicate_of: duplicateOf ?? existing.id },
				now,
			),
		);
		return {
			action: "skipped",
			insight: toPublicInsight(existing),
			duplicateOf: duplicateOf ?? existing.id,
			suggestion: "DUPLICATE",
			diff: diff.matches,
			semanticCandidates: [],
			edgeCounts: emptyEdgeCounts(),
		};
	}

	private async findNearDuplicates(
		content: string,
		embedding: number[] | undefined,
	): Promise<
		{
			id: string;
			content: string;
			tokenSimilarity: number;
			cosineSimilarity: number;
		}[]
	> {
		const tokens = sortedTokens(content);
		const keywordHits = await this.store.findKeywordCandidates(
			tokens,
			DEDUP_CANDIDATE_LIMIT,
		);
		const vectorHits = embedding
			? await this.store.nearestEmbeddings(embedding, {
					limit: DEDUP_CANDIDATE_LIMIT,
				})
			: [];
		const ids = [
			...new Set([
				...keywordHits.map((h) => h.id),
				...vectorHits.map((h) => h.id),
			]),
		];
		return (await this.store.loadInsightsByIds(ids, { embedding: true }))
			.filter((insight) => !insight.managed)
			.map((ins) => ({
				id: ins.id,
				content: ins.content,
				...scoreDuplicateCandidate(
					content,
					ins.content,
					embedding,
					ins.embedding ?? undefined,
				),
			}));
	}

	private async generateEdges(
		insight: {
			id: string;
			content: string;
			source: string;
			createdAt: Date;
			entities: readonly string[];
			embedding?: number[] | null;
		},
	) {
		// Window around the insight's own time, so backdated writes find their
		// contemporaries rather than whatever was stored in the last day.
		const windowMs = TEMPORAL_WINDOW_HOURS * 3_600_000;
		const context = await this.store.loadEdgeContext({
			excludeId: insight.id,
			source: insight.source,
			createdAt: insight.createdAt,
			since: new Date(insight.createdAt.getTime() - windowMs),
			until: new Date(insight.createdAt.getTime() + windowMs),
			entities: insight.entities,
		});
		const temporal = buildTemporalEdges({
			newId: insight.id,
			newCreatedAt: insight.createdAt,
			latestSameSource: context.latestSameSource,
			nextSameSource: context.nextSameSource,
			recentWithin24h: context.recentWithin24h,
		});
		const entity = buildEntityEdges({
			newId: insight.id,
			pairs: context.entityPairs,
		});
		const causal = await this.causalEdges(
			insight.id,
			insight.content,
			context.causalPrevious,
		);

		let semantic: ReturnType<typeof buildSemanticEdges> = [];
		if (insight.embedding) {
			const neighbors = await this.store.nearestEmbeddings(insight.embedding, {
				excludeId: insight.id,
				limit: MAX_SEMANTIC_EDGES,
			});
			semantic = buildSemanticEdges({
				newId: insight.id,
				neighbors: neighbors.map((n) => ({
					id: n.id,
					cosine: n.cosineSimilarity,
				})),
			});
		}

		return [...temporal, ...entity, ...causal, ...semantic];
	}

	private async causalEdges(
		newId: string,
		newContent: string,
		previous: readonly { id: string; content: string }[],
	) {
		const judge = this.config.causalJudge;
		if (judge && previous.length > 0) {
			try {
				const judgments = await judge({
					content: newContent,
					previous: previous.map(({ id, content }) => ({ id, content })),
				});
				return buildJudgedCausalEdges({ newId, judgments });
			} catch {
				// ponytail: same silent fallback as judgeDiff; edges are derived data.
			}
		}
		return buildCausalEdges({ newId, newContent, previous });
	}

	private async semanticCandidates(
		insight: InsightRecord,
	): Promise<SimilarMemory[]> {
		if (!insight.embedding) {
			return [];
		}
		const hits = await this.store.nearestEmbeddings(insight.embedding, {
			excludeId: insight.id,
			limit: 5,
			minCosine: SEMANTIC_CANDIDATE_MIN_COSINE,
		});
		return flatMapJoined(
			hits,
			await this.store.loadInsightsByIds(
				hits.map((h) => h.id),
				{ embedding: true },
			),
			(h, ins) => {
				const scored = scoreDuplicateCandidate(
					insight.content,
					ins.content,
					insight.embedding ?? undefined,
					ins.embedding ?? undefined,
				);
				return {
					id: ins.id,
					content: ins.content,
					category: ins.category,
					tokenSimilarity: scored.tokenSimilarity,
					cosineSimilarity: h.cosineSimilarity,
				} satisfies SimilarMemory;
			},
		);
	}
}

function indexById<T extends { id: string }>(
	rows: readonly T[],
): Map<string, T> {
	return new Map(rows.map((row) => [row.id, row]));
}

function flatMapJoined<T extends { id: string }, R>(
	hits: readonly T[],
	rows: readonly InsightRecord[],
	fn: (hit: T, insight: InsightRecord) => R,
): R[] {
	const byId = indexById(rows);
	const out: R[] = [];
	for (const hit of hits) {
		const insight = byId.get(hit.id);
		if (insight) {
			out.push(fn(hit, insight));
		}
	}
	return out;
}

type EmbedRequest = NonNullable<AuthorizationOptions["embed"]>[number];

function embeddingKey(text: string, purpose: EmbedRequest["purpose"]): string {
	return `${purpose}\0${text}`;
}

async function embedWith(
	provider: EmbeddingProvider,
	text: string,
	purpose: EmbedRequest["purpose"],
): Promise<number[]> {
	try {
		const vector = await provider.embed(text, purpose);
		return validateEmbedding(vector, provider.dimensions);
	} catch (error) {
		if (error instanceof MnemonEmbeddingError) {
			throw error;
		}
		throw new MnemonEmbeddingError("embedding provider failed", {
			cause: error,
		});
	}
}

/** The texts a scoped call will embed, so they are embedded before BEGIN. */
function embedRequests(method: string, input: unknown): EmbedRequest[] {
	if (typeof input !== "object" || input === null) {
		return [];
	}
	const { content, query } = input as { content?: unknown; query?: unknown };
	if ((method === "remember" || method === "upsert") && typeof content === "string") {
		return [{ text: content, purpose: "document" }];
	}
	if (method === "recall" && typeof query === "string") {
		return [{ text: query, purpose: "query" }];
	}
	return [];
}

export const EDGE_TYPES = ["temporal", "semantic", "causal", "entity"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];
export const RECALL_INTENTS = ["WHY", "WHEN", "ENTITY", "GENERAL"] as const;
export type RecallIntent = (typeof RECALL_INTENTS)[number];
export type RememberAction = "added" | "skipped";
export type DiffSuggestion = "ADD" | "DUPLICATE" | "CONFLICT" | "UPDATE";
export const DIFF_RELATIONS = [
	"duplicate",
	"refines",
	"contradicts",
	"unrelated",
] as const;
export type DiffRelation = (typeof DIFF_RELATIONS)[number];
/** How an earlier memory and a new one are causally related, if at all. */
export const CAUSAL_RELATIONS = [
	"existing_causes_new",
	"existing_enables_new",
	"existing_prevents_new",
	"new_causes_existing",
	"new_enables_existing",
	"new_prevents_existing",
	"none",
] as const;
export type CausalRelation = (typeof CAUSAL_RELATIONS)[number];
export type AlgorithmVersion = "mnemon-ts-v1";

export const INSIGHT_CATEGORIES = [
	"preference",
	"decision",
	"fact",
	"insight",
	"context",
	"general",
] as const;
export type InsightCategory = (typeof INSIGHT_CATEGORIES)[number];

export interface Insight {
	id: string;
	content: string;
	category: InsightCategory;
	importance: 1 | 2 | 3 | 4 | 5;
	tags: string[];
	entities: string[];
	source: string;
	metadata: Record<string, unknown>;
	accessCount: number;
	storedAt: string;
	createdAt: string;
	updatedAt: string;
	deletedAt?: string;
}

export interface Edge {
	sourceId: string;
	targetId: string;
	edgeType: EdgeType;
	weight: number;
	metadata: Record<string, string>;
	createdAt: string;
}

export interface RememberInput {
	content: string;
	category?: InsightCategory;
	importance?: 1 | 2 | 3 | 4 | 5;
	tags?: string[];
	entities?: string[];
	source?: string;
	createdAt?: string;
	deduplicate?: boolean;
}

/** A caller-owned record projected into Mnemon under a stable UUID. */
export interface ManagedInsightInput
	extends Omit<RememberInput, "deduplicate"> {
	id: string;
	metadata?: Record<string, unknown>;
}

export interface SimilarMemory {
	id: string;
	content: string;
	category: InsightCategory;
	tokenSimilarity: number;
	cosineSimilarity: number;
}

export interface DiffMatch {
	id: string;
	content: string;
	tokenSimilarity: number;
	cosineSimilarity: number;
	similarity: number;
	suggestion: DiffSuggestion;
}

export interface RememberResult {
	action: RememberAction;
	insight: Insight;
	duplicateOf?: string;
	/** Go Diff class. Informational only — this library never auto-replaces. */
	suggestion: DiffSuggestion;
	diff: DiffMatch[];
	semanticCandidates: SimilarMemory[];
	edgeCounts: Record<EdgeType, number>;
}

export interface RecallInput {
	query: string;
	limit?: number;
	intent?: RecallIntent;
	source?: string;
	/**
	 * Only return memories of this category. Anchors and graph traversal are
	 * unfiltered, so a match can still pull in related memories of this kind.
	 */
	category?: InsightCategory;
	/** Compact discovery projection: flatten whitespace and truncate content. */
	brief?: boolean;
	/** Maximum Unicode code points per brief excerpt. Default 240. Must be > 0. */
	excerptChars?: number;
}

export interface RecallSignals {
	keyword: number;
	entity: number;
	similarity: number;
	graph: number;
}

export interface RecallHit {
	insight: Insight;
	score: number;
	intent: RecallIntent;
	matchedVia: "keyword" | "vector" | "time" | "fts" | "hybrid" | EdgeType;
	signals: RecallSignals;
	/** Present when `RecallInput.brief` is true. Full text is available via `get(id)`. */
	excerpt?: string;
}

export interface RecallResult {
	results: RecallHit[];
	meta: {
		intent: RecallIntent;
		intentSource: "auto" | "override";
		anchorCount: number;
		traversed: number;
		hint?: "sparse_results";
		algorithmVersion: AlgorithmVersion;
	};
}

export interface LinkInput {
	sourceId: string;
	targetId: string;
	edgeType: EdgeType;
	weight?: number;
	metadata?: Record<string, string>;
}

export interface ForgetResult {
	forgotten: boolean;
	id: string;
}

export interface SearchInput {
	query: string;
	limit?: number;
	source?: string;
}

export interface ListInput {
	limit?: number;
	source?: string;
	category?: InsightCategory;
	since?: string;
	until?: string;
}

export interface RetentionInput {
	/** Effective importance below which a memory is a candidate. Default 0.5. */
	threshold?: number;
	/** Default 20. */
	limit?: number;
}

export interface RetentionCandidate {
	insight: Insight;
	/** Importance decayed by time since last access, boosted by access and edges. */
	effectiveImportance: number;
	daysSinceAccess: number;
	edgeCount: number;
}

export interface RetentionResult {
	/** Candidates before `limit`. */
	total: number;
	/** Lowest effective importance first. */
	candidates: RetentionCandidate[];
}

export interface SearchHit {
	insight: Insight;
	score: number;
	matchedVia: "keyword" | "fts" | "hybrid";
	signals: { keyword: number; fts: number };
}

export interface SearchResult {
	results: SearchHit[];
}

export interface LogInput {
	limit?: number;
	operation?: string;
}

export interface OpLogEntry {
	id: string;
	operation: string;
	insightId?: string;
	detail: Record<string, unknown>;
	createdAt: string;
}

export interface MnemonStatus {
	namespace: string;
	schema: string;
	algorithmVersion: AlgorithmVersion;
	insights: number;
	embeddings: number;
	edges: number;
	embeddingModel?: string;
	embeddingDimensions?: number;
}

export interface RelatedInsight extends Insight {
	depth: number;
	viaEdgeType?: EdgeType;
}

/** Who is acting, and which partition they act on. Never take these from model output. */
export interface MnemonAuthorization {
	tenantId: string;
	/** Omit or null for tenant-shared memory. */
	userId?: string | null;
	/** Storage partition, e.g. Eve's `memory.scope.key`. */
	namespace: string;
}

export interface OnceResult<T> {
	value: T;
	/** True when `value` came from an earlier run with the same key. */
	replayed: boolean;
}

/** Memory operations bound to one authorized tenant/user/namespace. */
export interface Mnemon {
	remember(input: RememberInput): Promise<RememberResult>;
	upsert(input: ManagedInsightInput): Promise<Insight>;
	recall(input: RecallInput): Promise<RecallResult>;
	link(input: LinkInput): Promise<Edge>;
	related(
		id: string,
		options?: { maxDepth?: number; limit?: number; edgeType?: EdgeType },
	): Promise<RelatedInsight[]>;
	forget(id: string): Promise<ForgetResult>;
	get(id: string): Promise<Insight | null>;
	search(input: SearchInput): Promise<SearchResult>;
	list(input?: ListInput): Promise<Insight[]>;
	log(input?: LogInput): Promise<OpLogEntry[]>;
	status(): Promise<MnemonStatus>;
	/**
	 * Memories worth reviewing for `forget`, lowest effective importance first.
	 * Importance 4+ or 3+ accesses are immune. Refreshes stored effective
	 * importance for the namespace; never deletes.
	 */
	retentionCandidates(input?: RetentionInput): Promise<RetentionResult>;
	/** Marks a memory worth keeping: +3 accesses and a fresh access time. */
	keep(id: string): Promise<Insight>;
	/**
	 * Runs `fn` at most once per `key` in this namespace and returns the stored
	 * JSON result on replay. Concurrent callers with the same key serialize.
	 */
	once<T>(key: string, fn: (mnemon: Mnemon) => Promise<T>): Promise<OnceResult<T>>;
}

export interface MnemonClient {
	/** Runs migrations and RLS checks. Called lazily by other methods. */
	initialize(): Promise<void>;
	/**
	 * Opens one transaction with transaction-local RLS context and runs `fn`
	 * against memory bound to `authorization`.
	 */
	withAuthorization<T>(
		authorization: MnemonAuthorization,
		fn: (mnemon: Mnemon) => Promise<T>,
	): Promise<T>;
	/** Convenience view where every call runs in its own authorized transaction. */
	scope(authorization: MnemonAuthorization): Mnemon;
	close(): Promise<void>;
}

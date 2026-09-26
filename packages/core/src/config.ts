import type { Pool } from "pg";

import { type Clock, systemClock } from "./clock.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import type { DiffJudge } from "./engine/diff.js";
import type { CausalJudge } from "./engine/edges.js";
import { MnemonConfigurationError } from "./errors.js";
import type { InsightCategory } from "./types.js";

export interface MnemonConfig {
	databaseUrl?: string;
	pool?: Pool;
	schema?: string;
	embeddingProvider?: EmbeddingProvider;
	embeddingDimensions?: number;
	/**
	 * Replaces the phrase-list heuristic behind `RememberResult.suggestion`.
	 * Informational only; on failure the heuristic result is kept.
	 */
	diffJudge?: DiffJudge;
	/**
	 * Replaces the phrase-list heuristic for causal edges between a new memory
	 * and recent ones. On failure the heuristic edges are kept.
	 */
	causalJudge?: CausalJudge;
	clock?: Clock;
	defaults?: {
		category?: InsightCategory;
		importance?: 1 | 2 | 3 | 4 | 5;
		source?: string;
		recallLimit?: number;
	};
	limits?: {
		activeInsightSoftLimit?: number;
		maxRecallCandidates?: number;
	};
	/**
	 * Opt in to a restrictive RLS policy that also isolates rows by `userId`.
	 * Once installed it is never dropped automatically; see README.
	 */
	enforceUserScope?: boolean;
	/**
	 * Allow connecting as a superuser or BYPASSRLS role. RLS is then not
	 * enforced by PostgreSQL; only use this for migrations or local tooling.
	 */
	allowRlsBypass?: boolean;
}

export interface ResolvedConfig {
	databaseUrl?: string;
	pool?: Pool;
	schema: string;
	embeddingProvider?: EmbeddingProvider;
	embeddingDimensions?: number;
	diffJudge?: DiffJudge;
	causalJudge?: CausalJudge;
	clock: Clock;
	defaults: {
		category: InsightCategory;
		importance: 1 | 2 | 3 | 4 | 5;
		source: string;
		recallLimit: number;
	};
	limits: {
		activeInsightSoftLimit: number;
		maxRecallCandidates: number;
	};
	enforceUserScope: boolean;
	allowRlsBypass: boolean;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

function requirePositiveInt(value: number, label: string): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new MnemonConfigurationError(`${label} must be a positive integer`);
	}
}

export function resolveConfig(config: MnemonConfig): ResolvedConfig {
	const hasUrl =
		typeof config.databaseUrl === "string" && config.databaseUrl.length > 0;
	const hasPool = config.pool !== undefined;
	if (hasUrl === hasPool) {
		throw new MnemonConfigurationError(
			"exactly one of databaseUrl or pool is required",
		);
	}

	const schema = config.schema ?? "mnemon";
	if (!SCHEMA_RE.test(schema)) {
		throw new MnemonConfigurationError(
			`invalid schema "${schema}"; must match ${SCHEMA_RE.source}`,
		);
	}

	const provider = config.embeddingProvider;
	if (provider !== undefined) {
		requirePositiveInt(provider.dimensions, "embeddingProvider.dimensions");
	}

	if (config.embeddingDimensions !== undefined) {
		requirePositiveInt(config.embeddingDimensions, "embeddingDimensions");
		if (
			provider !== undefined &&
			provider.dimensions !== config.embeddingDimensions
		) {
			throw new MnemonConfigurationError(
				`embeddingDimensions (${config.embeddingDimensions}) does not match provider (${provider.dimensions})`,
			);
		}
	}

	const maxRecallCandidates = config.limits?.maxRecallCandidates ?? 500;
	if (
		!Number.isInteger(maxRecallCandidates) ||
		maxRecallCandidates < 50 ||
		maxRecallCandidates > 5000
	) {
		throw new MnemonConfigurationError(
			"maxRecallCandidates must be an integer between 50 and 5000",
		);
	}

	return {
		databaseUrl: config.databaseUrl,
		pool: config.pool,
		schema,
		embeddingProvider: provider,
		embeddingDimensions: config.embeddingDimensions ?? provider?.dimensions,
		diffJudge: config.diffJudge,
		causalJudge: config.causalJudge,
		clock: config.clock ?? systemClock,
		defaults: {
			category: config.defaults?.category ?? "general",
			importance: config.defaults?.importance ?? 3,
			source: config.defaults?.source ?? "agent",
			recallLimit: config.defaults?.recallLimit ?? 10,
		},
		limits: {
			activeInsightSoftLimit: config.limits?.activeInsightSoftLimit ?? 5000,
			maxRecallCandidates,
		},
		enforceUserScope: config.enforceUserScope ?? false,
		allowRlsBypass: config.allowRlsBypass ?? false,
	};
}

export function quoteIdent(ident: string): string {
	return `"${ident.replaceAll('"', '""')}"`;
}

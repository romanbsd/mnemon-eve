import type { Pool, PoolClient } from "pg";

import { quoteIdent } from "../config.js";
import { MnemonConfigurationError, MnemonDatabaseError } from "../errors.js";
import { withTransaction, wrapDatabaseError } from "./transaction.js";

export const MIGRATION_VERSION = 2;

// Rows inherit authorization from the transaction-local settings written by
// Mnemon.withAuthorization(); inserts without that context fail.
const TENANCY_COLUMNS = `
          tenant_id   text NOT NULL DEFAULT current_setting('mnemon.tenant_id')
                      CHECK (tenant_id <> ''),
          user_id     text DEFAULT nullif(current_setting('mnemon.user_id', true), '')
                      CHECK (user_id <> ''),`;

const TENANT_MATCH = `tenant_id = current_setting('mnemon.tenant_id', true)`;
const USER_MATCH = `user_id IS NOT DISTINCT FROM nullif(current_setting('mnemon.user_id', true), '')`;

// unique_violation, duplicate_schema, duplicate_table, duplicate_object
const DUPLICATE_OBJECT = new Set(["23505", "42P06", "42P07", "42710"]);

export const RLS_TABLES = ["insights", "edges", "oplog", "operations"] as const;

export async function runMigrations(
	pool: Pool,
	schema: string,
): Promise<number> {
	const s = quoteIdent(schema);
	// Read-only fast path: an already-migrated schema needs no DDL, so the
	// app role can run with DML grants only while an owner role migrates.
	try {
		const exists = await pool.query<{ found: boolean }>(
			"SELECT to_regclass($1) IS NOT NULL AS found",
			[`${s}.schema_migrations`],
		);
		if (exists.rows[0]?.found) {
			const current = await pool.query<{ version: number | null }>(
				`SELECT max(version) AS version FROM ${s}.schema_migrations`,
			);
			if (current.rows[0]?.version === MIGRATION_VERSION) {
				return MIGRATION_VERSION;
			}
		}
	} catch (error) {
		throw wrapDatabaseError(error);
	}
	try {
		await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
	} catch (error) {
		throw new MnemonConfigurationError(
			"pgvector extension is unavailable; CREATE EXTENSION vector failed",
			{ cause: error },
		);
	}

	const migrate = () => withTransaction(pool, async (client) => {
		await lockSchema(client, schema);
		await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
		await client.query(`
      CREATE TABLE IF NOT EXISTS ${s}.schema_migrations (
          version      integer PRIMARY KEY,
          applied_at   timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);

		const existing = await client.query<{ version: number }>(
			`SELECT version FROM ${s}.schema_migrations ORDER BY version DESC LIMIT 1`,
		);
		const currentVersion = existing.rows[0]?.version;
		if (currentVersion === MIGRATION_VERSION) {
			return MIGRATION_VERSION;
		}
		if (currentVersion === 1) {
			await upgradeToV2(client, s);
			return MIGRATION_VERSION;
		}
		if (currentVersion !== undefined) {
			throw new MnemonConfigurationError(
				`Mnemon schema version ${currentVersion} is incompatible with ${MIGRATION_VERSION}; recreate the pre-production schema`,
			);
		}

		const tables = [
			`
      CREATE TABLE IF NOT EXISTS ${s}.settings (
          key          text PRIMARY KEY,
          value        jsonb NOT NULL,
          updated_at   timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `,
			`
      CREATE TABLE IF NOT EXISTS ${s}.insights (${TENANCY_COLUMNS}
          namespace             text NOT NULL CHECK (char_length(namespace) BETWEEN 1 AND 200),
          id                    uuid NOT NULL,
          content               text NOT NULL,
          normalized_content    text NOT NULL,
          content_hash          text NOT NULL,
          search_tokens         text[] NOT NULL DEFAULT '{}'::text[],
          category              text NOT NULL
                                CHECK (category IN ('preference','decision','fact','insight','context','general')),
          importance            smallint NOT NULL CHECK (importance BETWEEN 1 AND 5),
          tags                  jsonb NOT NULL DEFAULT '[]'::jsonb
                                CHECK (jsonb_typeof(tags) = 'array'),
          entities              jsonb NOT NULL DEFAULT '[]'::jsonb
                                CHECK (jsonb_typeof(entities) = 'array'),
          source                text NOT NULL,
          metadata              jsonb NOT NULL DEFAULT '{}'::jsonb
                                CHECK (jsonb_typeof(metadata) = 'object'),
          managed               boolean NOT NULL DEFAULT false,
          access_count          integer NOT NULL DEFAULT 0 CHECK (access_count >= 0),
          stored_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
          created_at            timestamptz NOT NULL,
          updated_at            timestamptz NOT NULL,
          deleted_at            timestamptz,
          last_accessed_at      timestamptz,
          embedding             vector,
          search_tsv            tsvector GENERATED ALWAYS AS (
                                  setweight(to_tsvector('english'::regconfig, coalesce(content, '')), 'A')
                                ) STORED,
          effective_importance  double precision NOT NULL DEFAULT 0.5,
          PRIMARY KEY (tenant_id, namespace, id)
      )
    `,
			`
      CREATE TABLE IF NOT EXISTS ${s}.edges (${TENANCY_COLUMNS}
          namespace   text NOT NULL CHECK (char_length(namespace) BETWEEN 1 AND 200),
          source_id   uuid NOT NULL,
          target_id   uuid NOT NULL,
          edge_type   text NOT NULL
                      CHECK (edge_type IN ('temporal','semantic','causal','entity')),
          weight      double precision NOT NULL DEFAULT 1.0
                      CHECK (weight >= 0.0 AND weight <= 1.0),
          metadata    jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(metadata) = 'object'),
          created_at  timestamptz NOT NULL,
          PRIMARY KEY (tenant_id, namespace, source_id, target_id, edge_type),
          CHECK (source_id <> target_id),
          FOREIGN KEY (tenant_id, namespace, source_id)
            REFERENCES ${s}.insights(tenant_id, namespace, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, namespace, target_id)
            REFERENCES ${s}.insights(tenant_id, namespace, id) ON DELETE CASCADE
      )
    `,
			`
      CREATE TABLE IF NOT EXISTS ${s}.oplog (
          id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,${TENANCY_COLUMNS}
          namespace   text NOT NULL CHECK (char_length(namespace) BETWEEN 1 AND 200),
          operation   text NOT NULL,
          insight_id  uuid,
          detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at  timestamptz NOT NULL,
          FOREIGN KEY (tenant_id, namespace, insight_id)
            REFERENCES ${s}.insights(tenant_id, namespace, id)
      )
    `,
			`
      CREATE TABLE IF NOT EXISTS ${s}.operations (${TENANCY_COLUMNS}
          namespace   text NOT NULL CHECK (char_length(namespace) BETWEEN 1 AND 200),
          key         text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 512),
          result      jsonb NOT NULL,
          created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY (tenant_id, namespace, key)
      )
    `,
		];
		for (const ddl of tables) {
			await client.query(ddl);
		}

		const indexes = [
			`
      CREATE UNIQUE INDEX IF NOT EXISTS insights_active_content_hash_uq
          ON ${s}.insights (tenant_id, namespace, content_hash)
          WHERE deleted_at IS NULL AND managed = false
    `,
			`
      CREATE INDEX IF NOT EXISTS insights_active_created_idx
          ON ${s}.insights (tenant_id, namespace, created_at DESC, id)
          WHERE deleted_at IS NULL
    `,
			`
      CREATE INDEX IF NOT EXISTS insights_active_source_created_idx
          ON ${s}.insights (tenant_id, namespace, source, created_at DESC, id)
          WHERE deleted_at IS NULL
    `,
			`
      CREATE INDEX IF NOT EXISTS insights_search_tokens_gin_idx
          ON ${s}.insights USING gin (search_tokens)
          WHERE deleted_at IS NULL
    `,
			`
      CREATE INDEX IF NOT EXISTS insights_search_tsv_gin_idx
          ON ${s}.insights USING gin (search_tsv)
          WHERE deleted_at IS NULL
    `,
			`
      CREATE INDEX IF NOT EXISTS insights_entities_gin_idx
          ON ${s}.insights USING gin (entities jsonb_path_ops)
          WHERE deleted_at IS NULL
    `,
			`
      CREATE INDEX IF NOT EXISTS insights_active_embedding_present_idx
          ON ${s}.insights (tenant_id, namespace, id)
          WHERE deleted_at IS NULL AND embedding IS NOT NULL
    `,
			`
      CREATE INDEX IF NOT EXISTS edges_target_type_idx
          ON ${s}.edges (tenant_id, namespace, target_id, edge_type)
    `,
			`
      CREATE INDEX IF NOT EXISTS edges_source_type_idx
          ON ${s}.edges (tenant_id, namespace, source_id, edge_type)
    `,
			`
      CREATE INDEX IF NOT EXISTS oplog_created_idx
          ON ${s}.oplog (tenant_id, namespace, created_at DESC, id DESC)
    `,
			`
      CREATE INDEX IF NOT EXISTS operations_created_idx
          ON ${s}.operations (created_at)
    `,
		];
		for (const ddl of indexes) {
			await client.query(ddl);
		}

		for (const table of RLS_TABLES) {
			await client.query(`ALTER TABLE ${s}.${table} ENABLE ROW LEVEL SECURITY`);
			// FORCE applies the policy to the table owner too.
			await client.query(`ALTER TABLE ${s}.${table} FORCE ROW LEVEL SECURITY`);
			await client.query(`DROP POLICY IF EXISTS mnemon_tenant ON ${s}.${table}`);
			await client.query(
				`CREATE POLICY mnemon_tenant ON ${s}.${table} USING (${TENANT_MATCH}) WITH CHECK (${TENANT_MATCH})`,
			);
		}

		await client.query(`INSERT INTO ${s}.schema_migrations (version) VALUES (1)`);
		await upgradeToV2(client, s);
		return MIGRATION_VERSION;
	}).catch((error: unknown) => {
		if (error instanceof MnemonConfigurationError) {
			throw error;
		}
		throw wrapDatabaseError(error);
	});
	try {
		return await migrate();
	} catch (error) {
		// The advisory lock does not refresh cached catalog lookups, so a
		// concurrent first install can still collide once; the retry sees it.
		if (error instanceof MnemonDatabaseError && DUPLICATE_OBJECT.has(error.code ?? "")) {
			return migrate();
		}
		throw error;
	}
}

/**
 * v2 is additive, so a 0.1.0 (v1) schema upgrades in place. Edges written
 * before v2 count as explicit: upsert never prunes them.
 */
async function upgradeToV2(client: PoolClient, s: string): Promise<void> {
	await client.query(
		`ALTER TABLE ${s}.edges ADD COLUMN IF NOT EXISTS derived boolean NOT NULL DEFAULT false`,
	);
	// Serves case-insensitive entity matching when new edges are derived.
	await client.query(`
      CREATE INDEX IF NOT EXISTS insights_entities_lower_gin_idx
          ON ${s}.insights USING gin ((lower(entities::text)::jsonb) jsonb_path_ops)
          WHERE deleted_at IS NULL
    `);
	await client.query(
		`INSERT INTO ${s}.schema_migrations (version) VALUES (2)`,
	);
}

/** Serializes concurrent DDL from several instances booting at once. */
async function lockSchema(client: PoolClient, schema: string): Promise<void> {
	await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
		`mnemon:ddl:${schema}`,
	]);
}

/**
 * Creates the HNSW index vector search uses once the embedding dimensions are
 * known. Idempotent; skips the DDL when the index exists, so an app role
 * without CREATE works after the owner has run it once. An index built for
 * other dimensions is an error: queries would skip it and writes would fail.
 */
export async function ensureVectorIndex(
	pool: Pool,
	schema: string,
	dimensions: number,
): Promise<void> {
	const s = quoteIdent(schema);
	const index = `${s}.insights_embedding_hnsw_idx`;
	const check = async (client: Pool | PoolClient) => {
		// The indexed expression's typmod is its vector dimension.
		const found = await client.query<{ dimensions: number }>(
			"SELECT atttypmod AS dimensions FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum = 1",
			[index],
		);
		const built = found.rows[0]?.dimensions;
		if (built !== undefined && built !== dimensions) {
			throw new MnemonConfigurationError(
				`${index} was built for ${String(built)} embedding dimensions, not ${String(dimensions)}; drop it and reconnect`,
			);
		}
		return built !== undefined;
	};
	if (await check(pool)) {
		return;
	}
	await withTransaction(pool, async (client) => {
		// A table lock, unlike an advisory one, refreshes the catalog lookup below.
		await client.query(`LOCK TABLE ${s}.insights IN SHARE ROW EXCLUSIVE MODE`);
		if (await check(client)) {
			return;
		}
		await client.query(`
      CREATE INDEX insights_embedding_hnsw_idx
          ON ${s}.insights USING hnsw ((embedding::vector(${String(dimensions)})) vector_cosine_ops)
          WHERE deleted_at IS NULL AND embedding IS NOT NULL
    `);
	});
}

/** Vector search relies on hnsw.iterative_scan, which older pgvector ignores. */
export async function assertPgvectorVersion(pool: Pool): Promise<void> {
	const result = await pool.query<{ version: string | null }>(
		"SELECT extversion AS version FROM pg_extension WHERE extname = 'vector'",
	);
	const version = result.rows[0]?.version;
	if (version == null) {
		throw new MnemonConfigurationError("pgvector extension is not installed");
	}
	const [major = 0, minor = 0] = version.split(".").map(Number);
	if (major === 0 && minor < 8) {
		throw new MnemonConfigurationError(
			`pgvector ${version} is too old; 0.8 or later is required with an embedding provider (ALTER EXTENSION vector UPDATE)`,
		);
	}
}

/**
 * Installs the opt-in restrictive per-user policy. Idempotent. Never drops the
 * policy: turning enforcement off must be a deliberate manual DDL change.
 */
export async function ensureUserScopePolicy(
	pool: Pool,
	schema: string,
): Promise<void> {
	const s = quoteIdent(schema);
	await withTransaction(pool, async (client) => {
		await lockSchema(client, schema);
		const existing = await client.query<{ tablename: string }>(
			`SELECT tablename FROM pg_policies WHERE schemaname = $1 AND policyname = 'mnemon_user'`,
			[schema],
		);
		const present = new Set(existing.rows.map((row) => row.tablename));
		for (const table of RLS_TABLES) {
			if (present.has(table)) {
				continue;
			}
			await client.query(
				`CREATE POLICY mnemon_user ON ${s}.${table} AS RESTRICTIVE USING (${USER_MATCH}) WITH CHECK (${USER_MATCH})`,
			);
		}
	});
}

/** Fails when the connected role would silently bypass row-level security. */
export async function assertRlsEnforced(pool: Pool): Promise<void> {
	let bypass: boolean;
	try {
		const result = await pool.query<{ bypass: boolean }>(
			"SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user",
		);
		bypass = result.rows[0]?.bypass ?? true;
	} catch (error) {
		throw wrapDatabaseError(error);
	}
	if (bypass) {
		throw new MnemonConfigurationError(
			"connected role is a superuser or has BYPASSRLS; row-level security would not apply. Connect as a regular role or set allowRlsBypass",
		);
	}
}

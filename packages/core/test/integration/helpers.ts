import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import type { Clock } from "../../src/clock.js";
import { quoteIdent } from "../../src/config.js";
import type { EmbeddingProvider } from "../../src/embedding-provider.js";
import { createMnemon } from "../../src/mnemon.js";
import type {
	Mnemon,
	MnemonAuthorization,
	MnemonClient,
} from "../../src/types.js";

export const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? "";
/** Non-superuser, NOBYPASSRLS role the library connects as in tests. */
export const APP_ROLE = "mnemon_test_app";
export const TEST_TENANT = "tenant-test";
export const TEST_NAMESPACE = "test-application";

let prepared: Promise<boolean> | undefined;

/** Superuser pool for fixtures and out-of-band verification. */
export function adminPool(): Pool {
	return new Pool({ connectionString: DATABASE_URL });
}

/** Pool whose sessions run as APP_ROLE, so RLS applies. */
export function appPool(): Pool {
	return new Pool({
		connectionString: DATABASE_URL,
		options: `-c role=${APP_ROLE}`,
	});
}

export function postgresAvailable(): Promise<boolean> {
	prepared ??= prepare();
	return prepared;
}

async function prepare(): Promise<boolean> {
	if (!DATABASE_URL) {
		return false;
	}
	const pool = new Pool({
		connectionString: DATABASE_URL,
		connectionTimeoutMillis: 1500,
	});
	try {
		await pool.query("SELECT 1");
	} catch {
		await pool.end();
		return false;
	}
	try {
		await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
		await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$`);
		const db = await pool.query<{ db: string }>(
			"SELECT current_database() AS db",
		);
		await pool.query(
			`GRANT CREATE ON DATABASE ${quoteIdent(db.rows[0]?.db ?? "")} TO ${APP_ROLE}`,
		);
		return true;
	} finally {
		await pool.end();
	}
}

export function uniqueSchema(): string {
	return `mnemon_t_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export interface MnemonTestContext {
	schema: string;
	/** APP_ROLE pool; raw queries here are subject to RLS. */
	pool: Pool;
	/** Superuser pool; bypasses RLS. */
	admin: Pool;
	client: MnemonClient;
	scope(auth?: Partial<MnemonAuthorization>): Mnemon;
}

export async function withMnemon(
	options: {
		namespace?: string;
		tenantId?: string;
		userId?: string | null;
		clock?: Clock;
		embeddingProvider?: EmbeddingProvider;
		pool?: Pool;
		enforceUserScope?: boolean;
	},
	fn: (mnemon: Mnemon, ctx: MnemonTestContext) => Promise<void>,
): Promise<void> {
	const schema = uniqueSchema();
	const ownsPool = !options.pool;
	const pool = options.pool ?? appPool();
	const admin = adminPool();
	const client = createMnemon({
		pool,
		schema,
		clock: options.clock,
		embeddingProvider: options.embeddingProvider,
		enforceUserScope: options.enforceUserScope,
	});
	const scope = (auth?: Partial<MnemonAuthorization>) =>
		client.scope({
			tenantId: options.tenantId ?? TEST_TENANT,
			userId: options.userId ?? null,
			namespace: options.namespace ?? TEST_NAMESPACE,
			...auth,
		});
	try {
		await client.initialize();
		await fn(scope(), { schema, pool, admin, client, scope });
	} finally {
		try {
			await client.close();
		} catch {}
		try {
			await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
		} catch {}
		await admin.end().catch(() => {});
		if (ownsPool) {
			await pool.end().catch(() => {});
		}
	}
}

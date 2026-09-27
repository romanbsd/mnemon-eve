import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { quoteIdent } from "../../src/config.js";
import { MnemonConfigurationError } from "../../src/errors.js";
import { createMnemon } from "../../src/mnemon.js";
import {
	ensureUserScopePolicy,
	runMigrations,
} from "../../src/postgres/migrations.js";
import { FakeClock } from "../fake-clock.js";
import { FakeEmbeddingProvider } from "../fake-embedding-provider.js";
import {
	APP_ROLE,
	adminPool,
	appPool,
	postgresAvailable,
	uniqueSchema,
	withMnemon,
} from "./helpers.js";

const available = await postgresAvailable();

describe.skipIf(!available)("row-level security", () => {
	const clock = new FakeClock(new Date("2024-06-01T00:00:00Z"));
	const namespace = "shared-namespace";

	it("isolates tenants sharing a namespace, ids, and content", async () => {
		await withMnemon({ clock, namespace, tenantId: "tenant-a" }, async (a, { scope }) => {
			const b = scope({ tenantId: "tenant-b" });
			const content = "Deploys go out on Tuesdays via the blue pipeline";
			const fromA = await a.remember({ content });
			const fromB = await b.remember({ content });
			expect(fromB.action).toBe("added");
			expect(fromB.insight.id).not.toBe(fromA.insight.id);

			expect(await b.get(fromA.insight.id)).toBeNull();
			expect((await b.forget(fromA.insight.id)).forgotten).toBe(false);
			expect((await b.list()).map((i) => i.id)).toEqual([fromB.insight.id]);
			const hits = await b.recall({ query: "deploy pipeline" });
			expect(hits.results.map((h) => h.insight.id)).toEqual([fromB.insight.id]);
			expect((await b.log()).every((e) => e.insightId !== fromA.insight.id)).toBe(true);

			// Same caller-chosen id in both tenants must not collide.
			const id = randomUUID();
			await a.upsert({ id, content: "tenant a managed row" });
			await b.upsert({ id, content: "tenant b managed row" });
			expect((await a.get(id))?.content).toBe("tenant a managed row");
			expect((await b.get(id))?.content).toBe("tenant b managed row");
			expect(await a.get(fromA.insight.id)).not.toBeNull();
		});
	});

	it("keeps the same user id apart across tenants", async () => {
		await withMnemon(
			{ clock, namespace, tenantId: "tenant-a", userId: "user-1", enforceUserScope: true },
			async (a1, { scope }) => {
				const b1 = scope({ tenantId: "tenant-b", userId: "user-1" });
				const saved = await a1.remember({ content: "Prefers dark mode everywhere" });
				expect(await b1.get(saved.insight.id)).toBeNull();
				expect(await b1.list()).toEqual([]);
			},
		);
	});

	it("does not enforce user separation with enforceUserScope off", async () => {
		await withMnemon(
			{ clock, namespace, tenantId: "tenant-a", userId: "user-1", enforceUserScope: false },
			async (u1, { scope }) => {
				const saved = await u1.remember({ content: "Prefers terse answers" });
				expect(await scope({ userId: "user-2" }).get(saved.insight.id)).not.toBeNull();
				expect(await scope({ userId: null }).get(saved.insight.id)).not.toBeNull();
			},
		);
	});

	it("separates users and tenant-level rows when enforceUserScope is on", async () => {
		await withMnemon(
			{
				clock,
				namespace: "user-1-namespace",
				tenantId: "tenant-a",
				userId: "user-1",
				enforceUserScope: true,
			},
			async (u1, { scope }) => {
				const u2 = scope({ userId: "user-2", namespace: "user-2-namespace" });
				const tenantWide = scope({ userId: null, namespace: "user-1-namespace" });
				const saved = await u1.remember({ content: "Prefers terse answers" });
				expect(await u2.get(saved.insight.id)).toBeNull();
				expect(await tenantWide.get(saved.insight.id)).toBeNull();
				// Even with the right namespace, another user sees nothing.
				const intruder = scope({ userId: "user-2" });
				expect(await intruder.get(saved.insight.id)).toBeNull();
				expect(await intruder.list()).toEqual([]);
				expect(await u1.get(saved.insight.id)).not.toBeNull();
			},
		);
	});

	it("never returns cross-tenant vector neighbours", async () => {
		const provider = new FakeEmbeddingProvider("fixture", 4, {
			"Q3 revenue target is 4M": [1, 0, 0, 0],
			"Q3 revenue target is 5M": [0.999, 0.01, 0, 0],
			"query:revenue target": [1, 0, 0, 0],
		});
		await withMnemon(
			{ clock, namespace, tenantId: "tenant-a", embeddingProvider: provider },
			async (a, { scope }) => {
				const b = scope({ tenantId: "tenant-b" });
				await a.remember({ content: "Q3 revenue target is 4M" });
				const own = await b.remember({ content: "Q3 revenue target is 5M" });
				expect(own.semanticCandidates).toEqual([]);
				const hits = await b.recall({ query: "revenue target" });
				expect(hits.results.map((h) => h.insight.content)).toEqual([
					"Q3 revenue target is 5M",
				]);
			},
		);
	});

	it("filters raw SQL that omits the namespace and tenant predicates", async () => {
		await withMnemon({ clock, tenantId: "tenant-a" }, async (a, { pool, schema, scope }) => {
			await a.remember({ content: "tenant a secret plan" });
			await scope({ tenantId: "tenant-b" }).remember({ content: "tenant b plan" });
			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				await client.query("SELECT set_config('mnemon.tenant_id', 'tenant-b', true)");
				const rows = await client.query<{ content: string }>(
					`SELECT content FROM ${quoteIdent(schema)}.insights`,
				);
				expect(rows.rows.map((r) => r.content)).toEqual(["tenant b plan"]);
				await expect(
					client.query(
						`UPDATE ${quoteIdent(schema)}.insights SET tenant_id = 'tenant-a'`,
					),
				).rejects.toMatchObject({ code: "42501" });
				await client.query("ROLLBACK");

				// No tenant context: nothing is visible, nothing is insertable.
				const none = await client.query(
					`SELECT count(*)::int AS count FROM ${quoteIdent(schema)}.insights`,
				);
				expect(none.rows[0]?.count).toBe(0);
				await expect(
					client.query(
						`INSERT INTO ${quoteIdent(schema)}.operations (namespace, key, result) VALUES ('n', 'k', '{}')`,
					),
				).rejects.toBeTruthy();
			} finally {
				client.release();
			}
		});
	});

	it("replays once() results instead of re-running", async () => {
		await withMnemon({ clock }, async (_m, { client, scope }) => {
			const auth = { tenantId: "tenant-a", namespace };
			let runs = 0;
			const run = () =>
				client.withAuthorization(auth, (tx) =>
					tx.once("op-1", async (m) => {
						runs += 1;
						return (await m.remember({ content: `write ${runs}` })).insight.id;
					}),
				);
			const first = await run();
			const second = await run();
			expect(first.replayed).toBe(false);
			expect(second).toEqual({ value: first.value, replayed: true });
			expect(runs).toBe(1);
			// Same key in another tenant is an independent operation.
			const other = await client.withAuthorization(
				{ tenantId: "tenant-b", namespace },
				(tx) => tx.once("op-1", async () => "b"),
			);
			expect(other).toEqual({ value: "b", replayed: false });
			expect(await scope({ tenantId: "tenant-a", namespace }).list()).toHaveLength(1);
		});
	});

	it("refuses roles that bypass RLS unless explicitly allowed", async () => {
		const admin = adminPool();
		const schema = uniqueSchema();
		try {
			const refused = createMnemon({ pool: admin, schema, clock });
			await expect(refused.initialize()).rejects.toThrow(/row-level security|BYPASSRLS|superuser/i);
			const allowed = createMnemon({ pool: admin, schema, clock, allowRlsBypass: true });
			await allowed.initialize();
		} finally {
			await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`).catch(() => {});
			await admin.end();
		}
	});

	it("refuses a schema migrated to another version", async () => {
		const admin = adminPool();
		const schema = uniqueSchema();
		const s = quoteIdent(schema);
		try {
			await admin.query(`CREATE SCHEMA ${s}`);
			await admin.query(`CREATE TABLE ${s}.schema_migrations (version integer PRIMARY KEY)`);
			await admin.query(`INSERT INTO ${s}.schema_migrations VALUES (99)`);
			await expect(runMigrations(admin, schema)).rejects.toThrow(MnemonConfigurationError);
			await expect(runMigrations(admin, schema)).rejects.toThrow(/version 99 is incompatible/);
		} finally {
			await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`).catch(() => {});
			await admin.end();
		}
	});

	it("upgrades a v1 schema in place", async () => {
		const admin = adminPool();
		const schema = uniqueSchema();
		const s = quoteIdent(schema);
		try {
			await runMigrations(admin, schema);
			// Roll back to the 0.1.0 shape.
			await admin.query(`ALTER TABLE ${s}.edges DROP COLUMN derived`);
			await admin.query(`DROP INDEX ${s}.insights_entities_lower_gin_idx`);
			await admin.query(`DELETE FROM ${s}.schema_migrations WHERE version = 2`);

			expect(await runMigrations(admin, schema)).toBe(2);
			const found = await admin.query(
				`SELECT to_regclass($1) IS NOT NULL AS index,
				        EXISTS (SELECT 1 FROM information_schema.columns
				                WHERE table_schema = $2 AND table_name = 'edges' AND column_name = 'derived') AS column`,
				[`${s}.insights_entities_lower_gin_idx`, schema],
			);
			expect(found.rows[0]).toEqual({ index: true, column: true });
		} finally {
			await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`).catch(() => {});
			await admin.end();
		}
	});

	it("creates the HNSW index for the provider's dimensions", async () => {
		const provider = new FakeEmbeddingProvider("fixture", 4, {});
		await withMnemon({ clock, embeddingProvider: provider }, async (_m, { admin, schema }) => {
			const index = await admin.query<{ def: string }>(
				"SELECT pg_get_indexdef($1::regclass) AS def",
				[`${quoteIdent(schema)}.insights_embedding_hnsw_idx`],
			);
			expect(index.rows[0]?.def).toMatch(/hnsw \(\(\(embedding\)::vector\(4\)\) vector_cosine_ops\)/);
		});
	});

	it("installs the user-scope policy idempotently", async () => {
		const admin = adminPool();
		const schema = uniqueSchema();
		try {
			await runMigrations(admin, schema);
			await ensureUserScopePolicy(admin, schema);
			await ensureUserScopePolicy(admin, schema);
			const { rows } = await admin.query<{ n: string }>(
				"SELECT count(*) AS n FROM pg_policies WHERE schemaname = $1 AND policyname = 'mnemon_user'",
				[schema],
			);
			expect(Number(rows[0]?.n)).toBe(4);
		} finally {
			await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`).catch(() => {});
			await admin.end();
		}
	});

	it("runs with a DML-only app role after an owner migrates", async () => {
		const admin = adminPool();
		const app = appPool();
		const schema = uniqueSchema();
		const s = quoteIdent(schema);
		try {
			const owner = createMnemon({ pool: admin, schema, clock, allowRlsBypass: true });
			await owner.initialize();
			await admin.query(`GRANT USAGE ON SCHEMA ${s} TO ${APP_ROLE}`);
			await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${APP_ROLE}`);
			await admin.query(
				`GRANT INSERT, UPDATE, DELETE ON ${s}.insights, ${s}.edges, ${s}.oplog, ${s}.operations TO ${APP_ROLE}`,
			);
			await admin.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${s} TO ${APP_ROLE}`);
			const client = createMnemon({ pool: app, schema, clock });
			const m = client.scope({ tenantId: "tenant-a", namespace });
			const saved = await m.remember({ content: "Owner migrated, app writes" });
			expect(await m.get(saved.insight.id)).not.toBeNull();
			await client.close();
		} finally {
			await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`).catch(() => {});
			await Promise.all([admin.end(), app.end()]);
		}
	});
});

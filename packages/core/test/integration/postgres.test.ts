import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import type { DiffJudge } from "../../src/engine/diff.js";
import type { CausalJudge } from "../../src/engine/edges.js";
import { createMnemon } from "../../src/mnemon.js";
import { FakeClock } from "../fake-clock.js";
import {
	FakeEmbeddingProvider,
	unitVector,
} from "../fake-embedding-provider.js";
import {
	appPool,
	postgresAvailable,
	TEST_TENANT,
	withMnemon,
} from "./helpers.js";

const available = await postgresAvailable();

describe.skipIf(!available)("postgres integration", () => {
	const clock = new FakeClock(new Date("2024-06-01T00:00:00Z"));

	it("isolates identical content, retrieval, graph traversal, logs, and mutations across three namespaces", async () => {
		await withMnemon(
			{ clock, namespace: "application-alpha" },
			async (alpha, { admin, schema, scope }) => {
				const beta = scope({ namespace: "application-beta" });
				const gamma = scope({ namespace: "application-gamma" });

				const scopedClients = [
					{ client: alpha, namespace: "application-alpha" },
					{ client: beta, namespace: "application-beta" },
					{ client: gamma, namespace: "application-gamma" },
				] as const;
				const namespaces = scopedClients.map(({ namespace }) => namespace);
				const ids = new Map<string, Set<string>>();

				for (const { client, namespace } of scopedClients) {
					const shared = await client.remember({
						content: "Shared lifecycle observation",
						entities: ["SharedEntity"],
					});
					const unique = await client.remember({
						content: `Private ${namespace} lifecycle detail`,
						entities: ["SharedEntity", `${namespace}-only`],
					});
					expect(shared.action).toBe("added");
					ids.set(namespace, new Set([shared.insight.id, unique.insight.id]));
				}

				for (const { client, namespace } of scopedClients) {
					const ownIds = ids.get(namespace) ?? new Set<string>();
					const recalled = await client.recall({
						query: "SharedEntity lifecycle",
						limit: 20,
					});
					const searched = await client.search({
						query: "lifecycle",
						limit: 20,
					});
					const listed = await client.list({ limit: 20 });
					const related = await client.related([...ownIds][0] ?? "");
					const logged = await client.log({ limit: 20 });

					expect(recalled.results.length).toBeGreaterThan(0);
					expect(
						recalled.results.every((hit) => ownIds.has(hit.insight.id)),
					).toBe(true);
					expect(
						searched.results.every((hit) => ownIds.has(hit.insight.id)),
					).toBe(true);
					expect(listed.map((insight) => insight.id).sort()).toEqual(
						[...ownIds].sort(),
					);
					expect(related.every((insight) => ownIds.has(insight.id))).toBe(true);
					expect(logged).toHaveLength(3);
					expect(logged.map((entry) => entry.operation).sort()).toEqual([
						"recall",
						"remember",
						"remember",
					]);
					expect(
						logged.every(
							(entry) =>
								entry.insightId === undefined || ownIds.has(entry.insightId),
						),
					).toBe(true);
					const status = await client.status();
					expect(status).toMatchObject({
						namespace,
						insights: 2,
						embeddings: 0,
					});
					expect(status.edges).toBeGreaterThan(0);
				}

				const alphaIds = ids.get("application-alpha") ?? new Set<string>();
				const betaIds = ids.get("application-beta") ?? new Set<string>();
				const alphaId = [...alphaIds][0] ?? "";
				const betaId = [...betaIds][0] ?? "";
				expect(await alpha.get(betaId)).toBeNull();
				expect(await alpha.forget(betaId)).toEqual({
					forgotten: false,
					id: betaId,
				});
				await expect(
					alpha.link({
						sourceId: alphaId,
						targetId: betaId,
						edgeType: "entity",
					}),
				).rejects.toThrow(/not found/u);
				expect(await beta.get(betaId)).not.toBeNull();

				const grouped = await admin.query<{ namespace: string; count: number }>(
					`SELECT namespace, count(*)::int AS count FROM "${schema}".insights GROUP BY namespace ORDER BY namespace`,
				);
				expect(grouped.rows).toEqual(
					namespaces.map((namespace) => ({ namespace, count: 2 })),
				);

				await expect(
					admin.query(
						`INSERT INTO "${schema}".edges
              (tenant_id, namespace, source_id, target_id, edge_type, weight, metadata, created_at)
             VALUES ($1, $2, $3::uuid, $4::uuid, 'entity', 1, '{}'::jsonb, $5)`,
						[TEST_TENANT, "application-alpha", alphaId, betaId, clock.now()],
					),
				).rejects.toMatchObject({ code: "23503" });
			},
		);
	});

	it("does not use another namespace as an entity dictionary", async () => {
		await withMnemon(
			{ clock, namespace: "application-alpha" },
			async (alpha, { admin, schema, scope }) => {
				const beta = scope({ namespace: "application-beta" });
				await beta.remember({
					content: "private beta vocabulary",
					entities: ["betamarker"],
				});

				const alphaResult = await alpha.remember({
					content: "betamarker appears only as ordinary text here",
				});
				expect(alphaResult.insight.entities).not.toContain("betamarker");
				const alphaEntityEdges = await admin.query<{ count: number }>(
					`SELECT count(*)::int AS count FROM "${schema}".edges WHERE namespace = $1 AND edge_type = 'entity'`,
					["application-alpha"],
				);
				expect(alphaEntityEdges.rows[0]?.count).toBe(0);
			},
		);
	});

	it("runs migrations idempotently", async () => {
		await withMnemon({ clock }, async (_mnemon, { pool, schema }) => {
			const second = createMnemon({ pool, schema, clock });
			await second.initialize();
			await second.close();
		});
	});

	it("round-trips insights and skips exact duplicates", async () => {
		await withMnemon({ clock }, async (mnemon) => {
			const first = await mnemon.remember({
				content: "Exact hash body",
				createdAt: "2024-06-01T00:00:00Z",
			});
			expect(first.action).toBe("added");
			const second = await mnemon.remember({ content: " exact   HASH body " });
			expect(second.action).toBe("skipped");
			expect(second.duplicateOf).toBe(first.insight.id);
			const loaded = await mnemon.get(first.insight.id);
			expect(loaded?.content).toBe("Exact hash body");
		});
	});

	it("idempotently upserts and revives caller-managed insights", async () => {
		await withMnemon({ clock }, async (mnemon, { admin, schema }) => {
			const id = randomUUID();
			const first = await mnemon.upsert({
				id,
				content: "Canonical lifecycle learning",
				category: "fact",
				metadata: { confidence: 0.8, evidenceIds: [randomUUID()] },
			});
			const replay = await mnemon.upsert({
				id,
				content: "Canonical lifecycle learning",
				category: "fact",
				metadata: { confidence: 0.8, evidenceIds: first.metadata.evidenceIds },
			});
			expect(replay).toMatchObject({ id, metadata: first.metadata });

			const sameContent = await mnemon.upsert({
				id: randomUUID(),
				content: "Canonical lifecycle learning",
			});
			expect(sameContent.id).not.toBe(id);
			const ordinary = await mnemon.remember({
				content: "Canonical lifecycle learning",
			});
			expect(ordinary.action).toBe("added");
			await expect(
				mnemon.remember({ content: "Canonical lifecycle learning" }),
			).resolves.toMatchObject({
				action: "skipped",
				duplicateOf: ordinary.insight.id,
			});

			await mnemon.forget(id);
			expect(await mnemon.get(id)).toBeNull();
			await mnemon.upsert({
				id,
				content: "Canonical lifecycle learning",
				metadata: first.metadata,
			});
			expect(await mnemon.get(id)).toMatchObject({
				id,
				metadata: first.metadata,
			});

			const rows = await admin.query<{ count: number }>(
				`SELECT count(*)::int AS count FROM "${schema}".insights WHERE namespace = $1 AND id = $2`,
				["test-application", id],
			);
			expect(rows.rows[0]?.count).toBe(1);
		});
	});

	it("does not discard extensions or corrections", async () => {
		await withMnemon({ clock }, async (mnemon) => {
			const base = await mnemon.remember({
				content: "Prefer TypeScript for services",
			});
			const ext = await mnemon.remember({
				content:
					"Prefer TypeScript for services because the team already knows it",
			});
			const neg = await mnemon.remember({
				content: "Do not prefer TypeScript for services",
			});
			expect(base.action).toBe("added");
			expect(ext.action).toBe("added");
			expect(neg.action).toBe("added");
			expect(neg.suggestion).toBe("DUPLICATE");
			expect(await mnemon.get(base.insight.id)).not.toBeNull();
			const conflict = await mnemon.remember({
				content: "No longer prefer TypeScript for services",
			});
			expect(conflict.action).toBe("added");
			expect(conflict.suggestion).toBe("CONFLICT");
			expect(await mnemon.get(base.insight.id)).not.toBeNull();
		});
	});

	it("uses the diff judge and keeps the heuristic when it fails", async () => {
		const judged = new Map<string, number>();
		const diffJudge: DiffJudge = async ({ content, candidates }) => {
			judged.set(content, candidates.length);
			if (content.startsWith("Boom")) throw new Error("judge down");
			return Object.fromEntries(candidates.map((c) => [c.id, "contradicts"]));
		};
		await withMnemon({ clock, diffJudge }, async (mnemon) => {
			await mnemon.remember({ content: "Prefer TypeScript for services" });
			expect(judged.size).toBe(0);
			const neg = await mnemon.remember({
				content: "Do not prefer TypeScript for services",
			});
			expect(neg.suggestion).toBe("CONFLICT");
			expect(neg.diff.every((m) => m.suggestion === "CONFLICT")).toBe(true);
			const boom = await mnemon.remember({
				content: "Boom prefer TypeScript for services",
			});
			expect(boom.action).toBe("added");
			expect(boom.suggestion).not.toBe("CONFLICT");
			expect(judged.get("Boom prefer TypeScript for services")).toBeGreaterThan(0);
		});
	});

	it("uses the causal judge and keeps the heuristic when it fails", async () => {
		const causalJudge: CausalJudge = async ({ content, previous }) => {
			if (content.startsWith("Boom")) throw new Error("judge down");
			return Object.fromEntries(
				previous.map((p) => [p.id, { relation: "existing_causes_new", weight: 0.7 }]),
			);
		};
		await withMnemon({ clock, causalJudge }, async (mnemon) => {
			const first = await mnemon.remember({ content: "Nightly builds kept timing out" });
			expect(first.edgeCounts.causal).toBe(0);
			const second = await mnemon.remember({ content: "We moved CI to larger runners" });
			expect(second.edgeCounts.causal).toBe(1);
			const via = await mnemon.related(second.insight.id, { edgeType: "causal" });
			expect(via.map((r) => r.id)).toContain(first.insight.id);
			// Heuristic fallback: no causal phrase, so no causal edges.
			const boom = await mnemon.remember({ content: "Boom the office moved downtown" });
			expect(boom.action).toBe("added");
			expect(boom.edgeCounts.causal).toBe(0);
		});
	});

	it("scores entity overlap case-insensitively", async () => {
		await withMnemon({ clock }, async (mnemon) => {
			const added = await mnemon.remember({
				content: "Prefers the language for services",
				entities: ["typescript"],
			});
			const recalled = await mnemon.recall({
				query: "tell me about TypeScript",
				intent: "ENTITY",
			});
			const hit = recalled.results.find(
				(r) => r.insight.id === added.insight.id,
			);
			expect(hit?.signals.entity).toBeGreaterThan(0);
		});
	});

	it("creates entity edges when persisted and new values differ only by case", async () => {
		await withMnemon({ clock }, async (mnemon) => {
			const first = await mnemon.remember({
				content: "Prefers the language for services",
				entities: ["TypeScript"],
			});
			const second = await mnemon.remember({
				content: "Talk about the same language later",
				entities: ["typescript"],
			});
			const related = await mnemon.related(first.insight.id, {
				edgeType: "entity",
			});
			expect(related.some((r) => r.id === second.insight.id)).toBe(true);
		});
	});

	it("stores embeddings and returns cosine neighbors", async () => {
		const provider = new FakeEmbeddingProvider("fixture", 4, {
			"document:alpha": unitVector(4, 0),
			"query:alpha": unitVector(4, 0),
			alpha: unitVector(4, 0),
			"document:beta": [0.99, 0.1, 0, 0],
			"document:gamma": unitVector(4, 2),
		});
		await withMnemon({ clock, embeddingProvider: provider }, async (mnemon) => {
			const a = await mnemon.remember({ content: "alpha" });
			await mnemon.remember({ content: "beta" });
			await mnemon.remember({ content: "gamma" });
			expect(a.action).toBe("added");
			const recalled = await mnemon.recall({ query: "alpha", limit: 3 });
			expect(recalled.results.some((r) => r.insight.content === "beta")).toBe(
				true,
			);
		});
	});

	it("forgets atomically and hides the insight from recall", async () => {
		await withMnemon({ clock }, async (mnemon) => {
			const added = await mnemon.remember({
				content: "forgettable lunar fact",
			});
			await mnemon.link({
				sourceId: added.insight.id,
				targetId: (await mnemon.remember({ content: "other node" })).insight.id,
				edgeType: "entity",
			});
			const result = await mnemon.forget(added.insight.id);
			expect(result.forgotten).toBe(true);
			expect(await mnemon.get(added.insight.id)).toBeNull();
			const again = await mnemon.forget(added.insight.id);
			expect(again.forgotten).toBe(false);
			const recalled = await mnemon.recall({ query: "lunar fact" });
			expect(
				recalled.results.every((r) => r.insight.id !== added.insight.id),
			).toBe(true);
		});
	});

	it("projects a brief excerpt and keeps the full insight behind get", async () => {
		await withMnemon({ clock }, async (mnemon) => {
			const added = await mnemon.remember({
				content:
					"Prefer TypeScript for new services because the team already knows it well",
			});
			const recalled = await mnemon.recall({
				query: "TypeScript services",
				brief: true,
				excerptChars: 24,
			});
			const hit = recalled.results.find(
				(r) => r.insight.id === added.insight.id,
			);
			expect(hit?.excerpt).toBe("Prefer TypeScript for n\u2026");
			expect(hit?.insight.content).toBe(hit?.excerpt);
			const full = await mnemon.get(added.insight.id);
			expect(full?.content).toBe(
				"Prefer TypeScript for new services because the team already knows it well",
			);
		});
	});

	it("links, walks related, and leaves an injected pool open", async () => {
		const pool = appPool();
		try {
			await withMnemon({ clock, pool }, async (mnemon) => {
				const a = await mnemon.remember({ content: "node a about widgets" });
				const b = await mnemon.remember({ content: "node b about widgets" });
				await mnemon.link({
					sourceId: a.insight.id,
					targetId: b.insight.id,
					edgeType: "entity",
					weight: 0.8,
				});
				const related = await mnemon.related(a.insight.id);
				expect(related.map((r) => r.id)).toContain(b.insight.id);
				const hit = related.find((r) => r.id === b.insight.id);
				expect(hit?.depth).toBe(1);
				expect(hit?.viaEdgeType).toBe("temporal");
				const entityOnly = await mnemon.related(a.insight.id, {
					edgeType: "entity",
				});
				expect(entityOnly.find((r) => r.id === b.insight.id)?.viaEdgeType).toBe(
					"entity",
				);
				const first = await mnemon.remember({
					content: "Hestia owns the billing store",
					entities: ["Hestia"],
				});
				expect(first.insight.entities).toContain("Hestia");
				const second = await mnemon.remember({
					content: "Talk to Hestia about invoices",
				});
				expect(second.insight.entities).toContain("Hestia");
			});
			await pool.query("SELECT 1");
		} finally {
			await pool.end();
		}
	});

	it("refuses to link a forgotten insight", async () => {
		await withMnemon({ clock }, async (mnemon) => {
			const a = await mnemon.remember({ content: "node a about widgets" });
			const b = await mnemon.remember({ content: "node b about widgets" });
			await mnemon.forget(a.insight.id);
			await expect(
				mnemon.link({
					sourceId: a.insight.id,
					targetId: b.insight.id,
					edgeType: "entity",
				}),
			).rejects.toThrow(/not found/);
		});
	});

	it("rolls back a failed authorized transaction without leftover rows", async () => {
		await withMnemon({ clock }, async (mnemon, { admin, client, schema }) => {
			await mnemon.remember({ content: "stable row" });
			await expect(
				client.withAuthorization(
					{ tenantId: TEST_TENANT, namespace: "test-application" },
					async (tx) => {
						await tx.remember({ content: "doomed row" });
						throw new Error("boom");
					},
				),
			).rejects.toThrow("boom");
			const count = await admin.query(
				`SELECT count(*)::int AS n FROM "${schema}".insights`,
			);
			expect(count.rows[0]?.n).toBe(1);
		});
	});

	it("rejects a second provider with a different dimension", async () => {
		const first = new FakeEmbeddingProvider("a", 4, {
			"document:dim": unitVector(4, 0),
		});
		await withMnemon(
			{ clock, embeddingProvider: first },
			async (mnemon, { pool, schema }) => {
				await mnemon.remember({ content: "dim" });
				const second = createMnemon({
					pool,
					schema,
					embeddingProvider: new FakeEmbeddingProvider("b", 8, {
						"document:other": unitVector(8, 0),
					}),
				});
				await expect(second.initialize()).rejects.toThrow(/dimension/);
			},
		);
	});

	it("rejects a second provider with a different model", async () => {
		const first = new FakeEmbeddingProvider("a", 4, {
			"document:dim": unitVector(4, 0),
		});
		await withMnemon(
			{ clock, embeddingProvider: first },
			async (mnemon, { pool, schema }) => {
				await mnemon.remember({ content: "dim" });
				const second = createMnemon({
					pool,
					schema,
					embeddingProvider: new FakeEmbeddingProvider("b", 4, {
						"document:other": unitVector(4, 0),
					}),
				});
				await expect(second.initialize()).rejects.toThrow(/model/);
			},
		);
	});

	it("lists active insights by recency and filters", async () => {
		await withMnemon({ clock }, async (mnemon) => {
			clock.set(new Date("2024-06-01T00:00:00Z"));
			const older = await mnemon.remember({
				content: "older ops note",
				source: "ops",
				category: "fact",
				createdAt: "2024-06-01T00:00:00Z",
			});
			clock.set(new Date("2024-06-02T00:00:00Z"));
			const newer = await mnemon.remember({
				content: "newer agent note",
				source: "agent",
				category: "insight",
				createdAt: "2024-06-02T00:00:00Z",
			});
			await mnemon.forget(older.insight.id);
			const listed = await mnemon.list();
			expect(listed.map((r) => r.id)).toEqual([newer.insight.id]);
			const filtered = await mnemon.list({
				source: "agent",
				category: "insight",
				since: "2024-06-02T00:00:00Z",
				limit: 1,
			});
			expect(filtered.map((r) => r.id)).toEqual([newer.insight.id]);
			expect(await mnemon.list({ source: "ops" })).toEqual([]);
		});
	});

	it("filters recall by category", async () => {
		await withMnemon({ clock }, async (mnemon) => {
			const decision = await mnemon.remember({
				content: "deploy process uses blue green releases",
				category: "decision",
			});
			await mnemon.remember({
				content: "deploy process is documented in the wiki",
				category: "fact",
			});
			const recalled = await mnemon.recall({
				query: "deploy process",
				category: "decision",
			});
			expect(recalled.results.map((r) => r.insight.id)).toEqual([
				decision.insight.id,
			]);
			await expect(
				mnemon.recall({ query: "deploy", category: "nope" as never }),
			).rejects.toThrow(/invalid category/);
		});
	});

	it("lists retention candidates and keeps a memory out of them", async () => {
		await withMnemon({ clock }, async (mnemon) => {
			clock.set(new Date("2024-01-01T00:00:00Z"));
			const trivia = await mnemon.remember({
				content: "the cafeteria served soup on tuesday",
				importance: 1,
			});
			const routine = await mnemon.remember({
				content: "the team formats code with tabs",
				importance: 3,
			});
			await mnemon.remember({
				content: "production runs in the eu-west region",
				importance: 5,
			});
			clock.set(new Date("2024-04-01T00:00:00Z"));

			const all = await mnemon.retentionCandidates();
			expect(all.total).toBe(2);
			expect(all.candidates.map((c) => c.insight.id)).toEqual([
				trivia.insight.id,
				routine.insight.id,
			]);
			expect(all.candidates[0]?.daysSinceAccess).toBe(91);
			expect(all.candidates[0]?.effectiveImportance).toBeLessThan(0.1);

			const first = await mnemon.retentionCandidates({ limit: 1 });
			expect(first).toMatchObject({ total: 2 });
			expect(first.candidates).toHaveLength(1);
			expect(
				(await mnemon.retentionCandidates({ threshold: 0.01 })).total,
			).toBe(0);

			expect((await mnemon.keep(trivia.insight.id)).accessCount).toBe(3);
			const after = await mnemon.retentionCandidates();
			expect(after.candidates.map((c) => c.insight.id)).toEqual([
				routine.insight.id,
			]);
			expect((await mnemon.log({ operation: "gc_keep" }))[0]?.insightId).toBe(
				trivia.insight.id,
			);
			await expect(mnemon.keep(randomUUID())).rejects.toThrow(/not found/);
			clock.set(new Date("2024-06-01T00:00:00Z"));
		});
	});

	it("searches with stemming, reads the oplog, and reports status", async () => {
		await withMnemon({ clock }, async (mnemon) => {
			await mnemon.remember({
				content: "Ollama runs locally for embeddings when no cloud key exists.",
			});
			await mnemon.remember({
				content:
					"The library makes no network calls except the injected embedding provider.",
			});
			const stemmed = await mnemon.search({ query: "where do embeddings run" });
			expect(
				stemmed.results.some((r) => r.insight.content.includes("Ollama runs")),
			).toBe(true);
			expect(
				stemmed.results.some((r) => r.insight.content.includes("embedding")),
			).toBe(true);
			const ops = await mnemon.log({ operation: "remember", limit: 10 });
			expect(ops.length).toBe(2);
			expect(ops.every((o) => o.operation === "remember")).toBe(true);
			const status = await mnemon.status();
			expect(status.insights).toBe(2);
			expect(status.embeddings).toBe(0);
			expect(status.edges).toBeGreaterThan(0);
			expect(status.algorithmVersion).toBe("mnemon-ts-v1");
		});
	});

	it("handles concurrent exact-hash inserts", async () => {
		await withMnemon({ clock }, async (mnemon) => {
			const content = `race ${randomUUID()}`;
			const [a, b] = await Promise.all([
				mnemon.remember({ content }),
				mnemon.remember({ content }),
			]);
			const actions = [a.action, b.action].sort();
			expect(actions).toEqual(["added", "skipped"]);
		});
	});
});

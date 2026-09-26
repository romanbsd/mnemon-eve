import { describe, expect, it } from "vitest";

import { quoteIdent } from "../../src/config.js";
import { GRAPH_LAMBDA1 } from "../../src/engine/constants.js";
import { effectiveImportance } from "../../src/engine/retention.js";
import { PostgresMnemonStore } from "../../src/postgres/store.js";
import { FakeClock } from "../fake-clock.js";
import { postgresAvailable, TEST_NAMESPACE, withMnemon } from "./helpers.js";

const available = await postgresAvailable();

describe.skipIf(!available)("graph maintenance", () => {
	const clock = new FakeClock(new Date("2024-06-01T00:00:00Z"));

	it("refreshes effective importance on both ends of an explicit link", async () => {
		await withMnemon({ clock }, async (m, { admin, schema }) => {
			const stored = async (id: string) =>
				Number(
					(
						await admin.query<{ ei: number }>(
							`SELECT effective_importance AS ei FROM ${quoteIdent(schema)}.insights WHERE id = $1`,
							[id],
						)
					).rows[0]?.ei,
				);
			const edges = async (id: string) =>
				Number(
					(
						await admin.query<{ n: string }>(
							`SELECT count(*) AS n FROM ${quoteIdent(schema)}.edges WHERE source_id = $1 OR target_id = $1`,
							[id],
						)
					).rows[0]?.n,
				);
			const expected = async (id: string) =>
				effectiveImportance({ importance: 3, accessCount: 0, daysSinceAccess: 0, edgeCount: await edges(id) });
			const a = await m.remember({ content: "alpha lowercase memory", source: "source-a" });
			const b = await m.remember({ content: "beta unrelated note", source: "source-b" });
			const before = await edges(a.insight.id);

			await m.link({ sourceId: a.insight.id, targetId: b.insight.id, edgeType: "causal", weight: 0.8 });
			expect(await edges(a.insight.id)).toBe(before + 1);
			expect(await stored(a.insight.id)).toBeCloseTo(await expected(a.insight.id));
			expect(await stored(b.insight.id)).toBeCloseTo(await expected(b.insight.id));
		});
	});

	it("links a backdated insight between its chronological neighbours", async () => {
		await withMnemon({ clock }, async (m, { admin, schema }) => {
			const backbone = async () =>
				(
					await admin.query<{ s: string; t: string }>(
						`SELECT source_id AS s, target_id AS t FROM ${quoteIdent(schema)}.edges
             WHERE metadata->>'sub_type' = 'backbone' AND metadata->>'direction' = 'precedes'`,
					)
				).rows.map((r) => `${r.s}>${r.t}`);
			const at = (iso: string, content: string) =>
				m.remember({ content, source: "chat", createdAt: iso }).then((r) => r.insight.id);
			const older = await at("2023-01-01T00:00:00Z", "older context about apples");
			const newer = await at("2025-01-01T00:00:00Z", "newer context about pears");
			expect(await backbone()).toEqual([`${older}>${newer}`]);

			const middle = await at("2024-01-01T00:00:00Z", "imported middle context about plums");
			expect((await backbone()).sort()).toEqual([`${older}>${middle}`, `${middle}>${newer}`].sort());
			// No proximity edges: the neighbours are a year away, not stored "today".
			const proximity = await admin.query(
				`SELECT 1 FROM ${quoteIdent(schema)}.edges WHERE metadata->>'sub_type' = 'proximity'`,
			);
			expect(proximity.rowCount).toBe(0);
		});
	});

	it("walks related memories within depth, limit, edge type, and active rows", async () => {
		await withMnemon({ clock }, async (m) => {
			// Separate sources, days apart, no shared words: only explicit edges.
			const ids: string[] = [];
			for (const [i, word] of ["zero", "one", "two", "three", "four"].entries()) {
				const createdAt = new Date(Date.UTC(2024, 0, 1 + 3 * i)).toISOString();
				ids.push((await m.remember({ content: `node ${word} standalone`, source: `s${i}`, createdAt })).insight.id);
			}
			const [a, b, c, d, e] = ids as [string, string, string, string, string];
			const link = (sourceId: string, targetId: string, edgeType: "causal" | "entity") =>
				m.link({ sourceId, targetId, edgeType });
			// Chain a-b-c-d, plus e -> a pointing inward.
			await link(a, b, "causal");
			await link(b, c, "causal");
			await link(c, d, "entity");
			await link(e, a, "causal");

			const walk = async (options?: Parameters<typeof m.related>[1]) =>
				(await m.related(a, options)).map((r) => [r.id, r.depth]);
			const all = await walk({ maxDepth: 3 });
			expect(all).not.toContainEqual([a, 0]);
			expect(all).toEqual(expect.arrayContaining([[b, 1], [e, 1], [c, 2], [d, 3]]));
			expect((await walk({ maxDepth: 1 })).map(([id]) => id).sort()).toEqual([b, e].sort());
			expect(await walk({ maxDepth: 3, limit: 2 })).toHaveLength(2);
			expect((await walk({ maxDepth: 3, edgeType: "causal" })).map(([id]) => id)).not.toContain(d);

			await m.forget(b);
			expect((await walk({ maxDepth: 3 })).map(([id]) => id)).toEqual([e]);
		});
	});

	it("caps entity edges per entity and in total", async () => {
		await withMnemon({ clock }, async (m, { admin, schema }) => {
			const entities = ["Hestia", "Apollo", "Athena", "Hermes", "Demeter", "Ares"];
			let day = 0;
			const older: Record<string, string[]> = {};
			for (const entity of entities) {
				for (let i = 0; i < 6; i++) {
					// Days apart and one source each: only entity edges can form.
					const createdAt = new Date(Date.UTC(2023, 0, 1 + 3 * day)).toISOString();
					const saved = await m.remember({ content: `${entity} note ${day}`, entities: [entity], source: `s${day}`, createdAt });
					(older[entity] ??= []).push(saved.insight.id);
					day += 1;
				}
			}
			const hub = await m.remember({ content: "everyone meets", entities, source: "hub", createdAt: "2024-06-01T00:00:00Z" });
			const { rows } = await admin.query<{ target: string; entity: string }>(
				`SELECT target_id AS target, metadata->>'entity' AS entity FROM ${quoteIdent(schema)}.edges
         WHERE edge_type = 'entity' AND source_id = $1`,
				[hub.insight.id],
			);
			// MAX_TOTAL_ENTITY_EDGES = 50 edges = 25 pairs, 5 (MAX_ENTITY_LINKS) per entity.
			expect(rows).toHaveLength(25);
			const targets = (entity: string) => rows.filter((r) => r.entity === entity).map((r) => r.target);
			for (const entity of entities) expect(targets(entity).length).toBeLessThanOrEqual(5);
			// The most recent mentions win.
			expect(targets("Hestia").sort()).toEqual(older.Hestia?.slice(1).sort());
		});
	});

	it("bounds recall graph traversal by beam width and depth", async () => {
		await withMnemon({ clock }, async (m, { admin, schema }) => {
			let day = 0;
			const node = async () => {
				// Days apart and one source each: only explicit edges.
				const createdAt = new Date(Date.UTC(2023, 0, 1 + 3 * day)).toISOString();
				const saved = await m.remember({ content: `standalone node ${day}`, source: `s${day}`, createdAt });
				day += 1;
				return saved.insight.id;
			};
			const anchor = await node();
			const neighbours: string[] = [];
			const children: string[] = [];
			for (let i = 0; i < 15; i++) {
				const n = await node();
				const c = await node();
				await m.link({ sourceId: anchor, targetId: n, edgeType: "entity", weight: (i + 1) / 20 });
				await m.link({ sourceId: n, targetId: c, edgeType: "entity", weight: 1 });
				neighbours.push(n);
				children.push(c);
			}
			// Chain under the strongest neighbour: depths 3, 4, 5.
			const chain = [await node(), await node(), await node()];
			await m.link({ sourceId: children[14] ?? "", targetId: chain[0] ?? "", edgeType: "entity" });
			await m.link({ sourceId: chain[0] ?? "", targetId: chain[1] ?? "", edgeType: "entity" });
			await m.link({ sourceId: chain[1] ?? "", targetId: chain[2] ?? "", edgeType: "entity" });

			const client = await admin.connect();
			try {
				const store = new PostgresMnemonStore(client, schema, TEST_NAMESPACE);
				const hits = await store.walkRecallGraph({
					anchors: [{ id: anchor, score: 1, matchedVia: "keyword", signals: [] }],
					intent: "GENERAL",
					maxCandidates: 100,
				});
				const score = new Map(hits.map((h) => [h.id, h.score]));
				// GENERAL: beam 10, depth 4.
				expect(neighbours.every((n) => score.has(n))).toBe(true);
				expect(children.slice(5).every((c) => score.has(c))).toBe(true);
				expect(children.slice(0, 5).some((c) => score.has(c))).toBe(false);
				expect(score.has(chain[1] ?? "")).toBe(true);
				expect(score.has(chain[2] ?? "")).toBe(false);
				// Score propagates additively: anchor + lambda * intent weight * edge
				// weight. Like Go, a later path back through a node's own child can
				// raise its score, so check one outside the beam.
				expect(score.get(neighbours[0] ?? "")).toBeCloseTo(1 + GRAPH_LAMBDA1 * 0.25 * 0.05);
				expect(score.get(neighbours[14] ?? "") ?? 0).toBeGreaterThan(score.get(neighbours[0] ?? "") ?? 0);
			} finally {
				client.release();
			}
		});
	});
});

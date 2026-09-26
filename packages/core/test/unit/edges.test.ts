import { describe, expect, it } from "vitest";
import {
	buildCausalEdges,
	buildJudgedCausalEdges,
	buildEntityEdges,
	buildSemanticEdges,
	buildTemporalEdges,
	countEdgesByType,
	emptyEdgeCounts,
} from "../../src/engine/edges.js";

describe("Mnemon deterministic edge builders", () => {
	it("builds directional temporal backbones and weighted proximity edges", () => {
		const edges = buildTemporalEdges({
			newId: "new",
			newCreatedAt: new Date("2026-09-04T12:00:00Z"),
			latestSameSource: { id: "previous" },
			recentWithin24h: [
				{ id: "previous", createdAt: new Date("2026-09-04T11:00:00Z") },
				{ id: "new", createdAt: new Date("2026-09-04T12:00:00Z") },
				{ id: "near", createdAt: new Date("2026-09-04T10:00:00Z") },
			],
		});

		expect(edges).toEqual([
			{
				sourceId: "previous",
				targetId: "new",
				edgeType: "temporal",
				weight: 1,
				metadata: { sub_type: "backbone", direction: "precedes" },
			},
			{
				sourceId: "new",
				targetId: "previous",
				edgeType: "temporal",
				weight: 1,
				metadata: { sub_type: "backbone", direction: "succeeds" },
			},
			{
				sourceId: "new",
				targetId: "near",
				edgeType: "temporal",
				weight: 1 / 3,
				metadata: { sub_type: "proximity", hours_diff: "2.00" },
			},
			{
				sourceId: "near",
				targetId: "new",
				edgeType: "temporal",
				weight: 1 / 3,
				metadata: { sub_type: "proximity", hours_diff: "2.00" },
			},
		]);
		expect(
			buildTemporalEdges({
				newId: "new",
				newCreatedAt: new Date(),
				recentWithin24h: [],
			}),
		).toEqual([]);
	});

	it("builds bidirectional entity edges but never self-links", () => {
		expect(
			buildEntityEdges({
				newId: "new",
				pairs: [
					{ entity: "Spore", targetId: "old" },
					{ entity: "Spore", targetId: "new" },
				],
			}),
		).toEqual([
			{
				sourceId: "new",
				targetId: "old",
				edgeType: "entity",
				weight: 1,
				metadata: { entity: "Spore" },
			},
			{
				sourceId: "old",
				targetId: "new",
				edgeType: "entity",
				weight: 1,
				metadata: { entity: "Spore" },
			},
		]);
	});

	it.each([
		["prevents", "The release works because it prevents checkout failure"],
		["enables", "The release works so that it enables faster checkout"],
		["causes", "The release works because checkout becomes faster"],
	] as const)("classifies %s causal relationships", (subType, content) => {
		const edges = buildCausalEdges({
			newId: "new",
			newContent: content,
			previous: [
				{ id: "old", content: "The release works with checkout changes" },
			],
		});
		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({
			sourceId: "old",
			targetId: "new",
			edgeType: "causal",
			metadata: { sub_type: subType },
		});
	});

	it("reverses inferred direction when only the previous insight is causal", () => {
		expect(
			buildCausalEdges({
				newId: "new",
				newContent: "The release changed checkout",
				previous: [
					{
						id: "old",
						content: "The release works because checkout changes",
					},
				],
			})[0],
		).toMatchObject({ sourceId: "new", targetId: "old" });
	});

	it("rejects empty, non-causal, and low-overlap causal candidates", () => {
		expect(
			buildCausalEdges({ newId: "new", newContent: "", previous: [] }),
		).toEqual([]);
		expect(
			buildCausalEdges({
				newId: "new",
				newContent: "checkout release",
				previous: [{ id: "old", content: "checkout release" }],
			}),
		).toEqual([]);
		expect(
			buildCausalEdges({
				newId: "new",
				newContent: "checkout release causes growth",
				previous: [{ id: "old", content: "unrelated spores" }],
			}),
		).toEqual([]);
	});

	it("builds only above-threshold non-self semantic edges", () => {
		const edges = buildSemanticEdges({
			newId: "new",
			neighbors: [
				{ id: "new", cosine: 1 },
				{ id: "weak", cosine: 0.1 },
				{ id: "strong", cosine: 0.9 },
			],
		});
		expect(edges).toHaveLength(2);
		expect(edges[0]).toMatchObject({
			sourceId: "new",
			targetId: "strong",
			edgeType: "semantic",
			metadata: { created_by: "auto", cosine: "0.9000" },
		});
	});

	it("counts all edge types from a neutral zero baseline", () => {
		expect(emptyEdgeCounts()).toEqual({
			temporal: 0,
			semantic: 0,
			causal: 0,
			entity: 0,
		});
		expect(
			countEdgesByType([
				{
					sourceId: "a",
					targetId: "b",
					edgeType: "causal",
					weight: 1,
					metadata: {},
				},
				{
					sourceId: "b",
					targetId: "c",
					edgeType: "entity",
					weight: 1,
					metadata: {},
				},
			]),
		).toEqual({ temporal: 0, semantic: 0, causal: 1, entity: 1 });
	});
});

describe("judged causal edges", () => {
	it("orients edges by relation and drops none, invalid, and self entries", () => {
		const edges = buildJudgedCausalEdges({
			newId: "n",
			judgments: {
				a: { relation: "existing_causes_new", weight: 0.8 },
				b: { relation: "new_prevents_existing", weight: 0.6 },
				c: { relation: "none", weight: 0.9 },
				d: { relation: "existing_enables_new", weight: 1.5 },
				n: { relation: "existing_causes_new", weight: 0.9 },
			},
		});
		expect(edges).toEqual([
			{
				sourceId: "a",
				targetId: "n",
				edgeType: "causal",
				weight: 0.8,
				metadata: { sub_type: "causes", created_by: "judge" },
			},
			{
				sourceId: "n",
				targetId: "b",
				edgeType: "causal",
				weight: 0.6,
				metadata: { sub_type: "prevents", created_by: "judge" },
			},
		]);
	});
});

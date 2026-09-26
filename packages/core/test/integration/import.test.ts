import { describe, expect, it } from "vitest";

import { MnemonValidationError } from "../../src/errors.js";
import {
	importDraft,
	type MemoryDraft,
	memoryReceipt,
	validateDraft,
} from "../../src/import.js";
import { FakeClock } from "../fake-clock.js";
import { postgresAvailable, TEST_NAMESPACE, TEST_TENANT, withMnemon } from "./helpers.js";

const available = await postgresAvailable();

const draft: MemoryDraft = {
	schema_version: "1",
	source: "chat-export",
	insights: [
		{ content: "The billing service is owned by the payments team", category: "fact", importance: 4 },
		{ content: "Payments team deploys billing on Tuesdays", source: "handbook", created_at: "2024-01-15T09:30:00Z" },
		{ content: "The billing service is owned by the payments team" },
	],
	edges: [
		{ source_index: 0, target_index: 1, edge_type: "causal", weight: 0.9, reason: "ownership sets schedule" },
		{ source_index: 0, target_index: 2, edge_type: "semantic" },
	],
};

describe("validateDraft", () => {
	it.each<[string, unknown, RegExp]>([
		["wrong schema", { ...draft, schema_version: "2" }, /schema_version/],
		["no insights", { ...draft, insights: [] }, /nothing to import/],
		["bad insight", { ...draft, insights: [{ content: " " }] }, /^insights\[0\]: /],
		["edge out of range", { ...draft, edges: [{ source_index: 0, target_index: 3, edge_type: "causal" }] }, /edges\[0\].target_index/],
		["self edge", { ...draft, edges: [{ source_index: 1, target_index: 1, edge_type: "causal" }] }, /must differ/],
		["bad edge type", { ...draft, edges: [{ source_index: 0, target_index: 1, edge_type: "friend" }] }, /invalid edge_type/],
		["bad weight", { ...draft, edges: [{ source_index: 0, target_index: 1, edge_type: "causal", weight: 2 }] }, /weight/],
	])("rejects %s", (_name, bad, message) => {
		const run = () => {
			validateDraft(bad as MemoryDraft);
		};
		expect(run).toThrow(MnemonValidationError);
		expect(run).toThrow(message);
	});
});

describe.skipIf(!available)("importDraft and memoryReceipt", () => {
	const clock = new FakeClock(new Date("2024-06-01T00:00:00Z"));

	it("imports through the write path, skips duplicates, and links by index", async () => {
		await withMnemon({ clock }, async (m) => {
			const result = await importDraft(m, draft);
			expect(result.insights.map((r) => r.action)).toEqual(["added", "added", "skipped"]);
			const [first, second, third] = result.insights;
			expect(third?.id).toBe(first?.id);
			// The duplicate's edge would be a self-link, so only one is created.
			expect(result.edges).toBe(1);

			const owned = await m.get(first?.id ?? "");
			expect(owned).toMatchObject({ category: "fact", importance: 4, source: "chat-export" });
			const deploys = await m.get(second?.id ?? "");
			expect(deploys).toMatchObject({ source: "handbook", createdAt: "2024-01-15T09:30:00.000Z" });

			const related = await m.related(first?.id ?? "", { edgeType: "causal" });
			expect(related.map((r) => r.id)).toContain(second?.id);

			// Nothing is written when any part of the draft is invalid.
			const before = (await m.list()).length;
			await expect(
				importDraft(m, { ...draft, insights: [{ content: "new fact" }, { content: "" }] }),
			).rejects.toThrow(MnemonValidationError);
			expect((await m.list()).length).toBe(before);
		});
	});

	it("applies defaults for source, weight, and missing edges", async () => {
		await withMnemon({ clock }, async (m) => {
			const bare = await importDraft(m, {
				schema_version: "1",
				insights: [{ content: "Standups start at 9:30" }],
			});
			expect(bare.edges).toBe(0);
			expect(await m.get(bare.insights[0]?.id ?? "")).toMatchObject({
				source: "import",
				category: "general",
				importance: 3,
			});

			const linked = await importDraft(m, {
				schema_version: "1",
				insights: [{ content: "Retros happen every other Friday" }, { content: "Retro notes go to the wiki" }],
				edges: [{ source_index: 0, target_index: 1, edge_type: "semantic" }],
			});
			expect(linked.edges).toBe(1);
			const related = await m.related(linked.insights[0]?.id ?? "", { edgeType: "semantic" });
			expect(related.map((r) => r.id)).toContain(linked.insights[1]?.id);

			const receipt = await memoryReceipt(m);
			expect(receipt.count).toBeGreaterThanOrEqual(3);
			expect(Date.parse(receipt.generatedAt)).not.toBeNaN();
		});
	});

	it("imports once inside an authorized transaction", async () => {
		await withMnemon({ clock }, async (m, { client }) => {
			const auth = { tenantId: TEST_TENANT, namespace: TEST_NAMESPACE };
			const run = () =>
				client.withAuthorization(auth, (tx) => tx.once("import:job-1", (t) => importDraft(t, draft)));
			const first = await run();
			const again = await run();
			expect(again).toEqual({ value: first.value, replayed: true });
			expect(await m.list()).toHaveLength(2);
		});
	});

	it("exports a receipt with hashes instead of contents", async () => {
		await withMnemon({ clock }, async (m) => {
			const secret = "The vault is behind the painting";
			const saved = await m.remember({ content: secret });
			const receipt = await memoryReceipt(m, { limit: 5, now: clock.now() });
			expect(receipt).toMatchObject({
				schema: "mnemon.memory.receipt.v1",
				generatedAt: "2024-06-01T00:00:00.000Z",
				count: 1,
				privacy: { rawDetailIncluded: false, hashAlgorithm: "sha256" },
			});
			expect(receipt.events[0]).toMatchObject({ operation: "remember", detailPresent: true });
			expect(receipt.events[0]?.insightIdHash).toMatch(/^[0-9a-f]{64}$/);
			const json = JSON.stringify(receipt);
			expect(json).not.toContain(saved.insight.id);
			expect(json).not.toContain("vault");
			await expect(memoryReceipt(m, { limit: 0 })).rejects.toThrow(MnemonValidationError);
		});
	});
});

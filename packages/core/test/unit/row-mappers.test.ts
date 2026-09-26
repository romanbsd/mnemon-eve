import { describe, expect, it } from "vitest";
import { MnemonDatabaseError } from "../../src/errors.js";
import { mapInsightRow } from "../../src/postgres/row-mappers.js";

function row(embedding: unknown): Record<string, unknown> {
	return {
		namespace: "n",
		id: "11111111-1111-4111-8111-111111111111",
		content: "c",
		normalized_content: "c",
		content_hash: "h",
		search_tokens: [],
		category: "fact",
		importance: 3,
		tags: [],
		entities: [],
		source: "agent",
		metadata: {},
		managed: false,
		access_count: 0,
		stored_at: new Date("2026-01-01T00:00:00Z"),
		created_at: new Date("2026-01-01T00:00:00Z"),
		updated_at: new Date("2026-01-01T00:00:00Z"),
		deleted_at: null,
		last_accessed_at: null,
		embedding,
		effective_importance: 0.5,
	};
}

describe("mapInsightRow embeddings", () => {
	it("keeps numeric arrays", () => {
		expect(mapInsightRow(row([0.1, 0.2])).embedding).toEqual([0.1, 0.2]);
	});

	it("parses the pgvector text form", () => {
		expect(mapInsightRow(row("[0.1, 0.2, 0.3]")).embedding).toEqual([
			0.1, 0.2, 0.3,
		]);
	});

	it("returns null for missing vectors", () => {
		expect(mapInsightRow(row(null)).embedding).toBeNull();
	});

	it("rejects an unparseable timestamp", () => {
		expect(() =>
			mapInsightRow({ ...row(null), stored_at: "not-a-date" }),
		).toThrow(MnemonDatabaseError);
	});

	it("rejects a malformed pgvector string", () => {
		expect(() => mapInsightRow(row("[1,,2]"))).toThrow(MnemonDatabaseError);
	});

	it("rejects a non-finite embedding element", () => {
		expect(() => mapInsightRow(row([0.1, Number.NaN]))).toThrow(
			MnemonDatabaseError,
		);
	});
});

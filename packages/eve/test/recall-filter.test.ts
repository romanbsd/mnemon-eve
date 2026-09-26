import { describe, expect, it } from "vitest";

import { jevRecallFilter } from "../src/index.js";

const memories = [
	{ id: "a", content: "Refunds over 500 euros need CFO approval" },
	{ id: "b", content: "The cafeteria serves soup on Tuesdays" },
	{ id: "c", content: "Dana prefers short bullet lists" },
];

describe("jevRecallFilter", () => {
	it("asks one question per memory and keeps those at the threshold", async () => {
		let asked: string[] = [];
		const filter = jevRecallFilter({
			evaluate: async ({ questions }) => {
				asked = Object.keys(questions);
				return { answers: { m0: { probability: 0.9 }, m1: { probability: 0.1 }, m2: { probability: 0.6 } } };
			},
		});
		const input = { query: "who approves refunds?", audience: "organization" as const, memories };
		expect(await filter(input)).toEqual(["a", "c"]);
		expect(asked).toEqual(["m0", "m1", "m2"]);
		const strict = jevRecallFilter({
			threshold: 0.8,
			evaluate: async () => ({ answers: { m0: { probability: 0.9 }, m2: { probability: 0.6 } } }),
		});
		expect(await strict(input)).toEqual(["a"]);
	});

	it("skips the request when nothing was recalled", async () => {
		const filter = jevRecallFilter({
			evaluate: () => {
				throw new Error("should not be called");
			},
		});
		expect(await filter({ query: "q", audience: "personal", memories: [] })).toEqual([]);
	});
});

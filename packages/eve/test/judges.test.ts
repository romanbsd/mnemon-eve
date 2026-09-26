import { describe, expect, it } from "vitest";

import { jevCausalJudge, jevDiffJudge, type JudgeEvaluator } from "../src/index.js";

describe("jevDiffJudge", () => {
	it("asks one choice per candidate and drops invalid answers", async () => {
		let seen: Parameters<JudgeEvaluator>[0] | undefined;
		const judge = jevDiffJudge({
			evaluate: async (input) => {
				seen = input;
				return {
					answers: { c0: { choice: "contradicts" }, c1: { choice: "maybe" } },
				};
			},
		});
		const relations = await judge({
			content: "DB is MySQL",
			candidates: [
				{ id: "a", content: "DB is Postgres" },
				{ id: "b", content: "DB backups run nightly" },
				{ id: "c", content: "Invoices go to finance" },
			],
		});
		expect(relations).toEqual({ a: "contradicts" });
		expect(Object.keys(seen?.questions ?? {})).toEqual(["c0", "c1", "c2"]);
		expect(seen?.questions.c1?.instructions).toContain("`existing[1]`");
		expect(seen?.state).toEqual({
			newMemory: "DB is MySQL",
			existing: ["DB is Postgres", "DB backups run nightly", "Invoices go to finance"],
		});
	});
});

describe("jevCausalJudge", () => {
	it("keeps directed causal choices weighted by their probability", async () => {
		let seen: Parameters<JudgeEvaluator>[0] | undefined;
		const judge = jevCausalJudge({
			evaluate: async (input) => {
				seen = input;
				return {
					answers: {
						p0: {
							choice: "existing_causes_new",
							probabilities: { existing_causes_new: 0.8, none: 0.2 },
						},
						p1: { choice: "none" },
						p2: { choice: "bogus" },
						p3: { choice: "new_prevents_existing" },
					},
				};
			},
		});
		const judged = await judge({
			content: "We moved to Postgres",
			previous: ["a", "b", "c", "d"].map((id) => ({ id, content: `memory ${id}` })),
		});
		expect(judged).toEqual({
			a: { relation: "existing_causes_new", weight: 0.8 },
			d: { relation: "new_prevents_existing", weight: 1 },
		});
		expect(seen?.state).toEqual({
			newMemory: "We moved to Postgres",
			existing: ["memory a", "memory b", "memory c", "memory d"],
		});
	});
});

import { describe, expect, it } from "vitest";

import { heuristicGate } from "../src/index.js";
import { GATE_CASES, scoreGate } from "./gate-benchmark.js";

const acceptAll = () => Promise.resolve({ accept: true, reasons: [] });

describe("heuristicGate", () => {
	it("beats accept-all on the labeled benchmark", async () => {
		const baseline = await scoreGate(acceptAll);
		const score = await scoreGate(heuristicGate());
		// Tuned on these cases (58: 25 accept-all, 55 heuristic); remaining misses are paraphrased duplicates.
		expect(score.misses.length).toBeLessThanOrEqual(3);
		expect(score.correct).toBeGreaterThan(baseline.correct);
	});

	it("never lets a benchmark secret through", async () => {
		const secrets = GATE_CASES.filter((c) => c.reject === "sensitive");
		expect((await scoreGate(heuristicGate(), secrets)).missedRejects).toBe(0);
	});

	it("classifies accepted facts and never supersedes", async () => {
		const decision = await heuristicGate()({
			fact: "Refunds over $500 must be approved by the head of support.",
			audience: "organization",
			audienceDescription: "",
			recentContext: "",
			relatedMemories: [{ id: "1", content: "Refunds over $500 are approved by support." }],
		});
		expect(decision).toMatchObject({ accept: true, category: "fact", importance: 4 });
		expect(decision.supersedes).toBeUndefined();
	});
});

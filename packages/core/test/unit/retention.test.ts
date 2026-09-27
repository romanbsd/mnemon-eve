import { describe, expect, it } from "vitest";

import { effectiveImportance, isImmune } from "../../src/engine/retention.js";

const ei = (over: Partial<Parameters<typeof effectiveImportance>[0]>) =>
	effectiveImportance({ importance: 3, accessCount: 0, daysSinceAccess: 0, edgeCount: 0, ...over });

describe("effectiveImportance", () => {
	it.each([
		[5, 1],
		[4, 0.8],
		[3, 0.5],
		[2, 0.3],
		[1, 0.15],
	])("uses base weight %i -> %f for a new memory", (importance, base) => {
		expect(ei({ importance })).toBeCloseTo(base);
	});

	it("halves every 30 days since access", () => {
		expect(ei({ daysSinceAccess: 30 })).toBeCloseTo(0.25);
		expect(ei({ daysSinceAccess: 60 })).toBeCloseTo(0.125);
	});

	it("boosts by log access count, never below 1x, capped at 1", () => {
		expect(ei({ accessCount: 1 })).toBeCloseTo(0.5);
		expect(ei({ accessCount: 10 })).toBeCloseTo(1);
	});

	it("adds 10% per edge, capped at 5 edges", () => {
		expect(ei({ edgeCount: 2 })).toBeCloseTo(0.6);
		expect(ei({ edgeCount: 5 })).toBeCloseTo(0.75);
		expect(ei({ edgeCount: 50 })).toBeCloseTo(0.75);
	});
});

describe("isImmune", () => {
	it("protects importance 4+ or 3+ accesses", () => {
		expect(isImmune(4, 0)).toBe(true);
		expect(isImmune(3, 3)).toBe(true);
		expect(isImmune(3, 2)).toBe(false);
		expect(isImmune(1, 0)).toBe(false);
	});
});

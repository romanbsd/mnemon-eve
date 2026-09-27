import { describe, expect, it } from "vitest";

import { detectIntent, termPattern } from "../../src/engine/intent.js";

describe("detectIntent", () => {
	it("detects WHY when it strictly leads", () => {
		expect(detectIntent("why did we decide this")).toBe("WHY");
	});

	it("detects WHEN when it strictly leads", () => {
		expect(detectIntent("when did this happen in the timeline")).toBe("WHEN");
	});

	it("detects ENTITY when those terms appear and WHY/WHEN do not win", () => {
		expect(detectIntent("tell me about PostgreSQL")).toBe("ENTITY");
	});

	it("returns GENERAL on ties and empty signal", () => {
		expect(detectIntent("why when")).toBe("GENERAL");
		expect(detectIntent("remember the meeting notes")).toBe("GENERAL");
	});

	it("detects CJK WHY", () => {
		expect(detectIntent("为什么选择这个")).toBe("WHY");
	});

	it("counts overlapping terms once, like Go", () => {
		// "tell me about" is one ENTITY hit, not two, so two WHY terms win.
		expect(detectIntent("why, tell me about the reason")).toBe("WHY");
	});
});

describe("termPattern", () => {
	it("never matches the empty string when a script list is empty", () => {
		expect("hello why world".match(termPattern(["why"]))).toEqual(["why"]);
		expect("hello 为什么".match(termPattern(["为什么"]))).toEqual(["为什么"]);
		expect("hello".match(termPattern([]))).toBeNull();
	});
});

import { describe, expect, it } from "vitest";

import {
	extractEntities,
	extractEntitiesIndexed,
	hotEntityAdmissionLimit,
	mergeEntities,
} from "../../src/engine/entities.js";

describe("extractEntities", () => {
	it("extracts CamelCase, acronyms, paths, URLs, mentions, and CJK titles", () => {
		const text =
			"OpenTypeScript uses HTTP in src/main.ts see https://example.com/a and @alice reads 《史记》";
		const entities = extractEntities(text);
		expect(entities).toContain("OpenTypeScript");
		expect(entities).toContain("HTTP");
		expect(entities).toContain("src/main.ts");
		expect(extractEntities("foo.txt bar.txt")).toEqual(
			expect.arrayContaining(["foo.txt", "bar.txt"]),
		);
		expect(entities).toContain("https://example.com/a");
		expect(entities).toContain("alice");
		expect(entities).toContain("史记");
	});

	it("drops acronym stopwords", () => {
		expect(extractEntities("THE AND FOR")).not.toContain("THE");
	});

	it("skips numeric dotted tokens and abbreviations as paths", () => {
		const entities = extractEntities(
			"Scores 0.52 and 127.0.0.1, e.g. the J.Y. case on p.4, live in cmd/root.go, llama.cpp and example.org",
		);
		expect(entities).toEqual(
			expect.arrayContaining(["cmd/root.go", "llama.cpp", "example.org"]),
		);
		for (const noise of ["0.52", "127.0.0.1", "e.g", "J.Y", "p.4"]) {
			expect(entities).not.toContain(noise);
		}
	});

	it("skips ordinary all-caps emphasis words as acronyms", () => {
		const entities = extractEntities(
			"NEVER skip the API check; ONLY use HTTP. Status: OK, FIXED",
		);
		expect(entities).toEqual(expect.arrayContaining(["API", "HTTP"]));
		for (const word of ["NEVER", "ONLY", "OK", "FIXED"]) {
			expect(entities).not.toContain(word);
		}
	});

	it("matches the tech dictionary with original case", () => {
		expect(extractEntities("We use TypeScript and PostgreSQL")).toEqual(
			expect.arrayContaining(["TypeScript", "PostgreSQL"]),
		);
	});

	it("merges provided entities first", () => {
		expect(mergeEntities(["Provided"], ["TypeScript", "Provided"])).toEqual([
			"Provided",
			"TypeScript",
		]);
	});

	it("admits known single-segment names that regex would skip", () => {
		expect(extractEntities("Talk to Hestia about the store")).not.toContain(
			"Hestia",
		);
		expect(
			extractEntitiesIndexed(
				"Talk to Hestia about the store",
				new Set(["Hestia"]),
			),
		).toContain("Hestia");
		expect(
			extractEntitiesIndexed("check mnemon later", new Set(["mnemon"])),
		).toContain("mnemon");
		expect(extractEntitiesIndexed("Talk to Hestia", new Set())).not.toContain(
			"Hestia",
		);
	});

	it("keeps known entities when regex hits fill the cap", () => {
		const dense = Array.from({ length: 60 }, (_, i) => `Alpha${"x".repeat(i)}Beta`).join(" ");
		const entities = extractEntitiesIndexed(`${dense} ask Hestia`, new Set(["Hestia"]));
		expect(entities).toContain("Hestia");
		expect(entities).toHaveLength(50);
	});
});

describe("hotEntityAdmissionLimit", () => {
	it("matches upstream frequency-gate parity thresholds", () => {
		expect(hotEntityAdmissionLimit(0)).toBe(20);
		expect(hotEntityAdmissionLimit(20)).toBe(20);
		expect(hotEntityAdmissionLimit(30)).toBe(20);
		expect(hotEntityAdmissionLimit(3000)).toBe(30);
		expect(hotEntityAdmissionLimit(2050)).toBe(20.5);
	});
});

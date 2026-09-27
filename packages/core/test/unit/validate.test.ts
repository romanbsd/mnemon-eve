import { describe, expect, it } from "vitest";

import {
	requirePositiveInt,
	validateAuthorization,
	validateEmbedding,
	validateLinkInput,
	validateMetadata,
	validatePruneInput,
	validateRecallInput,
	validateRememberInput,
	validateRetentionInput,
	validateUuid,
	validateWeight,
} from "../../src/engine/validate.js";
import { MnemonValidationError } from "../../src/errors.js";

describe("validateMetadata", () => {
	it("treats null as empty metadata", () => {
		expect(validateMetadata(null)).toEqual({});
	});
});

describe("validateRecallInput", () => {
	it("rejects a non-positive excerpt length even when brief is off", () => {
		expect(() =>
			validateRecallInput({ query: "why", brief: false, excerptChars: -1 }, 8),
		).toThrow(MnemonValidationError);
	});
});

describe("validateLinkInput", () => {
	it("rejects a self-link regardless of UUID case", () => {
		expect(() =>
			validateLinkInput({
				sourceId: "11111111-1111-4111-8111-111111111111",
				targetId: "11111111-1111-4111-8111-111111111111".toUpperCase(),
				edgeType: "semantic",
			}),
		).toThrow(MnemonValidationError);
	});
});

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const DEFAULTS = { category: "general", importance: 3, source: "test" } as const;
const circular: Record<string, unknown> = {};
circular.self = circular;

describe("validation rejects bad input", () => {
	it.each<[string, () => unknown, RegExp]>([
		["array metadata", () => validateMetadata([] as never), /metadata must be an object/],
		["circular metadata", () => validateMetadata(circular), /JSON serializable/],
		["non-string tag", () => validateRememberInput({ content: "x", tags: [1 as never] }, DEFAULTS), /tags must be strings/],
		[
			"too many tags",
			() => validateRememberInput({ content: "x", tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, DEFAULTS),
			/tags exceeds 20/,
		],
		["createdAt without offset", () => validateRememberInput({ content: "x", createdAt: "2026-01-01T00:00:00" }, DEFAULTS), /explicit timezone offset/],
		["unparseable createdAt", () => validateRememberInput({ content: "x", createdAt: "2026-13-45T00:00:00Z" }, DEFAULTS), /not a valid timestamp/],
		["wrong dimensions", () => validateEmbedding([1, 2], 3), /embedding dimension 2 does not match 3/],
		["non-finite embedding", () => validateEmbedding([1, Number.NaN], 2), /finite/],
		["weight above 1", () => validateWeight(1.5), /weight/],
		["non-object authorization", () => validateAuthorization(null as never), /authorization must be an object/],
		["bad UUID", () => validateUuid("not-a-uuid", "id"), /id must be a UUID/],
		["bad intent", () => validateRecallInput({ query: "q", intent: "HOW" as never }, 8), /invalid intent/],
		["negative threshold", () => validateRetentionInput({ threshold: -1 }), /threshold/],
		["threshold above 1", () => validateRetentionInput({ threshold: 1.5 }), /threshold/],
		["missing prune input", () => validatePruneInput(undefined), /prune needs/],
		["bad edge type", () => validateLinkInput({ sourceId: ID, targetId: OTHER, edgeType: "friend" as never }), /invalid edgeType/],
		[
			"non-string link metadata",
			() => validateLinkInput({ sourceId: ID, targetId: OTHER, edgeType: "semantic", metadata: { n: 1 as never } }),
			/metadata values must be strings/,
		],
	])("%s", (_name, run, message) => {
		expect(run).toThrow(MnemonValidationError);
		expect(run).toThrow(message);
	});
});

describe("requirePositiveInt", () => {
	it("returns the value or throws the caller's error class", () => {
		class CustomError extends Error {}
		expect(requirePositiveInt(3, "n", CustomError)).toBe(3);
		expect(() => requirePositiveInt(0, "n", CustomError)).toThrow(CustomError);
		expect(() => requirePositiveInt(1.5, "n", CustomError)).toThrow("n must be a positive integer");
	});
});

import { describe, expect, it } from "vitest";

import {
	validateLinkInput,
	validateMetadata,
	validateRecallInput,
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

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../../src/config.js";
import { validateAuthorization } from "../../src/engine/validate.js";
import {
	MnemonConfigurationError,
	MnemonValidationError,
} from "../../src/errors.js";

describe("resolveConfig", () => {
	it("requires exactly one of databaseUrl or pool", () => {
		expect(() => resolveConfig({})).toThrow(
			MnemonConfigurationError,
		);
		expect(() =>
			resolveConfig({
								databaseUrl: "postgres://x",
				pool: {} as never,
			}),
		).toThrow(MnemonConfigurationError);
	});

	it("fills user scope and RLS bypass defaults", () => {
		const cfg = resolveConfig({ databaseUrl: "postgres://x" });
		expect(cfg.enforceUserScope).toBe(true);
		expect(cfg.allowRlsBypass).toBe(false);
	});

	it("rejects invalid schema names", () => {
		expect(() =>
			resolveConfig({
								databaseUrl: "postgres://x",
				schema: "Mnemon",
			}),
		).toThrow(MnemonConfigurationError);
		expect(() =>
			resolveConfig({
								databaseUrl: "postgres://x",
				schema: "drop table",
			}),
		).toThrow(MnemonConfigurationError);
	});

	it("rejects mismatched dimensions", () => {
		expect(() =>
			resolveConfig({
								databaseUrl: "postgres://x",
				embeddingDimensions: 8,
				embeddingProvider: {
					model: "x",
					dimensions: 4,
					embed: async () => [1, 2, 3, 4],
				},
			}),
		).toThrow(MnemonConfigurationError);
	});

	it("fills defaults", () => {
		const cfg = resolveConfig({
			databaseUrl: "postgres://x",
		});
		expect(cfg.schema).toBe("mnemon");
		expect(cfg.defaults).toEqual({
			category: "general",
			importance: 3,
			source: "agent",
			recallLimit: 10,
		});
		expect(cfg.limits.maxRecallCandidates).toBe(500);
	});
});

describe("validateAuthorization", () => {
	it("requires exact bounded identifiers", () => {
		const bad = [
			{ tenantId: "", namespace: "n" },
			{ tenantId: " t", namespace: "n" },
			{ tenantId: "t", namespace: "" },
			{ tenantId: "t", namespace: "x".repeat(201) },
			{ tenantId: "t", userId: "", namespace: "n" },
			{ tenantId: ["t"] as never, namespace: "n" },
		];
		for (const input of bad) {
			expect(() => validateAuthorization(input)).toThrow(
				MnemonValidationError,
			);
		}
		expect(validateAuthorization({ tenantId: "t", namespace: "n" })).toEqual({
			tenantId: "t",
			userId: null,
			namespace: "n",
		});
	});
});

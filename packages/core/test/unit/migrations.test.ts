import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { MnemonConfigurationError, MnemonDatabaseError } from "../../src/errors.js";
import { createMnemon } from "../../src/mnemon.js";
import { assertPgvectorVersion, assertRlsEnforced, runMigrations } from "../../src/postgres/migrations.js";
import { FakeEmbeddingProvider } from "../fake-embedding-provider.js";

/** Pool answering each query from the first matching handler. */
function fakePool(handlers: [RegExp, () => Promise<unknown>][]): Pool {
	return {
		query: (sql: string) =>
			handlers.find(([re]) => re.test(sql))?.[1]() ?? Promise.resolve({ rows: [] }),
	} as unknown as Pool;
}

describe("runMigrations", () => {
	it("reports a missing pgvector extension as a configuration error", async () => {
		const pool = fakePool([
			[/to_regclass/, () => Promise.resolve({ rows: [{ found: false }] })],
			[/CREATE EXTENSION/, () => Promise.reject(new Error("could not open extension control file"))],
		]);
		await expect(runMigrations(pool, "s")).rejects.toThrow(MnemonConfigurationError);
		await expect(runMigrations(pool, "s")).rejects.toThrow(/pgvector/);
	});

	it("wraps a failed version probe", async () => {
		const pool = fakePool([[/to_regclass/, () => Promise.reject(new Error("down"))]]);
		await expect(runMigrations(pool, "s")).rejects.toBeInstanceOf(MnemonDatabaseError);
	});
});

describe("assertRlsEnforced", () => {
	it("wraps a failed role lookup", async () => {
		const pool = fakePool([[/pg_roles/, () => Promise.reject(new Error("down"))]]);
		await expect(assertRlsEnforced(pool)).rejects.toBeInstanceOf(MnemonDatabaseError);
	});
});

describe("assertPgvectorVersion", () => {
	const version = (v: string | undefined) =>
		fakePool([[/pg_extension/, () => Promise.resolve({ rows: v ? [{ version: v }] : [] })]]);

	it("accepts 0.8 and later", async () => {
		await expect(assertPgvectorVersion(version("0.8.0"))).resolves.toBeUndefined();
		await expect(assertPgvectorVersion(version("1.0"))).resolves.toBeUndefined();
	});

	it("rejects older or missing pgvector", async () => {
		await expect(assertPgvectorVersion(version("0.7.4"))).rejects.toThrow(/0.7.4 is too old/);
		await expect(assertPgvectorVersion(version(undefined))).rejects.toThrow(/not installed/);
	});

	it("surfaces as a configuration error from initialize", async () => {
		const pool = fakePool([
			[/pg_roles/, () => Promise.resolve({ rows: [{ bypass: false }] })],
			[/to_regclass/, () => Promise.resolve({ rows: [{ found: true }] })],
			[/max\(version\)/, () => Promise.resolve({ rows: [{ version: 3 }] })],
			[/pg_extension/, () => Promise.resolve({ rows: [{ version: "0.7.4" }] })],
		]);
		const client = createMnemon({
			pool,
			enforceUserScope: false,
			embeddingProvider: new FakeEmbeddingProvider("fixture", 4, {}),
		});
		await expect(client.initialize()).rejects.toThrow(MnemonConfigurationError);
	});
});

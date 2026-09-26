import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { MnemonConfigurationError, MnemonDatabaseError } from "../../src/errors.js";
import { assertRlsEnforced, runMigrations } from "../../src/postgres/migrations.js";

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

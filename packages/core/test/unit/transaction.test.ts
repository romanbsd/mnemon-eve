import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import {
	MnemonDatabaseError,
	MnemonValidationError,
} from "../../src/errors.js";
import {
	withSavepoint,
	withTransaction,
	wrapDatabaseError,
} from "../../src/postgres/transaction.js";

/** Client whose queries fail when their SQL matches `failOn`. */
function fakeClient(failOn?: RegExp) {
	const queries: string[] = [];
	const released: (boolean | undefined)[] = [];
	const client = {
		query: (sql: string) => {
			queries.push(sql);
			return failOn?.test(sql)
				? Promise.reject(Object.assign(new Error(sql), { code: "XX000" }))
				: Promise.resolve({ rows: [] });
		},
		release: (destroy?: boolean) => released.push(destroy),
	} as unknown as PoolClient;
	const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
	return { client, pool, queries, released };
}

describe("wrapDatabaseError", () => {
	it("keeps the pg code and passes MnemonDatabaseError through", () => {
		const wrapped = wrapDatabaseError({ code: "23505" });
		expect(wrapped).toBeInstanceOf(MnemonDatabaseError);
		expect(wrapped.code).toBe("23505");
		expect(wrapDatabaseError(wrapped)).toBe(wrapped);
		expect(wrapDatabaseError("boom").code).toBeUndefined();
	});
});

describe("withTransaction", () => {
	it("commits and releases the client for reuse", async () => {
		const { pool, queries, released } = fakeClient();
		await expect(withTransaction(pool, () => Promise.resolve(7))).resolves.toBe(7);
		expect(queries).toEqual(["BEGIN", "COMMIT"]);
		expect(released).toEqual([false]);
	});

	it("wraps a connect failure", async () => {
		const pool = {
			connect: () => Promise.reject(new Error("refused")),
		} as unknown as Pool;
		await expect(withTransaction(pool, () => Promise.resolve(1))).rejects.toBeInstanceOf(
			MnemonDatabaseError,
		);
	});

	it("rolls back and rethrows non-database Mnemon errors unchanged", async () => {
		const { pool, queries, released } = fakeClient();
		const error = new MnemonValidationError("bad", "x", "invalid");
		await expect(withTransaction(pool, () => Promise.reject(error))).rejects.toBe(error);
		expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
		expect(released).toEqual([false]);
	});

	it("destroys the client when COMMIT fails", async () => {
		const { pool, queries, released } = fakeClient(/^COMMIT$/);
		await expect(withTransaction(pool, () => Promise.resolve(1))).rejects.toBeInstanceOf(
			MnemonDatabaseError,
		);
		expect(queries).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
		expect(released).toEqual([true]);
	});

	it("destroys the client and keeps both errors when ROLLBACK fails", async () => {
		const { pool, released } = fakeClient(/^ROLLBACK$/);
		const error = await withTransaction(pool, () => Promise.reject(new Error("work")))
			.catch((e: unknown) => e as MnemonDatabaseError & { rollbackError?: Error });
		expect(error).toBeInstanceOf(MnemonDatabaseError);
		expect((error.cause as Error).message).toBe("work");
		expect(error.rollbackError?.message).toBe("ROLLBACK");
		expect(released).toEqual([true]);
	});
});

describe("withSavepoint", () => {
	it("rolls back to the savepoint and wraps database errors", async () => {
		const { client, queries } = fakeClient();
		await expect(
			withSavepoint(client, () => Promise.reject(new Error("dup"))),
		).rejects.toBeInstanceOf(MnemonDatabaseError);
		expect(queries).toEqual([
			"SAVEPOINT mnemon_sp",
			"ROLLBACK TO SAVEPOINT mnemon_sp",
			"RELEASE SAVEPOINT mnemon_sp",
		]);
	});

	it("wraps a failed RELEASE after success", async () => {
		const { client } = fakeClient(/^RELEASE/);
		await expect(withSavepoint(client, () => Promise.resolve(1))).rejects.toBeInstanceOf(
			MnemonDatabaseError,
		);
	});
});

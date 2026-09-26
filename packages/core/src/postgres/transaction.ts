import type { Pool, PoolClient } from "pg";

import { MnemonDatabaseError, MnemonError } from "../errors.js";

export function wrapDatabaseError(error: unknown): MnemonDatabaseError {
	if (error instanceof MnemonDatabaseError) {
		return error;
	}
	const err =
		error && typeof error === "object"
			? (error as { message?: string; code?: string })
			: {};
	return new MnemonDatabaseError("database operation failed", {
		cause: error,
		code: typeof err.code === "string" ? err.code : undefined,
	});
}

export async function withTransaction<T>(
	pool: Pool,
	fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
	let client: PoolClient | undefined;
	let destroyClient = false;
	try {
		client = await pool.connect();
		await client.query("BEGIN");
		const result = await fn(client);
		try {
			await client.query("COMMIT");
		} catch (commitError) {
			destroyClient = true;
			try {
				await client.query("ROLLBACK");
			} catch {}
			throw wrapDatabaseError(commitError);
		}
		return result;
	} catch (error) {
		if (!client) {
			throw wrapDatabaseError(error);
		}
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set by a failed COMMIT
		if (destroyClient) {
			throw error;
		}
		try {
			await client.query("ROLLBACK");
		} catch (rollbackError) {
			destroyClient = true;
			const wrapped = wrapDatabaseError(error);
			(
				wrapped as MnemonDatabaseError & { rollbackError?: unknown }
			).rollbackError = rollbackError;
			throw wrapped;
		}
		if (
			error instanceof MnemonError &&
			!(error instanceof MnemonDatabaseError)
		) {
			throw error;
		}
		throw wrapDatabaseError(error);
	} finally {
		client?.release(destroyClient);
	}
}

/**
 * Runs `fn` inside a savepoint on an already-open transaction so a failed
 * statement (e.g. a unique violation) can be recovered without aborting the
 * caller's authorized transaction.
 */
export async function withSavepoint<T>(
	client: PoolClient,
	fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
	// A reused name is fine: RELEASE/ROLLBACK TO target the most recent one.
	await client.query("SAVEPOINT mnemon_sp");
	let result: T;
	try {
		result = await fn(client);
	} catch (error) {
		try {
			await client.query("ROLLBACK TO SAVEPOINT mnemon_sp");
			await client.query("RELEASE SAVEPOINT mnemon_sp");
		} catch {}
		if (error instanceof MnemonError && !(error instanceof MnemonDatabaseError)) {
			throw error;
		}
		throw wrapDatabaseError(error);
	}
	try {
		await client.query("RELEASE SAVEPOINT mnemon_sp");
	} catch (error) {
		throw wrapDatabaseError(error);
	}
	return result;
}

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Storage } from "@earendil-works/pi-durable";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

/** Another process (or another open in this one) owns this agent's storage. Nothing was written. */
export class AgentOwnedElsewhereError extends Error {
	constructor(path: string) {
		super(`Agent storage ${path} is owned by another process`);
		this.name = "AgentOwnedElsewhereError";
	}
}

export type OpenSqliteAgentStorageOptions = {
	/** The agent's storage file, `<agent dir>/state.sqlite`. Its directory is created when missing. */
	path: string;
	/** How long to wait for another owner to let go before giving up with AgentOwnedElsewhereError. Default 250 ms. */
	lockTimeoutMs?: number;
	/** SQLite WAL auto-checkpoint threshold in pages (pi-durable's default: 1,000). */
	walAutoCheckpointPages?: number;
};

export type SqliteAgentStorage = { storage: Storage; path: string };

const isBusy = (error: unknown): boolean => {
	const e = error as { code?: string; errcode?: number; message?: string };
	// node:sqlite reports SQLITE_BUSY (5) / SQLITE_LOCKED (6) as ERR_SQLITE_ERROR with errcode, primary code in the low byte.
	const primary = typeof e?.errcode === "number" ? e.errcode & 0xff : undefined;
	return primary === 5 || primary === 6 || /database is locked|SQLITE_BUSY/i.test(e?.message ?? "");
};

/**
 * Open an agent's pi-durable storage in a single SQLite file, owned by this process alone.
 *
 * pi-durable has no cross-process locking ("one process owns a storage at a time"), so ownership is the SQLite file
 * lock itself: `locking_mode = EXCLUSIVE` is set before the first WAL access (so no shared-memory index is ever made
 * and no other connection can read or write), and a write transaction takes the lock right away. The lock lives
 * exactly as long as this connection: closing it, or the process dying, releases it, so the next start never waits
 * on a lease. A second owner gets AgentOwnedElsewhereError (the runtime exits 3).
 */
export async function openSqliteAgentStorage(options: OpenSqliteAgentStorageOptions): Promise<SqliteAgentStorage> {
	const { path } = options;
	mkdirSync(dirname(path), { recursive: true });
	const database = new DatabaseSync(path, { timeout: options.lockTimeoutMs ?? 250 });
	try {
		database.exec("PRAGMA locking_mode = EXCLUSIVE");
		database.exec("PRAGMA journal_mode = WAL");
		// Take the exclusive lock now rather than at the first commit: ownership is decided before anything runs.
		database.exec("BEGIN IMMEDIATE");
		database.exec("COMMIT");
		database.exec("PRAGMA synchronous = NORMAL");
		database.exec(`PRAGMA wal_autocheckpoint = ${Math.max(0, Math.trunc(options.walAutoCheckpointPages ?? 1000))}`);
	} catch (error) {
		try {
			database.close();
		} catch {
			// Keep the original error.
		}
		if (isBusy(error)) throw new AgentOwnedElsewhereError(path);
		throw error;
	}
	const adapter = new NodeSqliteDatabase(database);
	try {
		return { storage: await SqliteStorage.open(adapter), path };
	} catch (error) {
		await adapter.close().catch(() => {});
		throw error;
	}
}

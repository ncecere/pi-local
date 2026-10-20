import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { openSqliteAgentStorage } from "../src/lib/storage/sqlite.ts";
import { registerStorageConformance } from "../src/lib/testing/index.ts";
import { tempStoragePath } from "./support.ts";

// pi-durable's own storage contract, run against the agent storage as the app opens it (one SQLite file, exclusive
// lock). Each case gets a fresh agent folder.
registerStorageConformance({ describe, expect, it }, "SQLite agent storage (exclusive)", async (use) => {
	const cleanup: (() => Promise<unknown>)[] = [];
	const path = await tempStoragePath(cleanup);
	const { storage } = await openSqliteAgentStorage({ path });
	try {
		await use(storage);
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
		for (const fn of cleanup.reverse()) await fn();
	}
});

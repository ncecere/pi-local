import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { AgentOwnedElsewhereError, openSqliteAgentStorage } from "../src/lib/storage/sqlite.ts";
import { tempStoragePath } from "./support.ts";

const ctx = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

/** Another process that opens the storage file and holds it until killed; resolves once it owns it. */
async function holdInChild(path: string): Promise<ChildProcess> {
	const script = `
		import { openSqliteAgentStorage } from ${JSON.stringify(new URL("../src/lib/storage/sqlite.ts", import.meta.url).pathname)};
		await openSqliteAgentStorage({ path: ${JSON.stringify(path)} });
		console.log("owned");
		setInterval(() => {}, 1000);
	`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
	cleanup.push(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});
	let output = "";
	await new Promise<void>((resolve, reject) => {
		child.stdout!.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes("owned")) resolve();
		});
		child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.once("exit", (code) => reject(new Error(`holder exited ${code}: ${output}`)));
	});
	return child;
}

const killed = (child: ChildProcess) =>
	new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.kill("SIGKILL");
	});

describe("single ownership of an agent's storage file", () => {
	it("refuses a second owner in the same process until the first closes", async () => {
		const path = await tempStoragePath(cleanup);
		const first = await openSqliteAgentStorage({ path });
		await expect(openSqliteAgentStorage({ path })).rejects.toBeInstanceOf(AgentOwnedElsewhereError);
		await first.storage.close(ctx);
		const second = await openSqliteAgentStorage({ path });
		await second.storage.close(ctx);
	});

	it("refuses an owner in another process, and hands over at once when that process is killed", async () => {
		const path = await tempStoragePath(cleanup);
		const holder = await holdInChild(path);
		await expect(openSqliteAgentStorage({ path })).rejects.toBeInstanceOf(AgentOwnedElsewhereError);
		await killed(holder);
		// The OS released the lock with the process: no lease to wait out.
		const started = Date.now();
		const next = await openSqliteAgentStorage({ path });
		expect(Date.now() - started).toBeLessThan(1000);
		await next.storage.close(ctx);
	}, 20_000);

	it("never lets two concurrent openers both own it", async () => {
		const path = await tempStoragePath(cleanup);
		const results = await Promise.allSettled(Array.from({ length: 8 }, () => openSqliteAgentStorage({ path })));
		const owners = results.filter((r) => r.status === "fulfilled");
		expect(owners).toHaveLength(1);
		for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(AgentOwnedElsewhereError);
		await (owners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof openSqliteAgentStorage>>>).value.storage.close(ctx);
	}, 20_000); // eight openers queue on one exclusive lock: slow on a busy CI machine

	it("keeps no shared-memory index beside the file (nothing another connection could attach to)", async () => {
		const path = await tempStoragePath(cleanup);
		const owner = await openSqliteAgentStorage({ path });
		expect(existsSync(`${path}-shm`)).toBe(false);
		await owner.storage.close(ctx);
	});
});

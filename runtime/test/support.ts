import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh agent folder in the system temp directory; the cleanup removes it. */
export async function tempAgentDir(cleanup: (() => Promise<unknown>)[]): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-local-agent-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** A storage file (`state.sqlite`) in a fresh agent folder, as the app lays an agent out. */
export async function tempStoragePath(cleanup: (() => Promise<unknown>)[]): Promise<string> {
	return join(await tempAgentDir(cleanup), "state.sqlite");
}

/** Retry `attempt` until it succeeds or `ms` pass: for what must happen within a bounded time. */
export async function within<T>(ms: number, attempt: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		try {
			return await attempt();
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
}

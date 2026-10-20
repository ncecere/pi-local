import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openSqliteAgentStorage, READY_PREFIX } from "@pdp/runtime";
import { registerRuntimeConformance, startTestAgent } from "@pdp/runtime/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tempStoragePath, within } from "./support.ts";

const RUNTIME_DIR = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "contract-runtime-token-0123456789";
const runner = { describe, it, expect, beforeAll, afterAll };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

type Proc = { child: ChildProcess; baseUrl: string; exited: Promise<number | null>; output: () => string };

/**
 * The runtime as the app's supervisor runs it: `node --import tsx src/main.ts`, configured by environment, on PORT=0,
 * reading the port from the ready line. stdin is a pipe the test holds (the app's watchdog).
 */
async function spawnRuntime(env: Record<string, string>, { waitForReady = true, owner = cleanup } = {}): Promise<Proc> {
	const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
		cwd: RUNTIME_DIR,
		env: { PATH: process.env.PATH ?? "", HOST: "127.0.0.1", PORT: "0", ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	owner.push(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});
	let output = "";
	child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
	child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	const proc = { child, baseUrl: "", exited, output: () => output };
	if (!waitForReady) return proc;
	const deadline = Date.now() + 20_000;
	for (;;) {
		const line = output.split("\n").find((l) => l.startsWith(READY_PREFIX));
		if (line) return { ...proc, baseUrl: `http://127.0.0.1:${(JSON.parse(line.slice(READY_PREFIX.length)) as { port: number }).port}` };
		if (child.exitCode !== null || Date.now() > deadline) throw new Error(`the runtime didn't start (exit ${child.exitCode}):\n${output}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function stop(proc: Proc): Promise<number | null> {
	if (proc.child.exitCode === null) proc.child.kill("SIGTERM");
	return proc.exited;
}

const agentEnv = (storage: string, extra: Record<string, string> = {}) => ({
	AGENT_ID: "agent-contract",
	AGENT_NAME: "Contract",
	AGENT_STORAGE: storage,
	RUNTIME_TOKEN: TOKEN,
	MODEL_PROVIDER: "demo",
	DEMO_TOKENS_PER_SECOND: "100000",
	...extra,
});

const call = async (proc: Proc, method: string, path: string, body?: unknown) => {
	const res = await fetch(`${proc.baseUrl}${path}`, {
		method,
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as { data: any } };
};

type View = { busy: boolean; messages: { role: string; text?: string; error?: string }[]; partial?: { text: string } };

registerRuntimeConformance(runner, "the runtime process (SQLite, demo model)", async () => {
	const own: (() => Promise<unknown>)[] = [];
	const proc = await spawnRuntime(agentEnv(await tempStoragePath(own)), { owner: own });
	return {
		baseUrl: proc.baseUrl,
		token: TOKEN,
		close: async () => {
			await stop(proc);
			for (const fn of own.reverse()) await fn();
		},
	};
});

registerRuntimeConformance(runner, "the test kit's agent (in memory, fake model)", async () => {
	const agent = await startTestAgent();
	return { baseUrl: agent.baseUrl, token: agent.token, close: () => agent.close() };
});

describe("runtime contract: the process", () => {
	it("exits 0 on SIGTERM, releasing the agent for the next start", async () => {
		const storage = await tempStoragePath(cleanup);
		const first = await spawnRuntime(agentEnv(storage));
		expect(await stop(first)).toBe(0);
		const second = await spawnRuntime(agentEnv(storage));
		expect(await stop(second)).toBe(0);
	}, 30_000);

	it("finishes a reply after being killed (SIGKILL) in the middle of it", async () => {
		const storage = await tempStoragePath(cleanup);
		// A slow demo model, so the kill lands while the reply is being written.
		const slow = agentEnv(storage, { DEMO_TOKENS_PER_SECOND: "15" });
		const first = await spawnRuntime(slow);
		expect((await call(first, "POST", "/threads/t1/messages", { text: "Hello", requestId: "m1" })).status).toBe(202);
		await within(10_000, async () => {
			const view = (await call(first, "GET", "/threads/t1")).json.data as View;
			if (!view.busy || !view.partial?.text) throw new Error("no partial reply yet");
		});
		first.child.kill("SIGKILL");
		await first.exited;

		// The next start resumes the run from storage and the reply completes; the retried request is not resubmitted.
		const second = await spawnRuntime({ ...slow, DEMO_TOKENS_PER_SECOND: "100000" });
		const view = await within(20_000, async () => {
			const v = (await call(second, "GET", "/threads/t1")).json.data as View;
			if (v.busy || !v.messages.some((m) => m.role === "assistant")) throw new Error("still answering");
			return v;
		});
		const assistant = view.messages.filter((m) => m.role === "assistant");
		expect(assistant.at(-1)?.text).toBeTruthy();
		expect(assistant.at(-1)?.error).toBeUndefined();
		const again = await call(second, "POST", "/threads/t1/messages", { text: "Hello", requestId: "m1" });
		expect(again.status).toBe(202);
		expect(((await call(second, "GET", "/threads/t1")).json.data as View).messages.filter((m) => m.role === "user")).toHaveLength(1);
		expect(await stop(second)).toBe(0);
	}, 60_000);

	it("stops gracefully (exit 0) when stdin closes, with RUNTIME_WATCH_STDIN", async () => {
		const proc = await spawnRuntime(agentEnv(await tempStoragePath(cleanup), { RUNTIME_WATCH_STDIN: "true" }));
		proc.child.stdin!.end();
		const code = await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r("still running"), 10_000))]);
		expect(code).toBe(0);
	}, 30_000);

	it("exits 3 while another process owns the agent", async () => {
		const storage = await tempStoragePath(cleanup);
		const owner = await openSqliteAgentStorage({ path: storage });
		try {
			const proc = await spawnRuntime(agentEnv(storage), { waitForReady: false });
			expect(await proc.exited).toBe(3);
		} finally {
			await owner.storage.close(BACKGROUND_CONTEXT);
		}
	}, 30_000);

	it("runs the kind AGENT_KIND names, and exits 2 for an unknown one", async () => {
		const proc = await spawnRuntime(agentEnv(await tempStoragePath(cleanup), { AGENT_KIND: "researcher", AGENT_KIND_SETTINGS: '{"maxPlanSteps":4}' }));
		expect(proc.output()).toContain("agent researcher");
		expect(await stop(proc)).toBe(0);
		const unknown = await spawnRuntime(agentEnv(await tempStoragePath(cleanup), { AGENT_KIND: "poet" }), { waitForReady: false });
		expect(await unknown.exited).toBe(2);
		expect(unknown.output()).toContain("unknown AGENT_KIND");
		const bad = await spawnRuntime(agentEnv(await tempStoragePath(cleanup), { AGENT_KIND: "triage", AGENT_KIND_SETTINGS: '{"writeTools":"all"}' }), {
			waitForReady: false,
		});
		expect(await bad.exited).toBe(2);
	}, 60_000);

	it("exits 2 without AGENT_ID or AGENT_STORAGE", async () => {
		const none = await spawnRuntime({ RUNTIME_TOKEN: TOKEN }, { waitForReady: false });
		expect(await none.exited).toBe(2);
		expect(none.output()).toContain("AGENT_ID is required");
		const noStorage = await spawnRuntime({ AGENT_ID: "a", RUNTIME_TOKEN: TOKEN }, { waitForReady: false });
		expect(await noStorage.exited).toBe(2);
		expect(noStorage.output()).toContain("AGENT_STORAGE is required");
	}, 30_000);
});

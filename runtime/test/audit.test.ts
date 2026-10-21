import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { assistantAgent, assistantExtension, defineAgent, defineExtension, defineTool, Type } from "@pdp/runtime";
import { fakeModel, startTestAgent, type TestAgent, toolCall } from "@pdp/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityReporter, type ToolActivity } from "../src/lib/audit.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	while (cleanup.length > 0) await cleanup.pop()!().catch(() => {});
});
const track = (agent: TestAgent) => {
	cleanup.push(() => agent.close());
	return agent;
};

const ann = { kind: "user", id: "u-ann", name: "Ann" } as const;
const item = (n: number): ToolActivity => ({ entryId: String(n), callId: `c${n}`, tool: "get_time", arguments: {}, outcome: "ok", endedAt: n });

describe("the activity reporter", () => {
	it("sends calls in batches, in order: after a short wait, or at once when a batch is full", async () => {
		const posts: { path: string; items: ToolActivity[] }[] = [];
		const reporter = new ActivityReporter(async (path, body) => void posts.push({ path, items: (body as { items: ToolActivity[] }).items }), { flushMs: 30, batch: 3 });
		reporter.add(item(1));
		reporter.add(item(2));
		expect(posts).toEqual([]);
		await new Promise((r) => setTimeout(r, 80));
		expect(posts.map((p) => p.items.map((i) => i.entryId))).toEqual([["1", "2"]]);
		expect(posts[0]!.path).toBe("/activity");
		for (let n = 3; n <= 7; n++) reporter.add(item(n));
		await reporter.flush();
		expect(posts.map((p) => p.items.map((i) => i.entryId))).toEqual([["1", "2"], ["3", "4", "5"], ["6", "7"]]);
	});

	it("tries a failed batch again, and keeps the order of what came after it", async () => {
		const seen: string[] = [];
		let failures = 2;
		const reporter = new ActivityReporter(
			async (_path, body) => {
				if (failures-- > 0) throw new Error("status 503");
				for (const i of (body as { items: ToolActivity[] }).items) seen.push(i.entryId);
			},
			{ flushMs: 1, batch: 1, retryMs: 5 },
		);
		reporter.add(item(1));
		reporter.add(item(2));
		await reporter.flush();
		expect(seen).toEqual(["1", "2"]);
	});

	it("gives up on a batch the platform never takes after five tries; stopping sends what is left once, without waiting to try again", async () => {
		let posts = 0;
		const refuse = async () => {
			posts++;
			throw new Error("refused");
		};
		const patient = new ActivityReporter(refuse, { flushMs: 1000, retryMs: 2 });
		patient.add(item(1));
		await patient.flush();
		expect(posts).toBe(5);

		posts = 0;
		const closing = new ActivityReporter(refuse, { flushMs: 1000, retryMs: 60_000 });
		closing.add(item(1));
		await closing.stop();
		expect(posts).toBe(1);
		closing.add(item(2)); // nothing more is taken
		await closing.flush();
		expect(posts).toBe(1);
	});

	it("keeps only the newest calls while the platform can't be reached", async () => {
		const seen: string[] = [];
		const reporter = new ActivityReporter(async (_p, body) => void seen.push(...(body as { items: ToolActivity[] }).items.map((i) => i.entryId)), { flushMs: 10_000, maxQueued: 3, batch: 100 });
		for (let n = 1; n <= 6; n++) reporter.add(item(n));
		await reporter.flush();
		expect(seen).toEqual(["4", "5", "6"]);
	});
});

/** A tool that runs, one that throws, and one with a secret among its arguments. */
function tools() {
	const apiCall = defineTool({
		name: "call_api",
		description: "Call an API",
		parameters: Type.Object({ url: Type.String(), apiKey: Type.Optional(Type.String()) }),
		execute: async (args) => ({ output: [{ type: "text", text: `called ${args.url}` }] }),
	});
	const boom = defineTool({
		name: "boom",
		description: "Always fails",
		parameters: Type.Object({}),
		execute: async () => {
			throw new Error("it broke");
		},
	});
	return defineAgent({ extensions: ({ instructions }) => [assistantExtension(instructions), defineExtension({ name: "api", tools: [apiCall, boom] })] });
}

describe("tool calls in the audit log", () => {
	it("reports a call that ran, with its redacted arguments, its thread and how long it took", async () => {
		const gw = await gateway();
		const model = fakeModel();
		model.reply(toolCall("call_api", { url: "https://example.com", apiKey: "k-123" }, { id: "c1" }), "Done.");
		const agent = track(await startTestAgent(tools(), { model, env: gw.env }));
		await agent.send("t", "call it", { author: ann });
		await agent.settled("t");
		const [call] = await gw.calls(1);
		expect(call).toMatchObject({ callId: "c1", threadId: "t", tool: "call_api", outcome: "ok", arguments: { url: "https://example.com", apiKey: "[redacted, 5 characters]" } });
		expect(call!.entryId).toMatch(/^\d+$/);
		expect(call!.durationMs).toBeGreaterThanOrEqual(0);
		expect(call!.endedAt).toBeGreaterThan(Date.now() - 60_000);
		expect(call).not.toHaveProperty("approval");
		expect(call).not.toHaveProperty("error");
		expect(JSON.stringify(gw.all())).not.toContain("k-123");
	});

	it("reports a call that failed with what the model was told", async () => {
		const gw = await gateway();
		const model = fakeModel();
		model.reply(toolCall("boom", {}, { id: "c1" }), "It failed.");
		const agent = track(await startTestAgent(tools(), { model, env: gw.env }));
		await agent.send("t", "break it");
		await agent.settled("t");
		const [call] = await gw.calls(1);
		expect(call).toMatchObject({ tool: "boom", outcome: "error", threadId: "t" });
		expect(call!.error).toContain("it broke");
	});

	it("reports a call a person denied, one nobody decided, and one a rule refused", async () => {
		const gw = await gateway();
		const model = fakeModel();
		model.reply(toolCall("call_api", { url: "https://a.example" }, { id: "c1" }), "Understood.");
		model.reply(toolCall("call_api", { url: "https://b.example" }, { id: "c2" }), "Understood.");
		model.reply(toolCall("call_api", { url: "https://c.example" }, { id: "c3" }), "Understood.");
		const rules = [
			{ tool: "call_api", args: { url: "https://a*" }, action: "ask" },
			{ tool: "call_api", args: { url: "https://b*" }, action: "ask" },
			{ tool: "call_api", args: { url: "https://c*" }, action: "deny" },
		];
		const agent = track(await startTestAgent(tools(), { model, env: { ...gw.env, TOOL_APPROVALS: JSON.stringify({ profile: "trusting", rules }) } }));

		await agent.send("t1", "a", { author: ann });
		const first = await agent.pendingApproval("t1");
		await agent.decide(first.id, "deny", { reason: "Not today", decidedBy: { kind: "user", id: "u-bo", name: "Bo" } });
		await agent.settled("t1");

		await agent.send("t2", "b");
		const second = await agent.pendingApproval("t2");
		await agent.decide(second.id, "timeout");
		await agent.settled("t2");

		await agent.send("t3", "c");
		await agent.settled("t3");

		const calls = await gw.calls(3);
		const by = (id: string) => calls.find((c) => c.callId === id)!;
		expect(by("c1")).toMatchObject({ outcome: "denied", threadId: "t1", approval: { status: "denied", by: "Bo", source: "rule", reason: "Not today" } });
		expect(by("c1").error).toBe("Tool call blocked: denied by Bo: Not today");
		expect(by("c1").approval!.waitedMs).toBeGreaterThanOrEqual(0);
		expect(by("c2")).toMatchObject({ outcome: "declined", threadId: "t2", approval: { status: "timed_out" } });
		expect(by("c3")).toMatchObject({ outcome: "denied", threadId: "t3" });
		expect(by("c3")).not.toHaveProperty("approval");
	});

	it("reports an approved call as ok, with the decision", async () => {
		const gw = await gateway();
		const model = fakeModel();
		model.reply(toolCall("get_time", {}, { id: "c1" }), "Done.");
		const agent = track(await startTestAgent(assistantAgent, { model, env: { ...gw.env, TOOL_APPROVALS: JSON.stringify({ tools: ["get_*"] }) } }));
		await agent.send("t", "time?", { author: ann });
		const request = await agent.pendingApproval("t");
		await agent.decide(request.id, "approve", { decidedBy: { kind: "user", id: "u-bo", name: "Bo" } });
		await agent.settled("t");
		const [call] = await gw.calls(1);
		expect(call).toMatchObject({ tool: "get_time", outcome: "ok", approval: { status: "approved", by: "Bo", source: "tools" } });
	});

	it("reports each call once, however many rounds a reply takes", async () => {
		const gw = await gateway();
		const model = fakeModel();
		model.reply(toolCall("get_time", {}, { id: "c1" }), toolCall("get_time", {}, { id: "c1" }), "Done."); // a provider that repeats a call ID
		const agent = track(await startTestAgent(assistantAgent, { model, env: gw.env }));
		await agent.send("t", "twice");
		await agent.settled("t");
		const calls = await gw.calls(2);
		expect(new Set(calls.map((c) => c.entryId)).size).toBe(2);
		await new Promise((r) => setTimeout(r, 1500));
		expect(gw.items()).toHaveLength(2);
	});

	it("reports nothing without a platform to tell, and a platform that fails doesn't fail the run", async () => {
		const model = fakeModel();
		model.reply(toolCall("get_time", {}, { id: "c1" }), "Done.");
		const alone = track(await startTestAgent(assistantAgent, { model }));
		await alone.send("t", "time?");
		expect((await alone.settled("t")).messages.at(-1)).toMatchObject({ role: "assistant" });

		const gw = await gateway(500);
		const second = fakeModel();
		second.reply(toolCall("get_time", {}, { id: "c1" }), "Done.");
		const broken = track(await startTestAgent(assistantAgent, { model: second, env: gw.env }));
		await broken.send("t", "time?");
		expect((await broken.settled("t")).messages.at(-1)).toMatchObject({ role: "assistant" });
		expect(broken.fatal).toEqual([]);
	});
});

/** A fake platform gateway: records what the runtime reports to /activity (answering `status`). */
async function gateway(status = 200) {
	const received: { path: string; body: { items?: ToolActivity[] } }[] = [];
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let raw = "";
		req.on("data", (c: Buffer) => (raw += c.toString()));
		req.on("end", () => {
			received.push({ path: req.url ?? "/", body: raw === "" ? {} : JSON.parse(raw) });
			res.writeHead(req.url === "/activity" ? status : 200, { "content-type": "application/json" }).end(JSON.stringify({ data: req.url === "/approvals/sync" ? [] : { ok: true } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(() => new Promise((resolve) => server.close(resolve)));
	const items = () => received.filter((r) => r.path === "/activity").flatMap((r) => r.body.items ?? []);
	return {
		env: { PLATFORM_GATEWAY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, PLATFORM_KEY: "agent-key" },
		all: () => received,
		items,
		/** Waits until `n` calls were reported, and returns them. */
		calls: async (n: number): Promise<ToolActivity[]> => {
			const deadline = Date.now() + 15_000;
			while (items().length < n) {
				if (Date.now() > deadline) throw new Error(`only ${items().length} of ${n} calls were reported`);
				await new Promise((r) => setTimeout(r, 20));
			}
			return items();
		},
	};
}

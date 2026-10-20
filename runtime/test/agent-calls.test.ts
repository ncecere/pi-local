import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { answer, startTestAgent, toolCall } from "@pdp/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const KEY = "pl.agent-test.gateway-key-0123456789";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

const body = (req: IncomingMessage) =>
	new Promise<string>((resolve) => {
		let data = "";
		req.on("data", (c: Buffer) => (data += c.toString()));
		req.on("end", () => resolve(data));
	});

/** The app's gateway for asks: one peer, an ask that answers after two waits, and what it was sent. */
async function fakeGateway(opts: { fail?: string; refuse?: string } = {}) {
	const asks: Record<string, unknown>[] = [];
	const waits: string[] = [];
	let polls = 0;
	const server = createServer(async (req, res) => {
		const json = (status: number, data: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(status < 400 ? { data } : { error: { message: data } }));
		};
		if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, "unauthorized");
		const url = new URL(req.url!, "http://x");
		if (req.method === "GET" && url.pathname === "/a2a/agents") return json(200, [{ id: "ag_peer", name: "Researcher", description: "Finds things out", kind: "researcher" }]);
		if (req.method === "POST" && url.pathname === "/a2a/asks") {
			const ask = JSON.parse(await body(req)) as Record<string, unknown>;
			asks.push(ask);
			if (opts.refuse) return json(403, opts.refuse);
			return json(200, { askId: "ask_1", agentId: "ag_peer", agentName: "Researcher", threadId: "ask-abc" });
		}
		if (req.method === "GET" && url.pathname === "/a2a/asks/ask_1") {
			waits.push(url.searchParams.get("waitMs") ?? "");
			polls++;
			if (polls < 3) return json(200, { status: "pending" });
			if (opts.fail) return json(200, { status: "failed", error: opts.fail });
			return json(200, { status: "done", text: "The answer is 42." });
		}
		// The rest of the gateway, as the app answers it.
		if (url.pathname.startsWith("/threads/")) return json(200, { ok: true });
		if (url.pathname === "/approvals/sync") return json(200, []);
		json(404, "not found");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asks, waits };
}

const env = (url: string) => ({ AGENT_CALLS: "true", PLATFORM_GATEWAY_URL: url, PLATFORM_KEY: KEY });

describe("asking other agents", () => {
	it("lists who it may ask, asks, and waits through pending answers for the reply", async () => {
		const gw = await fakeGateway();
		const agent = await startTestAgent(undefined, { env: env(gw.url) });
		cleanup.push(() => agent.close());
		agent.model.reply(
			toolCall("list_agents", {}, { id: "c1" }),
			toolCall("ask_agent", { agent: "Researcher", message: "What is the answer?" }, { id: "c2" }),
			answer("Done."),
		);
		await agent.send("t1", "Find out");
		const view = await agent.settled("t1");
		const results = view.messages.filter((m) => m.role === "tool");
		expect(results[0]?.text).toContain("Researcher (id: ag_peer, researcher): Finds things out");
		expect(results[1]?.text).toBe("The answer is 42.");
		expect(results[1]?.isError).toBeFalsy();
		expect(gw.asks).toHaveLength(1);
		expect(gw.asks[0]).toMatchObject({ agent: "Researcher", message: "What is the answer?", conversation: "continue", threadId: "t1" });
		// The key ties the ask to this conversation's tool call: a replay finds the same ask.
		expect(String(gw.asks[0]!.key)).toMatch(/^\d+:c2$/);
		expect(gw.waits).toEqual(["25000", "25000", "25000"]);
		const asked = view.messages.find((m) => m.role === "tool" && m.name === "ask_agent") as { details?: unknown } | undefined;
		expect(asked?.details).toEqual({ agentId: "ag_peer", agentName: "Researcher", threadId: "ask-abc" });
	}, 20_000);

	it("gives the model the app's refusal or the asked agent's failure as a tool error", async () => {
		const refusing = await fakeGateway({ refuse: "You may not ask Researcher." });
		const a = await startTestAgent(undefined, { env: env(refusing.url) });
		cleanup.push(() => a.close());
		a.model.reply(toolCall("ask_agent", { agent: "Researcher", message: "hi" }), answer("ok"));
		await a.send("t1", "go");
		const refused = (await a.settled("t1")).messages.find((m) => m.role === "tool");
		expect(refused?.isError).toBe(true);
		expect(refused?.text).toBe("You may not ask Researcher.");

		const failing = await fakeGateway({ fail: "its model is turned off" });
		const b = await startTestAgent(undefined, { env: env(failing.url) });
		cleanup.push(() => b.close());
		b.model.reply(toolCall("ask_agent", { agent: "Researcher", message: "hi" }), answer("ok"));
		await b.send("t1", "go");
		const failed = (await b.settled("t1")).messages.find((m) => m.role === "tool");
		expect(failed?.isError).toBe(true);
		expect(failed?.text).toBe("Researcher could not answer: its model is turned off");
	}, 20_000);

	it("has no ask tools without AGENT_CALLS", async () => {
		const gw = await fakeGateway();
		const agent = await startTestAgent(undefined, { env: { PLATFORM_GATEWAY_URL: gw.url, PLATFORM_KEY: KEY } });
		cleanup.push(() => agent.close());
		agent.model.reply(toolCall("ask_agent", { agent: "Researcher", message: "hi" }), answer("ok"));
		await agent.send("t1", "go");
		const result = (await agent.settled("t1")).messages.find((m) => m.role === "tool");
		expect(result?.isError).toBe(true);
		expect(gw.asks).toHaveLength(0);
	}, 20_000);
});

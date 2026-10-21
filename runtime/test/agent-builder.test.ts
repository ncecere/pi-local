import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { answer, startTestAgent, toolCall } from "@pdp/runtime/testing";
import { afterEach, expect, it } from "vitest";
import { builderEnabled } from "../src/lib/agent-builder.ts";
import { Approvals, parseApprovalPolicy } from "../src/lib/approvals.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});
const readBody = async (req: IncomingMessage) => {
	let raw = "";
	for await (const c of req) raw += c;
	return JSON.parse(raw || "{}");
};

it("opts in explicitly, not just because a gateway exists", () => {
	expect(builderEnabled({ PLATFORM_GATEWAY_URL: "http://x", PLATFORM_KEY: "k" })).toBe(false);
	expect(builderEnabled({ AGENT_BUILDER: "true" })).toBe(false);
	expect(builderEnabled({ AGENT_BUILDER: "false", PLATFORM_GATEWAY_URL: "http://x", PLATFORM_KEY: "k" })).toBe(false);
});

it.each(["trusting", "custom", "balanced"])(
	"%s still asks about the full prepared configuration and never applies a denial",
	async (profile) => {
		const applied: unknown[] = [];
		const prepared: Record<string, unknown>[] = [];
		const yaml = `name: Child\ninstructions: ${"x".repeat(18_000)} THE END\nmodel: {provider: demo, id: demo-1}\n`;
		const server = createServer(async (req, res) => {
			const body = await readBody(req);
			const path = req.url!;
			let data: unknown = { ok: true };
			if (path === "/builder/prepare") {
				prepared.push(body);
				data = { tool: body.tool, agentId: "ag_child", yaml, revision: 0 };
			} else if (path === "/builder/apply") {
				applied.push(body);
				data = { agentId: "ag_child", status: "done" };
			} else if (path === "/approvals/sync") data = [];
			else if (path === "/approvals/report") data = { status: "pending" };
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data }));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		cleanup.push(
			() =>
				new Promise((r) => {
					server.closeAllConnections();
					server.close(r);
				}),
		);
		const agent = await startTestAgent(undefined, {
			env: {
				AGENT_BUILDER: "true",
				PLATFORM_GATEWAY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
				PLATFORM_KEY: "k",
				TOOL_APPROVALS: JSON.stringify({ profile, rules: [{ tool: "*", action: "allow" }] }),
			},
		});
		cleanup.push(() => agent.close());
		agent.model.reply(toolCall("create_agent", { name: "Child" }, { id: "create" }), answer("Done"));
		await agent.send("t", "make one");
		const req = await agent.pendingApproval("t");
		expect(req.source).toBe("builtin");
		expect(req.arguments).toMatchObject({ yaml });
		expect(applied).toHaveLength(0);
		expect(prepared[0]).toMatchObject({ configuration: { name: "Child" }, approvalId: req.id });
		await agent.decide(req.id, "deny");
		await agent.settled("t");
		expect(applied).toHaveLength(0);
		agent.model.reply(toolCall("update_agent", { agent: "ag_child", name: "Better" }, { id: "update" }), answer("Done"));
		await agent.send("u", "update");
		const update = await agent.pendingApproval("u");
		await agent.decide(update.id, "approve");
		await agent.settled("u");
		expect(applied).toEqual([{ key: prepared[1]!.key }]);
	},
	20_000,
);

it("an explicit deny can still refuse a builder call, never authorize it", async () => {
	const approvals = new Approvals(parseApprovalPolicy(JSON.stringify({ profile: "trusting", rules: [{ tool: "create_agent", action: "deny" }] })));
	expect(await approvals.verdict({ type: "toolCall", id: "x", name: "create_agent", arguments: { name: "No" } })).toEqual({ block: "Not allowed by your approval rules" });
});

it("ordinary runtimes never install create_agent or update_agent", async () => {
	const agent = await startTestAgent();
	cleanup.push(() => agent.close());
	agent.model.reply(toolCall("create_agent", { name: "No" }), answer("Done"));
	await agent.send("t", "go");
	expect((await agent.settled("t")).messages.find((m) => m.role === "tool")?.isError).toBe(true);
});

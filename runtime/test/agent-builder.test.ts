import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answer, startTestAgent, toolCall } from "@pdp/runtime/testing";
import { afterEach, expect, it } from "vitest";
import { agentBuilder, builderEnabled } from "../src/lib/agent-builder.ts";
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

it("exposes bounded strict knowledge and shared skill schemas on both tools", () => {
	const { extension } = agentBuilder({ gatewayUrl: "http://invalid.test", key: "fake" });
	for (const tool of extension.tools ?? []) {
		expect(tool.parameters).toMatchObject({
			additionalProperties: false,
			properties: {
				knowledge: {
					type: "object",
					required: ["folders"],
					additionalProperties: false,
					properties: { folders: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 4096 } } },
				},
				skills: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" } },
			},
		});
		for (const forbidden of ["credentials", "setupCommand", "imports", "supportingFiles"]) expect(tool.parameters).not.toHaveProperty(`properties.${forbidden}`);
		expect(tool.description).toContain("human approval");
	}
	expect(extension.tools).toHaveLength(2);
});

it.each(["careful", "trusting", "custom", "balanced"])(
	"%s still asks about the full prepared configuration and never applies a denial",
	async (profile) => {
		const applied: unknown[] = [];
		const prepared: Record<string, unknown>[] = [];
		const folder = await mkdtemp(join(tmpdir(), "builder-knowledge-"));
		cleanup.push(() => rm(folder, { recursive: true, force: true }));
		const selection = { knowledge: { folders: [folder] }, skills: ["release-notes"] };
		const clear = { knowledge: { folders: [] }, skills: [] };
		const yaml = `name: Child\ninstructions: ${"x".repeat(18_000)} THE END\nmodel: {provider: demo, id: demo-1}\nknowledge:\n  folders: [${JSON.stringify(folder)}]\nskills: [release-notes]\n`;
		const updateYaml = "name: Better\nmodel: {provider: demo, id: demo-1}\n";
		const server = createServer(async (req, res) => {
			const body = await readBody(req);
			const path = req.url!;
			let data: unknown = { ok: true };
			if (path === "/builder/prepare") {
				prepared.push(body);
				data = { tool: body.tool, agentId: "ag_child", yaml: body.tool === "create_agent" ? yaml : updateYaml, revision: body.tool === "create_agent" ? 0 : 1 };
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
		agent.model.reply(toolCall("create_agent", { name: "Child", ...selection }, { id: "create" }), answer("Done"));
		await agent.send("t", "make one");
		const req = await agent.pendingApproval("t");
		expect(req.source).toBe("builtin");
		expect(req.arguments).toMatchObject({ yaml });
		expect(applied).toHaveLength(0);
		expect(prepared[0]).toMatchObject({ configuration: { name: "Child", ...selection }, approvalId: req.id });
		await agent.decide(req.id, "deny");
		await agent.settled("t");
		expect(applied).toHaveLength(0);
		agent.model.reply(toolCall("update_agent", { agent: "ag_child", name: "Better", ...clear }, { id: "update" }), answer("Done"));
		await agent.send("u", "update");
		const update = await agent.pendingApproval("u");
		expect(update.arguments).toMatchObject({ yaml: updateYaml, revision: 1 });
		expect(prepared[1]).toMatchObject({ configuration: { agent: "ag_child", name: "Better", ...clear }, approvalId: update.id });
		expect(applied).toHaveLength(0);
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

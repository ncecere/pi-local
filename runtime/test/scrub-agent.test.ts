import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { answer, startTestAgent, toolCall } from "@pdp/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../src/lib/mcp.ts";
import { tempAgentDir } from "./support.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

const FIXTURE = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const MODEL_KEY = "pdpm.agent.Zx81QvB7LmN2";
/** A shell command that prints the token without the command itself holding it. */
const PRINT_TOKEN = "printf 'ghp_%s%s\\n' abcdefghijklmnopqrstuvwxyz 0123456789";
const REDACTED = "[redacted secret]";

async function setup(env: Record<string, string> = {}, tools = "read,write,bash") {
	const dir = await tempAgentDir(cleanup);
	const workspace = join(dir, "workspace");
	mkdirSync(workspace, { recursive: true });
	const agent = await startTestAgent(undefined, { env: { WORKSPACE_DIR: workspace, WORKSPACE_TEMP_DIR: join(dir, "tmp"), WORKSPACE_TOOLS: tools, MODEL_API_KEY: MODEL_KEY, ...env } });
	cleanup.push(() => agent.close());
	/** What the model is shown each time it is asked (its messages, as JSON), then a final answer. */
	const seen: string[] = [];
	const finish = (context: { messages: unknown }) => {
		seen.push(JSON.stringify(context.messages));
		return answer("done");
	};
	return { agent, workspace, seen, finish };
}

const toolTexts = (view: { messages: { role: string; text?: string }[] }) => view.messages.filter((m) => m.role === "tool").map((m) => m.text ?? "");

describe("tool results are scrubbed before the model sees them and before they are stored", () => {
	it("bash output", async () => {
		const { agent, seen, finish } = await setup();
		agent.model.reply(toolCall("bash", { command: `${PRINT_TOKEN}; echo "key=$(printf '%s' '${MODEL_KEY}')"; echo plain` }), finish);
		await agent.send("t1", "go");
		const view = await agent.settled("t1");
		const [text] = toolTexts(view);
		expect(text).toContain(`${REDACTED}`);
		expect(text).toContain("key=[redacted secret]");
		expect(text).toContain("plain");
		// The command is the model's own (it holds the token's pieces, not the token); what came back is clean everywhere.
		for (const where of [JSON.stringify(view), seen.join("")]) {
			expect(where).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
		}
		expect(text).not.toContain("Zx81QvB7LmN2");
		expect(seen.join("")).toContain(REDACTED);
	}, 20_000);

	it("read output, and a .env file's values", async () => {
		const { agent, workspace, seen, finish } = await setup();
		writeFileSync(join(workspace, ".env"), `DB_PASSWORD=hunter2hunter2\nGITHUB=${TOKEN}\nPORT=8080\n`);
		agent.model.reply(toolCall("read", { path: ".env" }), finish);
		await agent.send("t1", "go");
		const [text] = toolTexts(await agent.settled("t1"));
		expect(text).toContain("DB_PASSWORD=[redacted secret]");
		expect(text).toContain("PORT=8080");
		expect(text).not.toContain("hunter2hunter2");
		expect(seen.join("")).not.toContain(TOKEN);
	}, 20_000);

	it("an MCP server's result, and its own env values", async () => {
		const dir = await tempAgentDir(cleanup);
		const server: McpServerConfig = {
			slug: "fx",
			name: "Fixture",
			transport: "stdio",
			command: process.execPath,
			args: [FIXTURE],
			cwd: dir,
			env: { FIXTURE_VALUE: "resolved-secret" },
			tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
		};
		const agent = await startTestAgent(undefined, { env: { MCP_SERVERS: JSON.stringify([server]) } });
		cleanup.push(() => agent.close());
		const seen: string[] = [];
		agent.model.reply(toolCall("mcp__fx__echo", { text: `my token is ${TOKEN}` }), (context: { messages: unknown }) => {
			seen.push(JSON.stringify(context.messages));
			return answer("done");
		});
		await agent.send("t1", "use the tool");
		const view = await agent.settled("t1");
		const [text] = toolTexts(view);
		expect(text).toContain("echo: my token is [redacted secret]");
		expect(text).toContain("value: [redacted secret]");
		expect(text).toContain("cwd:");
		expect(JSON.stringify(view) + seen.join("")).not.toContain("resolved-secret");
		// The token is in the model's own call (its argument); the server's reply, stored and shown to the model, has none.
		expect(seen.join("")).toContain('"content":[{"type":"text","text":"echo: my token is [redacted secret]');
	}, 20_000);

	it("an error a tool reports", async () => {
		const { agent, finish } = await setup();
		agent.model.reply(toolCall("read", { path: `${TOKEN}.txt` }), finish);
		await agent.send("t1", "go");
		const view = await agent.settled("t1");
		expect(toolTexts(view)[0]).not.toContain(TOKEN);
	}, 20_000);

	it("a command's output on screen while it runs", async () => {
		const { agent } = await setup();
		agent.model.reply(toolCall("bash", { command: `${PRINT_TOKEN}; sleep 3; echo done` }), answer("done"));
		await agent.send("t1", "go");
		const deadline = Date.now() + 10_000;
		let live = "";
		while (Date.now() < deadline && !live.includes(REDACTED)) {
			const view = await agent.view("t1");
			live = view?.tools.map((tool) => tool.output ?? "").join("") ?? "";
			expect(live).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(live).toContain(REDACTED);
		await agent.settled("t1", { timeoutMs: 15_000 });
	}, 30_000);
});

describe("the switch", () => {
	it("SCRUB_SECRETS=false leaves results as they are", async () => {
		const { agent, finish } = await setup({ SCRUB_SECRETS: "false" });
		agent.model.reply(toolCall("bash", { command: PRINT_TOKEN }), finish);
		await agent.send("t1", "go");
		const [text] = toolTexts(await agent.settled("t1"));
		expect(text).toContain(TOKEN);
	}, 20_000);

	it("images pass through untouched", async () => {
		const { agent, workspace, finish } = await setup();
		// A one-pixel PNG.
		writeFileSync(join(workspace, "dot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"));
		agent.model.reply(toolCall("read", { path: "dot.png" }), finish);
		await agent.send("t1", "go");
		const view = await agent.settled("t1");
		expect(JSON.stringify(view)).not.toContain(REDACTED);
		expect(view.messages.some((m) => m.role === "tool")).toBe(true);
	}, 20_000);
});

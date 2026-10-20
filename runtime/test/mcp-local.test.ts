import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { answer, startTestAgent, toolCall } from "@pdp/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type McpServerConfig } from "../src/lib/mcp.ts";
import { type ProbeEvent, probeMcpServer } from "../src/lib/probe.ts";
import { startOAuthMcpServer, startStateStore } from "./fixtures/oauth-mcp-server.ts";
import { tempAgentDir } from "./support.ts";

const RUNTIME_DIR = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));
const KEY = "agent-gateway-key-0123456789";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

const stdioServer = (cwd: string, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
	slug: "fx",
	name: "Fixture",
	transport: "stdio",
	command: process.execPath,
	args: [FIXTURE],
	cwd,
	env: { FIXTURE_VALUE: "resolved-secret" },
	...extra,
});

async function probe(request: Parameters<typeof probeMcpServer>[0], browser?: (url: string) => Promise<void>) {
	const events: ProbeEvent[] = [];
	const ok = await probeMcpServer(request, (event) => {
		events.push(event);
		if (event.type === "authorize" && browser) void browser(event.url);
	});
	return { ok, events, last: events.at(-1)! };
}

/** A person who approves at once: follows the authorization redirect back to the probe's loopback listener. */
async function approveInBrowser(url: string): Promise<void> {
	const res = await fetch(url, { redirect: "manual" });
	const location = res.headers.get("location");
	if (!location) throw new Error(`no redirect from ${url}: ${res.status}`);
	await fetch(location);
}

describe("stdio MCP servers", () => {
	it("probes a server: its info, its tools, and which are hidden from the model", async () => {
		const dir = await tempAgentDir(cleanup);
		const { ok, last } = await probe({ server: stdioServer(dir) });
		expect(ok).toBe(true);
		if (last.type !== "result") throw new Error(JSON.stringify(last));
		expect(last.serverInfo).toMatchObject({ name: "fixture" });
		expect(last.instructions).toBe("Fixture server.");
		expect(last.tools.map((t) => [t.name, t.modelVisible])).toEqual([
			["echo", true],
			["app_only", false],
			["fail", true],
		]);
	});

	it("reports a server that won't start, with what it wrote to stderr", async () => {
		const dir = await tempAgentDir(cleanup);
		const { ok, last } = await probe({ server: stdioServer(dir, { env: { FIXTURE_CRASH: "1" } }), timeoutMs: 10_000 });
		expect(ok).toBe(false);
		expect(last).toMatchObject({ type: "error", code: "connect_failed" });
		expect((last as { stderr?: string }).stderr).toContain("missing configuration");
	});

	it("runs as `runtime mcp-probe`: one request on stdin, JSON lines on stdout", async () => {
		const dir = await tempAgentDir(cleanup);
		const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "mcp-probe"], { cwd: RUNTIME_DIR, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (c: Buffer) => (out += c.toString()));
		child.stdin.end(JSON.stringify({ server: stdioServer(dir) }));
		const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
		expect(code).toBe(0);
		const last = JSON.parse(out.trim().split("\n").at(-1)!) as ProbeEvent;
		expect(last.type).toBe("result");
	}, 20_000);

	it("lets an agent call a stdio server's tool, in the server's own working directory and environment", async () => {
		const dir = await tempAgentDir(cleanup);
		const server = stdioServer(dir, { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
		const agent = await startTestAgent(undefined, { env: { MCP_SERVERS: JSON.stringify([server]) } });
		cleanup.push(() => agent.close());
		agent.model.reply(toolCall("mcp__fx__echo", { text: "hello" }), answer("done"));
		await agent.send("t1", "use the tool");
		const view = await agent.settled("t1");
		const result = view.messages.find((m) => m.role === "tool");
		expect(result?.isError).toBeFalsy();
		expect(result?.text).toContain("echo: hello");
		expect(result?.text).toContain(`cwd: ${realpathSync(dir)}`);
		expect(result?.text).toContain("value: resolved-secret");
	}, 20_000);
});

describe("OAuth MCP servers", () => {
	async function setup() {
		const mcp = await startOAuthMcpServer();
		cleanup.push(() => mcp.close());
		const store = await startStateStore(KEY);
		cleanup.push(() => store.close());
		const server: McpServerConfig = {
			slug: "remote",
			name: "Remote",
			url: mcp.url,
			oauth: { redirectUrl: "http://127.0.0.1/unused" },
			tools: [{ name: "whoami", description: "Who am I", inputSchema: { type: "object" } }],
		};
		return { mcp, store, server };
	}

	it("says a server needs a sign-in when the probe isn't asked to sign in", async () => {
		const { store, server } = await setup();
		const { ok, last } = await probe({ server, oauthUrl: store.url, key: KEY });
		expect(ok).toBe(false);
		expect(last).toMatchObject({ type: "error", code: "needs_sign_in" });
	});

	it("signs in through the probe, keeps the state in the app's store, and the agent then uses the server", async () => {
		const { mcp, store, server } = await setup();
		const signIn = await probe({ server, signIn: true, oauthUrl: store.url, key: KEY }, approveInBrowser);
		expect(signIn.events.map((e) => e.type)).toEqual(["authorize", "signed-in", "result"]);
		const saved = store.states.get("remote") as { tokens?: { access_token?: string }; clientInformation?: { redirect_uris?: string[] } };
		expect(saved.tokens?.access_token).toBeTruthy();
		const redirectUrl = saved.clientInformation?.redirect_uris?.[0];
		expect(redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);

		// The agent gets the redirect URI the client was registered with, and only reads and refreshes the state.
		const env = { MCP_SERVERS: JSON.stringify([{ ...server, oauth: { redirectUrl } }]), MCP_OAUTH_URL: store.url, PLATFORM_KEY: KEY };
		const agent = await startTestAgent(undefined, { env });
		cleanup.push(() => agent.close());
		agent.model.reply(toolCall("mcp__remote__whoami"), answer("done"));
		await agent.send("t1", "who am I?");
		const first = await agent.settled("t1");
		expect(first.messages.find((m) => m.role === "tool")?.text).toBe("you are the signed-in person");

		// The access token expires: the next session refreshes it, and the rotated refresh token is saved for next time.
		mcp.expireAccessTokens();
		const restarted = await agent.restart({ env, graceful: true });
		cleanup.push(() => restarted.close());
		restarted.model.reply(toolCall("mcp__remote__whoami", {}, { id: "c2" }), answer("done again"));
		await restarted.send("t1", "and now?");
		const second = await restarted.settled("t1", { messages: first.messages.length + 3 });
		expect(second.messages.filter((m) => m.role === "tool").at(-1)?.text).toBe("you are the signed-in person");
		expect(mcp.stats.refreshes).toBe(1);
		expect(mcp.stats.reusedRefresh).toBe(0);
		expect((store.states.get("remote") as { tokens: { refresh_token: string } }).tokens.refresh_token).not.toBe(
			(saved as { tokens: { refresh_token?: string } }).tokens.refresh_token,
		);
	}, 30_000);

	it("gives the model a clear error, and never starts a sign-in, when nobody has signed in", async () => {
		const { store, server } = await setup();
		const env = { MCP_SERVERS: JSON.stringify([server]), MCP_OAUTH_URL: store.url, PLATFORM_KEY: KEY };
		const agent = await startTestAgent(undefined, { env });
		cleanup.push(() => agent.close());
		agent.model.reply(toolCall("mcp__remote__whoami"), answer("I could not reach it"));
		await agent.send("t1", "who am I?");
		const view = await agent.settled("t1");
		const result = view.messages.find((m) => m.role === "tool");
		expect(result?.isError).toBe(true);
		expect(result?.text).toContain("needs you to sign in");
		expect(store.states.has("remote")).toBe(false);
	}, 20_000);
});

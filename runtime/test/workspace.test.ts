import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { answer, startTestAgent, toolCall } from "@pdp/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceEnv, parseWorkspaceTools } from "../src/lib/workspace.ts";
import { tempAgentDir } from "./support.ts";

const ctx = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

/** An agent folder with a workspace, a temp dir, and things outside the workspace worth stealing. */
async function layout() {
	const agentDir = await tempAgentDir(cleanup);
	const workspace = join(agentDir, "workspace");
	const temp = join(agentDir, "tmp");
	mkdirSync(workspace, { recursive: true });
	writeFileSync(join(agentDir, "secret.txt"), "TOP SECRET");
	writeFileSync(join(agentDir, "state.sqlite"), "not for tools");
	mkdirSync(join(agentDir, "workspace-evil"));
	writeFileSync(join(agentDir, "workspace-evil", "x.txt"), "sibling with the same prefix");
	writeFileSync(join(workspace, "hello.txt"), "hello");
	symlinkSync(join(agentDir, "secret.txt"), join(workspace, "link-to-secret"));
	symlinkSync(agentDir, join(workspace, "link-to-agent-dir"));
	symlinkSync("/etc", join(workspace, "etc"));
	return { agentDir, workspace, temp, env: createWorkspaceEnv({ root: workspace, tempDir: temp }) };
}

const denied = (result: { ok: boolean; error?: { code?: string } }) => !result.ok && result.error?.code === "permission_denied";

describe("the workspace environment", () => {
	it("allows files inside the workspace, by relative or absolute path (through /var or /private/var alike)", async () => {
		const { env, workspace } = await layout();
		expect((await env.readTextFile("hello.txt", ctx)).ok).toBe(true);
		expect((await env.readTextFile(join(workspace, "hello.txt"), ctx)).ok).toBe(true);
		expect((await env.readTextFile(join(realpathSync(workspace), "hello.txt"), ctx)).ok).toBe(true);
		expect((await env.writeFile("new/deep/file.md", "x", ctx)).ok).toBe(true);
		expect((await env.createDir("made/here", { recursive: true }, ctx)).ok).toBe(true);
		expect((await env.listDir(".", ctx)).ok).toBe(true);
		expect(readFileSync(join(workspace, "new/deep/file.md"), "utf8")).toBe("x");
	});

	it("refuses every way out: .., absolute paths, look-alike siblings, symlinks to files and directories", async () => {
		const { env, agentDir } = await layout();
		const attempts = [
			"../secret.txt",
			"new/../../secret.txt",
			join(agentDir, "secret.txt"),
			join(agentDir, "state.sqlite"),
			"../workspace-evil/x.txt",
			join(agentDir, "workspace-evil", "x.txt"),
			"link-to-secret",
			"link-to-agent-dir/secret.txt",
			"etc/hosts",
			"/etc/hosts",
			"/",
		];
		for (const path of attempts) {
			expect(denied(await env.readTextFile(path, ctx)), `read ${path}`).toBe(true);
			expect(denied(await env.fileInfo(path, ctx)), `stat ${path}`).toBe(true);
		}
		expect(denied(await env.listDir("/", ctx))).toBe(true);
		expect(denied(await env.listDir("..", ctx))).toBe(true);
		expect(denied(await env.exists(join(agentDir, "secret.txt"), ctx))).toBe(true);
	});

	it("refuses writes that would land outside, including through a symlinked directory and renames", async () => {
		const { env, agentDir } = await layout();
		expect(denied(await env.writeFile("../planted.txt", "x", ctx))).toBe(true);
		expect(denied(await env.writeFile("link-to-agent-dir/planted.txt", "x", ctx))).toBe(true);
		expect(denied(await env.writeFile("link-to-secret", "overwritten", ctx))).toBe(true);
		expect(denied(await env.appendFile("link-to-secret", "more", ctx))).toBe(true);
		expect(denied(await env.renameFile("hello.txt", "../hello.txt", ctx))).toBe(true);
		expect(denied(await env.renameFile("../secret.txt", "stolen.txt", ctx))).toBe(true);
		expect(denied(await env.remove("../secret.txt", { force: true }, ctx))).toBe(true);
		expect(denied(await env.createDir("../escape", { recursive: true }, ctx))).toBe(true);
		expect(existsSync(join(agentDir, "planted.txt"))).toBe(false);
		expect(readFileSync(join(agentDir, "secret.txt"), "utf8")).toBe("TOP SECRET");
		expect(existsSync(join(agentDir, "escape"))).toBe(false);
	});

	it("puts temporary files in the agent's own temp directory, where they can be read", async () => {
		const { env, temp } = await layout();
		const file = await env.createTempFile({ prefix: "out-" }, ctx);
		if (!file.ok) throw file.error;
		expect(file.value.startsWith(realpathSync(temp))).toBe(true);
		expect((await env.writeFile(file.value, "spilled", ctx)).ok).toBe(true);
		expect((await env.readTextFile(file.value, ctx)).ok).toBe(true);
	});

	it("rejects unknown tool names", () => {
		expect(parseWorkspaceTools("read, edit,read")).toEqual(["read", "edit"]);
		expect(() => parseWorkspaceTools("read,rm")).toThrow(/Unknown workspace tool "rm"/);
	});
});

describe("workspace tools in an agent", () => {
	async function agentWith(tools: string, extraEnv: Record<string, string> = {}) {
		const l = await layout();
		const agent = await startTestAgent(undefined, {
			env: { WORKSPACE_DIR: l.workspace, WORKSPACE_TEMP_DIR: l.temp, WORKSPACE_TOOLS: tools, ...extraEnv },
		});
		cleanup.push(() => agent.close());
		return { ...l, agent };
	}
	const toolResults = async (agent: Awaited<ReturnType<typeof startTestAgent>>, thread: string) =>
		(await agent.settled(thread)).messages.filter((m) => m.role === "tool");

	it("reads and writes in the workspace, and the model is told when it reaches outside", async () => {
		const { agent, workspace, agentDir } = await agentWith("read,write,edit");
		agent.model.reply(
			toolCall("read", { path: "hello.txt" }, { id: "c1" }),
			toolCall("read", { path: "../secret.txt" }, { id: "c2" }),
			toolCall("write", { path: "notes/today.md", content: "# Notes" }, { id: "c3" }),
			toolCall("write", { path: join(agentDir, "planted.md"), content: "x" }, { id: "c4" }),
			answer("done"),
		);
		await agent.send("t1", "go");
		const [read, readOut, write, writeOut] = await toolResults(agent, "t1");
		expect(read?.isError).toBeFalsy();
		expect(read?.text).toContain("hello");
		expect(readOut?.isError).toBe(true);
		expect(readOut?.text).toContain("outside the agent's workspace");
		expect(readOut?.text).not.toContain("TOP SECRET");
		expect(write?.isError).toBeFalsy();
		expect(readFileSync(join(workspace, "notes/today.md"), "utf8")).toBe("# Notes");
		expect(writeOut?.isError).toBe(true);
		expect(existsSync(join(agentDir, "planted.md"))).toBe(false);
	}, 20_000);

	it("runs bash in the workspace without the runtime's secrets in its environment", async () => {
		const { agent, workspace } = await agentWith("bash", { MODEL_API_KEY: "sk-must-not-leak", SOME_TOKEN: "also-secret" });
		agent.model.reply(
			toolCall("bash", { command: "pwd; echo key=[$MODEL_API_KEY] token=[$SOME_TOKEN]; env | grep -c -i -E 'key|token|secret' || true" }),
			answer("done"),
		);
		await agent.send("t1", "go");
		const [result] = await toolResults(agent, "t1");
		expect(result?.isError).toBeFalsy();
		expect(result?.text).toContain(realpathSync(workspace));
		expect(result?.text).toContain("key=[] token=[]");
		expect(result?.text).not.toContain("sk-must-not-leak");
	}, 20_000);

	it("keeps the process's own environment out of bash (the real runtime gets its keys there)", async () => {
		process.env.PI_LOCAL_TEST_LEAK = "sk-process-env-leak";
		try {
			const { agent } = await agentWith("bash", {});
			agent.model.reply(toolCall("bash", { command: "echo leak=[$PI_LOCAL_TEST_LEAK] path=[${PATH:+set}]" }), answer("done"));
			await agent.send("t1", "go");
			const [result] = await toolResults(agent, "t1");
			expect(result?.text).toContain("leak=[]");
			expect(result?.text).toContain("path=[set]");
		} finally {
			delete process.env.PI_LOCAL_TEST_LEAK;
		}
	}, 20_000);

	it("only has the tools it was given", async () => {
		const { agent } = await agentWith("read");
		agent.model.reply(toolCall("bash", { command: "echo hi" }), answer("done"));
		await agent.send("t1", "go");
		const [result] = await toolResults(agent, "t1");
		expect(result?.isError).toBe(true);
	}, 20_000);
});

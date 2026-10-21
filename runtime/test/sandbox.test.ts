import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { answer, startTestAgent, toolCall } from "@pdp/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { buildProfile, type SandboxPlatform, type SandboxPolicy, sandboxFor } from "../src/lib/sandbox/index.ts";
import { OutputScan, sandboxHint } from "../src/lib/sandbox/hints.ts";
import { createWorkspaceEnv, parseSandboxEnv, type WorkspaceSandbox } from "../src/lib/workspace.ts";
import { evaluate, parsePolicy } from "../src/lib/approval-rules.ts";
import { tempAgentDir } from "./support.ts";

const ctx = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

const darwin = process.platform === "darwin";

/** An agent's folder the way the app lays it out: <data>/agents/<id>/{workspace,tmp}, and a neighbour agent. */
async function layout() {
	const data = await tempAgentDir(cleanup);
	const agentDir = join(data, "agents", "mine");
	const otherDir = join(data, "agents", "theirs");
	const workspace = join(agentDir, "workspace");
	const temp = join(agentDir, "tmp");
	for (const dir of [workspace, temp, otherDir]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(agentDir, "agent.yaml"), "name: mine\n");
	writeFileSync(join(otherDir, "state.sqlite"), "THEIR CONVERSATIONS");
	writeFileSync(join(data, "app.db"), "THE APP DATABASE");
	return { data, agentDir, otherDir, workspace, temp };
}

type Layout = Awaited<ReturnType<typeof layout>>;

function sandboxed(l: Layout, extra: Partial<WorkspaceSandbox> = {}) {
	return createWorkspaceEnv({
		root: l.workspace,
		tempDir: l.temp,
		sandbox: { network: true, dataDir: l.data, agentDir: l.agentDir, ...extra },
	});
}

type Env = ReturnType<typeof sandboxed>;

/** Runs a command the way `bash` does and returns what it printed and its exit code (or the refusal). */
async function run(env: Env, command: string) {
	let output = "";
	const result = await env.exec(command, { onOutput: (text) => void (output += text) }, ctx);
	return result.ok ? { ok: true as const, exitCode: result.value.exitCode, output } : { ok: false as const, error: result.error, output };
}

describe.skipIf(!darwin)("the sandboxed shell (macOS)", () => {
	const made: string[] = [];
	afterEach(() => {
		for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	it("writes inside the workspace and the agent's temp folder, and to /tmp", async () => {
		const l = await layout();
		const env = sandboxed(l);
		const tmpFile = `/tmp/sandbox-e03-${process.pid}-${Date.now()}`;
		made.push(tmpFile);
		const r = await run(env, `pwd && echo hello > made.txt && mkdir -p deep/er && echo x > deep/er/y.txt && echo t > "$TMPDIR/t.txt" && echo tmp > ${tmpFile} && echo > /dev/null && cat made.txt`);
		expect(r).toMatchObject({ ok: true, exitCode: 0 });
		expect(r.output).toContain(realpathSync(l.workspace));
		expect(readFileSync(join(l.workspace, "made.txt"), "utf8")).toBe("hello\n");
		expect(existsSync(join(l.workspace, "deep/er/y.txt"))).toBe(true);
		expect(readFileSync(join(l.temp, "t.txt"), "utf8")).toBe("t\n");
		expect(readFileSync(tmpFile, "utf8")).toBe("tmp\n");
	}, 30_000);

	it("keeps the usual tools working: git, node, a redirect to stderr, a subshell, a pipe", async () => {
		const l = await layout();
		const env = sandboxed(l);
		const r = await run(
			env,
			"git init -q . && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x && git log --oneline | wc -l && node -e 'console.log(1+1)' && echo err >&2 && echo e > /dev/stderr && (echo sub) | cat",
		);
		expect(r).toMatchObject({ ok: true, exitCode: 0 });
		expect(r.output).toContain("2");
		expect(r.output).toContain("sub");
	}, 30_000);

	it("blocks writing to the home folder, and tells the model what happened", async () => {
		const l = await layout();
		const env = sandboxed(l);
		const name = `sandbox-test-${process.pid}-${Date.now()}`;
		const target = join(homedir(), name);
		made.push(target);
		const r = await run(env, `touch "$HOME/${name}"; echo "exit=$?"; echo hi > "$HOME/${name}-2"; echo "exit=$?"`);
		made.push(`${target}-2`);
		expect(r.ok).toBe(true);
		expect(existsSync(target)).toBe(false);
		expect(existsSync(`${target}-2`)).toBe(false);
		expect(r.output).toContain("Operation not permitted");
		expect(r.output).not.toContain("exit=0");
		expect(r.output).toContain(`The sandbox blocked writing outside the workspace: ${target}`);
	}, 30_000);

	it("blocks writes next to the workspace, in the agent's own folder and in other agents' folders", async () => {
		const l = await layout();
		const env = sandboxed(l);
		const r = await run(env, `echo x > ../planted.txt; echo x > ${l.agentDir}/agent.yaml; echo x > ${l.otherDir}/planted.txt; echo x > ${l.data}/app.db; true`);
		expect(r.ok).toBe(true);
		expect(existsSync(join(l.agentDir, "planted.txt"))).toBe(false);
		expect(readFileSync(join(l.agentDir, "agent.yaml"), "utf8")).toBe("name: mine\n");
		expect(existsSync(join(l.otherDir, "planted.txt"))).toBe(false);
		expect(readFileSync(join(l.data, "app.db"), "utf8")).toBe("THE APP DATABASE");
		expect((r.output.match(/Operation not permitted/g) ?? []).length).toBe(4);
	}, 30_000);

	it("blocks reading ~/.ssh and the other credential folders", async () => {
		const l = await layout();
		const env = sandboxed(l);
		// The real folders (those that exist on this computer): refused, not just empty.
		const present = [".ssh", ".aws", ".gnupg", "Library/Keychains"].filter((d) => existsSync(join(homedir(), d)));
		const real = await run(env, `${present.map((d) => `ls ~/${d}; echo exit=$?`).join("; ")}; true`);
		expect(real.ok).toBe(true);
		expect((real.output.match(/Operation not permitted/g) ?? []).length).toBe(present.length);
		expect(real.output).not.toContain("exit=0");
		if (present.length > 0) expect(real.output).toContain("it keeps credentials and other agents' data private");

		// A home folder of its own, with a key in it: the key is closed, the rest of the home folder is not.
		const home = await tempAgentDir(cleanup);
		mkdirSync(join(home, ".ssh"));
		writeFileSync(join(home, ".ssh", "id_test"), "PRIVATE KEY MATERIAL");
		writeFileSync(join(home, "notes.txt"), "just notes");
		const fake = await run(sandboxed(l, { home }), `cat ${home}/.ssh/id_test; echo exit=$?; cat ${home}/notes.txt`);
		expect(fake.output).not.toContain("PRIVATE KEY MATERIAL");
		expect(fake.output).toContain("just notes");
		expect(fake.output).toContain("Operation not permitted");
	}, 30_000);

	it("reads the rest of the computer, this agent's own folder, but not the app's data or other agents'", async () => {
		const l = await layout();
		const env = sandboxed(l);
		const r = await run(
			env,
			`head -c 20 /etc/hosts >/dev/null && echo etc-ok; cat ${l.agentDir}/agent.yaml; cat ${l.otherDir}/state.sqlite; cat ${l.data}/app.db; ls ${l.data}/agents; true`,
		);
		expect(r.output).toContain("etc-ok");
		expect(r.output).toContain("name: mine");
		expect(r.output).not.toContain("THEIR CONVERSATIONS");
		expect(r.output).not.toContain("THE APP DATABASE");
		expect((r.output.match(/Operation not permitted/g) ?? []).length).toBe(3);
	}, 30_000);

	describe("network", () => {
		let server: Server;
		let url: string;
		const listen = async () => {
			server = createServer((_req, res) => res.end("served by the test"));
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			cleanup.push(() => new Promise((resolve) => server.close(() => resolve(undefined))));
			url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
		};

		it("is on by default: curl reaches a server", async () => {
			await listen();
			const r = await run(sandboxed(await layout()), `curl -sS -m 10 ${url}`);
			expect(r).toMatchObject({ ok: true, exitCode: 0 });
			expect(r.output).toContain("served by the test");
		}, 30_000);

		it("off: curl can't connect, and the model is told the network is off", async () => {
			await listen();
			const r = await run(sandboxed(await layout(), { network: false }), `curl -sS -m 10 ${url}; echo "exit=$?"`);
			expect(r.output).not.toContain("served by the test");
			expect(r.output).not.toContain("exit=0");
			expect(r.output).toContain("The network is off for this agent");
		}, 30_000);
	});

	it("goes through the shell tool of an agent, and the balanced profile doesn't ask for it", async () => {
		const l = await layout();
		const name = `sandbox-test-agent-${process.pid}-${Date.now()}`;
		made.push(join(homedir(), name));
		const agent = await startTestAgent(undefined, {
			env: {
				WORKSPACE_DIR: l.workspace,
				WORKSPACE_TEMP_DIR: l.temp,
				WORKSPACE_TOOLS: "bash",
				WORKSPACE_SANDBOX: "on",
				WORKSPACE_SANDBOX_DATA_DIR: l.data,
				WORKSPACE_SANDBOX_AGENT_DIR: l.agentDir,
				TOOL_APPROVALS: JSON.stringify({ profile: "balanced", sandboxed: true, rules: [], builtin: [{ id: "b", tool: "bash", args: { command: "rm -rf*" }, action: "ask" }] }),
			},
		});
		cleanup.push(() => agent.close());
		agent.model.reply(
			toolCall("bash", { command: "echo inside > ok.txt && cat ok.txt" }, { id: "c1" }),
			toolCall("bash", { command: `touch "$HOME/${name}"` }, { id: "c2" }),
			toolCall("bash", { command: "rm -rf nothing-here" }, { id: "c3" }),
			answer("done"),
		);
		await agent.send("t1", "go");
		// The first two ran without asking; the built-in rule still asks for the third.
		const pending = await agent.pendingApproval("t1");
		expect(pending).toMatchObject({ tool: "bash", source: "builtin" });
		expect(await agent.decide(pending.id, "deny")).toBe(200);
		const results = (await agent.settled("t1")).messages.filter((m) => m.role === "tool");
		expect(results[0]?.isError).toBeFalsy();
		expect(results[0]?.text).toContain("inside");
		expect(results[1]?.isError).toBe(true);
		expect(results[1]?.text).toContain("Operation not permitted");
		expect(results[1]?.text).toContain("The sandbox blocked writing outside the workspace");
		expect(existsSync(join(homedir(), name))).toBe(false);
		expect(await agent.approvals("t1")).toHaveLength(1);
	}, 40_000);
});

describe("when the sandbox can't be used", () => {
	it("refuses on an OS without one, and says so, without running anything", async () => {
		const l = await layout();
		const marker = join(l.workspace, "ran.txt");
		const env = sandboxed(l, { platform: sandboxFor("linux") });
		const r = await run(env, `echo ran > ${marker}`);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.code).toBe("shell_unavailable");
		expect(r.error.message).toContain("not available on Linux yet");
		expect(r.error.message).toContain("Turn it off for this agent");
		expect(existsSync(marker)).toBe(false);
		expect((await run(sandboxed(l, { platform: sandboxFor("win32") }), "echo hi")).ok).toBe(false);
	});

	it("refuses when the mechanism is missing", async () => {
		const l = await layout();
		const missing: SandboxPlatform = {
			id: "darwin",
			check: () => ({ ok: false, reason: "The shell sandbox needs /usr/bin/sandbox-exec, which isn't on this computer." }),
			wrap: (argv) => [...argv],
			rules: () => ({ canRead: () => true, canWrite: () => true }),
		};
		const r = await run(sandboxed(l, { platform: missing }), `echo ran > ${join(l.workspace, "ran.txt")}`);
		expect(r.ok).toBe(false);
		expect(existsSync(join(l.workspace, "ran.txt"))).toBe(false);
	});

	it("refuses when the sandbox doesn't start, with what the system said", async () => {
		const l = await layout();
		const broken: SandboxPlatform = {
			id: "darwin",
			check: () => ({ ok: true }),
			wrap: () => ["/bin/sh", "-c", "echo 'sandbox_apply: Operation not permitted' >&2; exit 71"],
			rules: () => ({ canRead: () => true, canWrite: () => true }),
		};
		const r = await run(sandboxed(l, { platform: broken }), "echo hi");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.code).toBe("shell_unavailable");
		expect(r.error.message).toContain("could not start");
		expect(r.error.message).toContain("sandbox_apply: Operation not permitted");
	});

	it("an app that says the shell is sandboxed doesn't make bash run without asking when this runtime isn't sandboxing", async () => {
		const l = await layout();
		const agent = await startTestAgent(undefined, {
			env: {
				WORKSPACE_DIR: l.workspace,
				WORKSPACE_TEMP_DIR: l.temp,
				WORKSPACE_TOOLS: "bash",
				TOOL_APPROVALS: JSON.stringify({ profile: "balanced", sandboxed: true, rules: [], builtin: [] }),
			},
		});
		cleanup.push(() => agent.close());
		agent.model.reply(toolCall("bash", { command: "echo hi" }), answer("done"));
		await agent.send("t1", "go");
		expect(await agent.pendingApproval("t1")).toMatchObject({ tool: "bash", source: "profile" });
	}, 30_000);
});

describe("the profile", () => {
	const policy = (over: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
		workspace: "/tmp/e03-ws",
		tempDir: "/tmp/e03-tmp",
		home: "/Users/someone",
		dataDir: "/tmp/e03-data",
		agentDir: "/tmp/e03-data/agents/a",
		network: true,
		...over,
	});

	it("denies writing by default, closes the credentials and the data folder, and leaves the network alone when on", () => {
		const profile = buildProfile(policy());
		expect(profile).toContain("(allow default)");
		expect(profile).toContain("(deny file-write*)");
		for (const dir of [".ssh", ".gnupg", ".aws", "Library/Keychains"]) expect(profile).toContain(`/Users/someone/${dir}`);
		expect(profile).toMatch(/\(deny file-write\* file-read\* \(subpath "[^"]*e03-data"\)\)/);
		expect(profile).toContain("com.apple.SecurityServer");
		// The folders leading to this agent's own can be looked at, not read.
		expect(profile).toMatch(/\(allow file-read-metadata \(literal "[^"]*e03-data"\) \(literal "[^"]*e03-data\/agents"\)\)/);
		expect(profile).not.toContain("network");
	});

	it("adds the network rules when it is off", () => {
		const profile = buildProfile(policy({ network: false }));
		expect(profile).toContain("(deny network-outbound (remote ip))");
		expect(profile).toContain("(deny network-bind)");
	});

	it("orders the rules from general to specific (later wins): credentials last", () => {
		const profile = buildProfile(policy());
		expect(profile.indexOf("(deny file-write*)")).toBeLessThan(profile.indexOf("/private/tmp"));
		expect(profile.indexOf("e03-data\"))")).toBeLessThan(profile.indexOf("e03-ws"));
		expect(profile.indexOf("e03-ws")).toBeLessThan(profile.indexOf("/Users/someone/.ssh"));
	});

	it("escapes quotes and backslashes in paths, and refuses line breaks", () => {
		expect(buildProfile(policy({ workspace: '/tmp/a "b" \\c' }))).toContain('(subpath "/private/tmp/a \\"b\\" \\\\c")');
		expect(() => buildProfile(policy({ workspace: "/tmp/a\nb" }))).toThrow(/line break/);
	});
});

describe("hints", () => {
	const rules = {
		canRead: (p: string) => !p.includes("/.ssh"),
		canWrite: (p: string) => p.startsWith("/work/") || p.startsWith("/tmp/"),
	};
	const policy: SandboxPolicy = { workspace: "/work/ws", tempDir: "/work/tmp", home: "/h", network: true };
	const hint = (output: string, p = policy) => sandboxHint(output, p, rules);

	it("names the path a write was blocked at, for the usual tools' messages", () => {
		expect(hint("touch: /Users/x/f: Operation not permitted")).toBe(
			"The sandbox blocked writing outside the workspace: /Users/x/f. Commands can write in the workspace, its temp folder and /tmp.",
		);
		expect(hint("bash: /Users/x/g: Operation not permitted")).toContain("/Users/x/g");
		expect(hint("PermissionError: [Errno 1] Operation not permitted: '/Users/x/h.py'")).toContain("/Users/x/h.py");
		expect(hint("Error: EPERM: operation not permitted, open '/Users/x/i.js'")).toContain("/Users/x/i.js");
	});

	it("says reading is closed for credentials", () => {
		expect(hint("ls: /h/.ssh: Operation not permitted")).toBe("The sandbox blocked access to /h/.ssh: it keeps credentials and other agents' data private.");
	});

	it("says nothing when the failure is inside what is allowed, or isn't a refusal", () => {
		expect(hint("cp: /work/ws/a: Operation not permitted")).toBeUndefined();
		expect(hint("Operation not permitted")).toContain("This may be the sandbox");
		expect(hint("cp: /work/ws/a: No such file or directory")).toBeUndefined();
		expect(hint("all fine")).toBeUndefined();
	});

	it("names the network only when it is off", () => {
		const failure = "curl: (7) Failed to connect to example.com port 443: Couldn't connect to server";
		expect(hint(failure)).toBeUndefined();
		expect(hint(failure, { ...policy, network: false })).toContain("The network is off for this agent");
	});

	it("distinguishes socket permission failures and silent curl from write failures", () => {
		const off = { ...policy, network: false };
		const python = 'File "<string>", line 1\n  s.connect(("example.com", 443))\nPermissionError: [Errno 1] Operation not permitted';
		expect(sandboxHint(python, off, rules)).toContain("The network is off");
		expect(sandboxHint(python, off, rules)).not.toContain("only write");
		expect(sandboxHint("", off, rules, { command: "curl -s https://example.com", exitCode: 7 })).toContain("The network is off");
		expect(sandboxHint("", policy, rules, { command: "curl -s https://example.com", exitCode: 7 })).toBeUndefined();
		expect(sandboxHint("", off, rules, { command: "curl -s https://example.com", exitCode: 0 })).toBeUndefined();
		expect(sandboxHint("", off, rules, { command: "false", exitCode: 7 })).toBeUndefined();
	});

	it("scans a bounded tail", () => {
		const scan = new OutputScan();
		for (let i = 0; i < 100; i++) scan.push("x".repeat(10_000));
		scan.push("touch: /Users/x/f: Operation not permitted");
		expect(scan.value.length).toBeLessThanOrEqual(256 * 1024);
		expect(hint(scan.value)).toContain("/Users/x/f");
	});
});

describe("settings from the environment, and approvals", () => {
	it("reads WORKSPACE_SANDBOX*", () => {
		expect(parseSandboxEnv({})).toBeUndefined();
		expect(parseSandboxEnv({ WORKSPACE_SANDBOX: "off" })).toBeUndefined();
		expect(parseSandboxEnv({ WORKSPACE_SANDBOX: "on" })).toEqual({ network: true });
		expect(parseSandboxEnv({ WORKSPACE_SANDBOX: "on", WORKSPACE_SANDBOX_NETWORK: "off", WORKSPACE_SANDBOX_DATA_DIR: "/d", WORKSPACE_SANDBOX_AGENT_DIR: "/d/agents/a" })).toEqual({
			network: false,
			dataDir: "/d",
			agentDir: "/d/agents/a",
		});
	});

	const builtin = [{ id: "rm", tool: "bash", args: { command: "rm -rf*" }, action: "ask" }];
	it("the balanced profile stops asking for bash when sandboxed; the built-in rules and careful still ask", () => {
		const balanced = parsePolicy({ profile: "balanced", builtin, sandboxed: true });
		expect(evaluate(balanced, "bash", { command: "ls" }).action).toBe("allow");
		expect(evaluate(balanced, "bash", { command: "rm -rf build" })).toMatchObject({ action: "ask", source: "builtin" });
		expect(evaluate(parsePolicy({ profile: "balanced", builtin }), "bash", { command: "ls" })).toMatchObject({ action: "ask", source: "profile" });
		expect(evaluate(parsePolicy({ profile: "careful", builtin, sandboxed: true }), "bash", { command: "ls" })).toMatchObject({ action: "ask", source: "profile" });
		expect(evaluate(balanced, "write", { path: "a" }).action).toBe("allow");
	});
});

// The first-party kinds (docs/first-party-agents.md): picked by AGENT_KIND, their settings checked, and built with the
// library's public exports only, so a custom agent could build the same.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentDefinitionError, assistantAgent, assistantExtension, defineAgent, defineExtension, defineSubagent, section } from "@pdp/runtime";
import * as kinds from "@pdp/runtime/kinds";
import { fakeModel, startTestAgent, toolCall } from "@pdp/runtime/testing";
import { describe, expect, it } from "vitest";

const KINDS_DIR = fileURLToPath(new URL("../src/kinds/", import.meta.url));

describe("agent kinds", () => {
	it("picks the composition by kind; absent or empty is the assistant", () => {
		expect(kinds.agentForKind(undefined)).toBe(assistantAgent);
		expect(kinds.agentForKind("")).toBe(assistantAgent);
		expect(kinds.agentForKind("assistant", "{}")).toBe(assistantAgent);
		expect(kinds.agentForKind("triage").name).toBe("triage");
		expect(kinds.agentForKind("researcher").name).toBe("researcher");
		expect(kinds.agentFromEnv({ AGENT_KIND: "researcher", AGENT_KIND_SETTINGS: '{"backgroundSubagents":false}' }).name).toBe("researcher");
		expect([...kinds.AGENT_KINDS]).toEqual(["assistant", "triage", "researcher", "coding"]);
	});

	it("refuses an unknown kind and settings the kind doesn't take", () => {
		expect(() => kinds.agentForKind("poet")).toThrow(AgentDefinitionError);
		expect(() => kinds.agentForKind("Triage")).toThrow(/unknown AGENT_KIND/);
		expect(() => kinds.agentForKind("assistant", '{"listTools":[]}')).toThrow(AgentDefinitionError);
		expect(() => kinds.agentForKind("triage", "not json")).toThrow(AgentDefinitionError);
		expect(() => kinds.agentForKind("triage", "[]")).toThrow(AgentDefinitionError);
		expect(() => kinds.agentForKind("triage", '{"writeTool":["x"]}')).toThrow(/unknown field/);
		expect(() => kinds.agentForKind("triage", '{"writeTools":["bad name!"]}')).toThrow(AgentDefinitionError);
		expect(() => kinds.agentForKind("triage", '{"approveWrites":"yes"}')).toThrow(AgentDefinitionError);
		expect(() => kinds.agentForKind("researcher", '{"maxPlanSteps":0}')).toThrow(AgentDefinitionError);
		expect(() => kinds.agentForKind("researcher", '{"maxPlanSteps":21}')).toThrow(AgentDefinitionError);
	});

	it("parses settings with their defaults", () => {
		expect(kinds.parseTriageSettings(undefined)).toEqual({ listTools: [], readTools: [], writeTools: [], approveWrites: true });
		expect(kinds.parseTriageSettings('{"writeTools":["mcp__gh__add_comment","mcp__gh__add_comment"],"approveWrites":false}')).toMatchObject({
			writeTools: ["mcp__gh__add_comment"],
			approveWrites: false,
		});
		expect(kinds.parseResearcherSettings("")).toEqual({ backgroundSubagents: true, maxPlanSteps: 8 });
		expect(kinds.toolMatchesAny(["mcp__gh__*"], "mcp__gh__add_comment")).toBe(true);
		expect(kinds.toolMatchesAny(["mcp__gh__add_*"], "mcp__gh__list_issues")).toBe(false);
		expect(kinds.toolMatchesAny(["mcp__g.h__x"], "mcp__gxh__x")).toBe(false);
	});

	it("are built with the library's public exports only", () => {
		const files = readdirSync(KINDS_DIR).filter((f) => f.endsWith(".ts"));
		expect(files.length).toBeGreaterThanOrEqual(4);
		for (const file of files) {
			const source = readFileSync(KINDS_DIR + file, "utf8");
			const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g), ...source.matchAll(/import\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]!);
			expect(specifiers.length, file).toBeGreaterThan(0);
			for (const specifier of specifiers) {
				// The library's main entry, or another module of the kinds: never pi-durable, the library's internals or node.
				const allowed = specifier === "@pdp/runtime" || /^\.\/[a-z-]+\.ts$/.test(specifier);
				expect(allowed, `${file} imports ${specifier}`).toBe(true);
			}
		}
	});

	it("make a variant from their parts (docs/first-party-agents.md, Building a variant)", async () => {
		const settings = kinds.parseResearcherSettings('{"maxPlanSteps":2}');
		const variant = defineAgent({
			name: "cheap-researcher",
			documents: [kinds.ResearchPlanDoc, kinds.ResearchSourcesDoc],
			expose: [kinds.ResearchPlanDoc, kinds.ResearchSourcesDoc],
			extensions: ({ instructions }) => [
				assistantExtension(instructions),
				defineExtension({ name: "research", tools: kinds.researchTools(settings), sections: [section("research", () => kinds.researchPrompt(settings))] }),
				defineSubagent({ name: "research_quick", description: "A short question", instructions: kinds.SUBAGENT_INSTRUCTIONS }),
			],
			settings: { toolExecution: "parallel", compaction: { enabled: true } },
		});
		const model = fakeModel();
		model.reply(toolCall("research_plan", { question: "Q?", steps: ["a", "b", "c"] }, { id: "p1" }), "Planned.");
		const agent = await startTestAgent(variant, { model });
		try {
			await agent.send("t", "Research Q");
			await agent.settled("t");
			expect(((await agent.document("t", "research.plan"))?.value as kinds.ResearchPlan).steps.map((s) => s.text)).toEqual(["a", "b"]);
		} finally {
			await agent.close();
		}
	});
});

describe("the coding kind", () => {
	it("prompts like the pi coding agent, with the project's own instructions read fresh each turn", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { homedir } = await import("node:os");
		const { join } = await import("node:path");
		const repo = mkdtempSync(join(homedir(), ".pi-local-kinds-test-"));
		try {
			mkdirSync(join(repo, ".git"));
			mkdirSync(join(repo, "app"));
			writeFileSync(join(repo, "AGENTS.md"), "ROOT RULES");
			writeFileSync(join(repo, "app", "CLAUDE.md"), "APP RULES");
			const prompts: string[] = [];
			const model = fakeModel();
			const capture = (text: string) => (context: unknown) => {
				prompts.push(JSON.stringify(context));
				return { role: "assistant", content: [{ type: "text", text }], api: "faux", provider: "fake", model: "fake-1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as never;
			};
			model.reply(capture("one"), capture("two"));
			const agent = await startTestAgent(kinds.agentForKind("coding"), {
				model,
				instructions: "Prefer small diffs.",
				env: { WORKSPACE_DIR: join(repo, "app"), WORKSPACE_TOOLS: "read,edit,bash" },
			});
			try {
				await agent.send("t", "first");
				await agent.settled("t");
				writeFileSync(join(repo, "app", "CLAUDE.md"), "APP RULES, CHANGED");
				await agent.send("t", "second");
				await agent.settled("t");
			} finally {
				await agent.close();
			}
			const [first, second] = prompts;
			for (const want of ["expert coding assistant", "- read: Read file contents", "- bash: Execute bash commands", "Prefer small diffs.", "ROOT RULES", "APP RULES", "<cwd>"]) {
				expect(first, want).toContain(want);
			}
			expect(first).not.toContain("- write:");
			expect(first!.indexOf("ROOT RULES")).toBeLessThan(first!.indexOf("APP RULES"));
			expect(second).toContain("APP RULES, CHANGED");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("stops at the repository's root and takes no settings", () => {
		expect(() => kinds.agentForKind("coding", '{"x":1}')).toThrow(/unknown field/);
		expect(kinds.agentForKind("coding", "{}").name).toBe("coding");
	});
});

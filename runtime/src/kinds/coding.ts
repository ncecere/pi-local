// The coding agent: Pi Local's counterpart of the pi coding agent (@earendil-works/pi-coding-agent, MIT; its
// system-prompt.js and resource-loader.js). It works in a project folder (WORKSPACE_DIR) with read, write, edit and
// bash, and its prompt is pi's: a preamble, the tools, the working rules, the project's own instructions
// (AGENTS.md / CLAUDE.md from the folder up to its repository's root, read fresh each turn) and the working directory.
// A person's instructions for the agent are added, not swapped for the preamble.
import { type AgentDefinition, DEFAULT_INSTRUCTIONS, defineAgent, defineExtension, type Extension, projectContextFiles, section } from "@pdp/runtime";
import { onlyFields, parseObject } from "./settings.ts";

/** A coding agent's kind settings (`AGENT_KIND_SETTINGS`): none yet. */
export type CodingSettings = Record<string, never>;

export function parseCodingSettings(raw: string | undefined): CodingSettings {
	onlyFields(parseObject(raw, "coding"), "coding", []);
	return {};
}

export const CODING_PREAMBLE =
	"You are an expert coding assistant running in Pi Local, on the person's own computer. You help them by reading files, executing commands, editing code, and writing new files in their project.";

/** What each workspace tool is for, in the prompt's tool list (pi's tool snippets). */
const TOOL_SNIPPETS: Record<string, string> = {
	read: "Read file contents",
	bash: "Execute bash commands (ls, grep, find, etc.)",
	edit: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	write: "Create or overwrite files",
};

function rules(tools: readonly string[]): string {
	const out: string[] = [];
	if (tools.includes("bash")) out.push("Use bash for file operations like ls, rg, find");
	if (tools.includes("edit")) out.push("Use edit for precise changes; keep each oldText as small as possible while still unique in the file");
	if (tools.includes("write")) out.push("Use write only for new files or complete rewrites");
	if (tools.includes("read")) out.push("Use read to examine files instead of cat or sed");
	out.push("Work inside the project folder; file tools can't reach outside it");
	out.push("Be concise in your responses");
	out.push("Show file paths clearly when working with files");
	return out.map((r) => `- ${r}`).join("\n");
}

/** The coding agent's prompt. */
export function codingExtension(options: { workspace: string; tools: readonly string[]; instructions?: string }): Extension {
	const { workspace, tools } = options;
	const listed = tools.filter((t) => TOOL_SNIPPETS[t] !== undefined);
	return defineExtension({
		name: "coding",
		sections: [
			section("preamble", () => CODING_PREAMBLE, { tag: false }),
			section(
				"tools",
				() =>
					`${listed.length > 0 ? listed.map((t) => `- ${t}: ${TOOL_SNIPPETS[t]}`).join("\n") : "(no workspace tools: turn them on in the agent's Tools settings)"}\n\nIn addition to the tools above, you may have access to other tools (MCP servers, asking other agents).`,
			),
			section("rules", () => rules(tools)),
			...(options.instructions ? [section("addendum", () => options.instructions)] : []),
			section("project_context", () => {
				const files = projectContextFiles(workspace);
				if (files.length === 0) return undefined;
				return [
					"Project-specific instructions and guidelines:",
					...files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
				].join("\n\n");
			}),
			section("cwd", () => workspace),
		],
	});
}

/** The coding agent, working in WORKSPACE_DIR with WORKSPACE_TOOLS (the app gives it read, write, edit and bash). */
export function codingAgent(_settings: CodingSettings = {}): AgentDefinition {
	return defineAgent({
		name: "coding",
		extensions: ({ env, instructions }) => [
			codingExtension({
				workspace: env.WORKSPACE_DIR ?? process.cwd(),
				tools: (env.WORKSPACE_TOOLS ?? "").split(",").map((t) => t.trim()).filter(Boolean),
				// The person's own instructions, on top of the coding prompt (none: the platform's default, which isn't theirs).
				instructions: instructions.trim() && instructions !== DEFAULT_INSTRUCTIONS ? instructions.trim() : undefined,
			}),
		],
	});
}

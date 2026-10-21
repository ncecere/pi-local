/**
 * Approval rules and profiles (docs/api.md, "Approval rules and profiles"): which tool calls ask a person first, which
 * run, and which are refused. Pure (no storage, no clock), so the matching can be tested alone. The platform renders an
 * agent's policy to `TOOL_APPROVALS` (parsed by `parsePolicy`); the approvals extension (approvals.ts) asks `evaluate`
 * about every call.
 *
 * Order, for one call:
 *  1. `rules`, in order: the first that matches decides allow, ask or deny. A deny stops here.
 *  2. The built-in rules (`builtin`): a match asks, whatever a rule above says (an allow rule can't loosen them).
 *  3. The first rule's verdict, if there was one.
 *  4. The profile: `custom` asks for the tools in `tools` (names or `*` patterns); the others by what a tool can change.
 *  5. Otherwise the call runs. (`explicit` tells whether a rule said so: fast judgments tighten only the rest.)
 */

export type RuleAction = "allow" | "ask" | "deny";
export type Profile = "careful" | "balanced" | "trusting" | "custom";
export const PROFILES: readonly Profile[] = ["careful", "balanced", "trusting", "custom"];

/** One rule: a tool name or `*` pattern, and optionally argument globs that must all match (`*`: any characters). */
export type ApprovalRule = { id?: string; tool: string; args?: Record<string, string>; action: RuleAction };

/** MCP tool annotations (the spec's hints), as far as they are known. */
export type ToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };

/** What the policy knows about a tool beyond its name: MCP tools have the server's own name and annotations. */
export type ToolInfo = { mcp?: boolean; toolName?: string; annotations?: ToolAnnotations };

export type RulePolicy = {
	profile: Profile;
	/** Custom only: tool names or patterns that ask first (`approvals.tools`). */
	tools: readonly string[];
	rules: readonly ApprovalRule[];
	/** Built-in rules (always ask), shown on the Tools tab, can't be removed. */
	builtin: readonly ApprovalRule[];
	/**
	 * The agent's shell runs in the sandbox (and the runtime really does that: see `Approvals.shellSandboxed`): the
	 * balanced profile lets `bash` run without asking, the built-in rules still ask. Careful still asks.
	 */
	sandboxed?: boolean;
};

/** Why a call asks, runs or is refused. */
export type Source = "rule" | "builtin" | "profile" | "tools";
export type Verdict =
	| { action: "deny"; source: "rule"; rule: ApprovalRule }
	| { action: "ask"; source: Source; rule?: ApprovalRule }
	| { action: "allow"; source: "rule"; rule: ApprovalRule; explicit: true }
	| { action: "allow"; source?: undefined; explicit: false };

export const DENIED_MESSAGE = "Not allowed by your approval rules";

const MAX_RULES = 500;
const MAX_ARGS = 10;

/** Whether a tool name matches a pattern (`*`: any characters). */
export function toolMatches(pattern: string, name: string): boolean {
	return globToRegExp(pattern).test(name);
}

function globToRegExp(pattern: string): RegExp {
	// `s`: `*` also crosses line breaks (a command may be several lines).
	return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*")}$`, "s");
}

/** An argument's string value: strings as they are, numbers and booleans as written, anything else as JSON. */
function argString(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

// ── Shell commands ────────────────────────────────────────────────────────────────────────────────────────────

/** Redirects that change nothing worth asking about: `2>&1`, `>/dev/null`. */
const HARMLESS_REDIRECT = /\d*>&\d+|\d*>>?\s*\/dev\/null/g;
/** What chains or nests commands: `;`, `&&`, `||`, `|`, `&`, line breaks, backticks, `$(`, `<(`, `>(`, and any other redirect. */
const SHELL_CONTROL = /[;&|`\n\r<>]|\$\(/;

/**
 * A shell command read for rules: whether it is a single simple command (no chaining, pipes, substitutions or
 * redirects), and its parts. A glob can't tell `git status && rm -rf ~` from `git status`, so an allow rule only ever
 * matches a simple command, and a rule that asks or denies also matches any part of a compound one.
 */
export function shellParts(command: string): { simple: boolean; segments: string[] } {
	const trimmed = command.trim();
	const plain = trimmed.replace(HARMLESS_REDIRECT, "");
	if (!SHELL_CONTROL.test(plain)) return { simple: true, segments: [trimmed] };
	const segments = plain
		.split(/[;&|`\n\r<>]+|\$\(|\)/)
		.map((s) => s.trim())
		.filter((s) => s !== "");
	return { simple: false, segments };
}

/** Whether a value has a `..` path segment (an allow rule's glob must not be walked out of). */
function climbs(value: string): boolean {
	return value.split(/[\\/]/).includes("..");
}

/** Whether one argument glob matches the value, for a rule with this action. */
function argMatches(glob: string, raw: string, action: RuleAction, shell: boolean): boolean {
	const re = globToRegExp(glob);
	if (shell) {
		const { simple, segments } = shellParts(raw);
		// A command-prefix rule includes the bare command, but not another program/subcommand with the same prefix:
		// `ls *` matches `ls` and `ls -la`, never `lsof`; `git status *` never matches `git status-other`.
		const matches = (command: string) => re.test(command) || (glob.endsWith(" *") && command === glob.slice(0, -2));
		// An allow only covers a simple command; ask and deny also see each part of a compound one.
		if (action === "allow") return simple && matches(raw.trim());
		return matches(raw.trim()) || segments.some(matches);
	}
	if (action === "allow" && climbs(raw)) return false;
	return re.test(raw);
}

/** Whether a rule matches a call of `name` with `args` (the raw arguments, not a redacted view). */
export function ruleMatches(rule: ApprovalRule, name: string, args: unknown): boolean {
	if (!toolMatches(rule.tool, name)) return false;
	const entries = Object.entries(rule.args ?? {});
	if (entries.length === 0) return true;
	const given = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
	for (const [key, glob] of entries) {
		const value = argString(given[key]);
		if (value === undefined) return false;
		if (!argMatches(glob, value, rule.action, name === "bash" && key === "command")) return false;
	}
	return true;
}

// ── What a tool can change ────────────────────────────────────────────────────────────────────────────────────

const SCHEDULE_TOOLS = new Set(["schedule", "cancel_schedule"]);
/** Words in an MCP tool's name that say it changes something (when its annotations don't say it only reads). */
const MUTATING_WORDS = new Set(["delete", "remove", "send", "update", "create", "write", "post"]);

/** The words of a tool name: `create_issue`, `createIssue` and `create-issue` are `create`, `issue`. */
export function nameWords(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter((w) => w !== "")
		.map((w) => w.toLowerCase());
}

/** The MCP tool's own name: `mcp__github__create_issue` is `create_issue`. */
function ownName(name: string, info: ToolInfo | undefined): string {
	if (info?.toolName !== undefined) return info.toolName;
	const parts = name.split("__");
	return parts.length > 2 ? parts.slice(2).join("__") : name;
}

/** Whether an MCP tool is named like something that changes things (the fallback when its annotations are silent). */
export function mutatingName(name: string, info?: ToolInfo): boolean {
	return nameWords(ownName(name, info)).some((w) => MUTATING_WORDS.has(w));
}

/**
 * Whether a call can change something: write, edit, bash, the schedule tools, and MCP tools not marked read-only.
 * (notify_person, memory, web and the like are left out.) Fast judgments only look at these.
 */
export function changesThings(name: string, info?: ToolInfo): boolean {
	if (name === "write" || name === "edit" || name === "bash" || SCHEDULE_TOOLS.has(name)) return true;
	return info?.mcp === true && info.annotations?.readOnlyHint !== true;
}

/** Whether a profile (not `custom`) asks before this tool. */
export function profileAsks(profile: Profile, name: string, info?: ToolInfo, sandboxed = false): boolean {
	switch (profile) {
		case "careful":
			return changesThings(name, info);
		case "balanced":
			if (name === "bash") return !sandboxed;
			if (info?.mcp !== true) return false;
			if (info.annotations?.destructiveHint === true) return true;
			return info.annotations?.readOnlyHint !== true && mutatingName(name, info);
		default:
			return false;
	}
}

// ── The verdict ───────────────────────────────────────────────────────────────────────────────────────────────

export function evaluate(policy: RulePolicy, name: string, args: unknown, info?: ToolInfo): Verdict {
	let first: ApprovalRule | undefined;
	for (const rule of policy.rules) {
		if (ruleMatches(rule, name, args)) {
			first = rule;
			break;
		}
	}
	if (first?.action === "deny") return { action: "deny", source: "rule", rule: first };
	for (const rule of policy.builtin) if (ruleMatches({ ...rule, action: "ask" }, name, args)) return { action: "ask", source: "builtin", rule };
	if (first?.action === "ask") return { action: "ask", source: "rule", rule: first };
	if (first?.action === "allow") return { action: "allow", source: "rule", rule: first, explicit: true };
	if (policy.profile === "custom") {
		return policy.tools.some((pattern) => toolMatches(pattern, name)) ? { action: "ask", source: "tools" } : { action: "allow", explicit: false };
	}
	return profileAsks(policy.profile, name, info, policy.sandboxed === true) ? { action: "ask", source: "profile" } : { action: "allow", explicit: false };
}

/** A plain explanation for a built-in ask rule. */
export function builtinSummary(rule: ApprovalRule): string {
	const pattern = rule.args?.command;
	if (pattern === "sudo *") return "Asked because it uses sudo (always asks).";
	if (pattern === "rm -rf*") return "Asked because it removes files recursively (always asks).";
	if (pattern === "git push --force*") return "Asked because it force-pushes changes (always asks).";
	if (pattern === "* | sh" || pattern === "curl * | *sh") return "Asked because it pipes text into a shell to run (always asks).";
	return "This command always asks for approval.";
}

/** A rule as a person reads it: `bash (command: git status*)`. */
export function describeRule(rule: ApprovalRule): string {
	const args = Object.entries(rule.args ?? {}).map(([k, v]) => `${k}: ${v}`);
	return args.length === 0 ? rule.tool : `${rule.tool} (${args.join(", ")})`;
}

// ── TOOL_APPROVALS ────────────────────────────────────────────────────────────────────────────────────────────

function parseRules(value: unknown): ApprovalRule[] {
	if (!Array.isArray(value)) return [];
	const out: ApprovalRule[] = [];
	for (const item of value.slice(0, MAX_RULES)) {
		if (typeof item !== "object" || item === null) continue;
		const { id, tool, args, action } = item as Record<string, unknown>;
		if (typeof tool !== "string" || tool.length === 0 || tool.length > 200) continue;
		if (action !== "allow" && action !== "ask" && action !== "deny") continue;
		const rule: ApprovalRule = { tool, action };
		if (typeof id === "string") rule.id = id.slice(0, 64);
		if (typeof args === "object" && args !== null && !Array.isArray(args)) {
			const entries = Object.entries(args as Record<string, unknown>)
				.filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0 && e[1].length <= 1000)
				.slice(0, MAX_ARGS);
			if (entries.length > 0) rule.args = Object.fromEntries(entries);
		}
		out.push(rule);
	}
	return out;
}

/** The rules part of `TOOL_APPROVALS` (`{profile?, tools?, rules?, builtin?, sandboxed?}`); anything missing or malformed is none. */
export function parsePolicy(value: { profile?: unknown; tools?: unknown; rules?: unknown; builtin?: unknown; sandboxed?: unknown }): RulePolicy {
	const profile = PROFILES.find((p) => p === value.profile) ?? "custom";
	const tools = Array.isArray(value.tools) ? value.tools.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 200).slice(0, 100) : [];
	return { profile, tools, rules: parseRules(value.rules), builtin: parseRules(value.builtin), ...(value.sandboxed === true ? { sandboxed: true } : {}) };
}

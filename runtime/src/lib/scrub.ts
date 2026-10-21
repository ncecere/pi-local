import { format } from "node:util";
import { defineExtension, type Extension, hook, type ToolExecutionResult, ToolTask, type ToolRegistration } from "@earendil-works/pi-durable";
import { isSecretKey, isSecretValue, type RedactMarks, redactText } from "./redact.ts";

/**
 * Secret scrubbing (docs/api.md, "Hiding secrets"): what a tool returns is cleaned before the model sees it and before
 * it is stored, so a credential a command printed or a server returned never reaches the model, the transcript or the
 * screen. Two kinds of value become `[redacted secret]`:
 *
 * - values that look like credentials, by the rules of the approvals view (`redactText`, redact.ts): token prefixes,
 *   Authorization values, JWTs, private keys, long random-looking strings, and the value of `password=`, `api_key:`
 *   and the like. A hash, a UUID, a long path or prose is left alone;
 * - the runtime's own secrets, found by value: its model key, its gateway key, and the env and header values of its MCP
 *   servers. They are never listed anywhere: not in a message, not in a log, not in a setting.
 *
 * Where: `afterTool` of the tool task (every tool's final result, nested calls too) and, for a tool still running, the
 * output, details and diagnostics it reports on the way (`protect`), so a streaming command never shows a token on
 * screen. Text parts only: images and other parts pass through untouched. Logs are scrubbed the same way
 * (`installLogScrubbing`), whatever the agent's switch says.
 */
export const REDACTED = "[redacted secret]";
export const SCRUB_EXTENSION = "pdp-scrub";

const MARKS: RedactMarks = { value: () => REDACTED, pem: REDACTED, bearer: REDACTED };

/** Variables of the runtime's own environment that hold a secret, besides any whose name says so. */
const SECRET_ENV = ["MODEL_API_KEY", "PLATFORM_KEY", "MODEL_USAGE_KEY", "MCP_KEY"];

/** An MCP server as far as secrets go (runtime mcp.ts, McpServerConfig). */
type ServerSecrets = { url?: string; headers?: Record<string, string>; env?: Record<string, string> };

/** Shorter values are not scrubbed by value: they would be everywhere (`1`, `true`, `info`). */
const MIN_SECRET = 6;

/**
 * The values to hide from one setting: all of it, from 6 characters, except what is plainly no credential (a flag, a
 * number, a path, a URL without a password, a media type: `true`, `8080`, `/usr/bin`, `application/json`). For a
 * setting whose name doesn't say whether it is a credential, see `settingSecrets`.
 */
export function secretsFrom(_name: string, value: unknown): string[] {
	if (typeof value !== "string") return [];
	const v = value.trim();
	if (v.length < MIN_SECRET || v === "no-key") return []; // "no-key" stands for a keyless local server
	const found = new Set<string>();
	const scheme = /^(bearer|basic|token)\s+(\S+)$/i.exec(v);
	if (scheme) found.add(scheme[2]!); // an Authorization header's value: the token alone shows up too
	const userinfo = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^@\s/]+)@/i.exec(v);
	if (userinfo) found.add(decodeURIComponentSafe(userinfo[1]!)).add(userinfo[1]!);
	if (userinfo || !noCredential(v)) found.add(v);
	return [...found].filter((x) => x.length >= MIN_SECRET);
}

/**
 * The values to hide from an MCP server's env or header setting, or a provider's extra header. The app keeps them all
 * in the keychain, but most are plain settings (`MODE=production`, `X-Org: acme`), and hiding those would corrupt tool
 * output wherever the word appears. So a value is hidden when its name says it's a credential (`API_KEY`,
 * `Authorization`), when it looks like one (a known token format, a JWT), or when it is long and random-looking (20+
 * characters mixing letters and digits, no spaces: a key or an ID whose name doesn't say so). A URL's password always.
 */
export function settingSecrets(name: string, value: unknown): string[] {
	if (typeof value !== "string") return [];
	const v = value.trim();
	if (isSecretKey(name) || isSecretValue(v) || tokenLike(v)) return secretsFrom(name, v);
	// Not itself a credential, but a URL may carry one (https://user:pass@host), and a header a scheme's token.
	return secretsFrom(name, v).filter((x) => x !== v);
}

function tokenLike(v: string): boolean {
	return v.length >= 20 && !/\s/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v) && !noCredential(v);
}

/** A value that is no credential for want of looking like one: a flag, a number, a path, a URL, a media type. */
function noCredential(v: string): boolean {
	if (/^(true|false|null|undefined)$/i.test(v)) return true;
	if (/^[0-9.:,_-]+$/.test(v)) return true;
	if (/^(?:[/~]|\.{1,2}\/|[A-Za-z]:[\\/])/.test(v)) return true;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return true;
	return /^[a-z-]+\/[a-z0-9.+-]+$/i.test(v);
}

function decodeURIComponentSafe(v: string): string {
	try {
		return decodeURIComponent(v);
	} catch {
		return v;
	}
}

/** What the secrets of an MCP server are: its env and header values, and what its URL carries (a password, a key). */
export function serverSecrets(server: ServerSecrets): string[] {
	const out: string[] = [];
	for (const [name, value] of Object.entries(server.env ?? {})) out.push(...settingSecrets(name, value));
	for (const [name, value] of Object.entries(server.headers ?? {})) out.push(...settingSecrets(name, value));
	if (typeof server.url === "string") {
		try {
			const url = new URL(server.url);
			if (url.password) out.push(...secretsFrom("password", decodeURIComponentSafe(url.password)));
			for (const [name, value] of url.searchParams) if (isSecretKey(name)) out.push(...secretsFrom(name, value));
		} catch {
			// not a URL: nothing in it to hide
		}
	}
	return out;
}

/** The secrets in a runtime's environment: its keys, anything named like a credential, and every value of its MCP servers. */
export function environmentSecrets(env: Record<string, string | undefined>): string[] {
	const out: string[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (name === "MCP_SERVERS" || name === "MODEL_HEADERS") continue;
		if (SECRET_ENV.includes(name) || isSecretKey(name)) out.push(...secretsFrom(name, value));
	}
	try {
		// The provider's extra request headers (MODEL_HEADERS, a JSON object) are credentials too.
		const headers = JSON.parse(env.MODEL_HEADERS || "{}") as unknown;
		if (headers && typeof headers === "object") for (const [name, value] of Object.entries(headers)) out.push(...settingSecrets(name, value));
	} catch {
		// not JSON: nothing to hide
	}
	try {
		const servers = JSON.parse(env.MCP_SERVERS || "[]") as unknown;
		if (Array.isArray(servers)) for (const server of servers) if (server && typeof server === "object") out.push(...serverSecrets(server as ServerSecrets));
	} catch {
		// MCP_SERVERS is checked where it is used
	}
	return out;
}

/** A value as it may appear in text: as is, JSON-escaped, URL-encoded. */
function variants(secret: string): string[] {
	const out = new Set([secret]);
	const json = JSON.stringify(secret).slice(1, -1);
	if (json !== secret) out.add(json);
	const encoded = encodeURIComponent(secret);
	if (encoded !== secret) out.add(encoded);
	return [...out];
}

type Part = { type: string; text?: string };

export class Scrubber {
	private fixed: string[];
	private cache: { key: string; list: string[] } = { key: "", list: [] };

	/**
	 * @param env the runtime's environment: its keys and its MCP servers' values are hidden by value.
	 * @param more secrets learned later (the servers apps give a thread): asked for at each scrub.
	 */
	constructor(env: Record<string, string | undefined>, private readonly more: () => readonly string[] = () => []) {
		this.fixed = environmentSecrets(env);
	}

	/** The values hidden by value, longest first (so a secret that holds another is hidden whole). */
	private secrets(): string[] {
		const all = [...this.fixed, ...this.more()];
		const key = all.join("\0");
		if (key !== this.cache.key) {
			const list = [...new Set(all.flatMap(variants))].sort((a, b) => b.length - a.length);
			this.cache = { key, list };
		}
		return this.cache.list;
	}

	/** Text with the runtime's own secrets and anything that looks like a credential hidden. */
	text(text: string): string {
		let out = text;
		for (const secret of this.secrets()) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
		return redactText(out, MARKS);
	}

	/** A JSON value with every string scrubbed, and the strings under a credential's name hidden whole. */
	value<T>(value: T, depth = 0): T {
		if (typeof value === "string") return this.text(value) as T;
		if (value === null || typeof value !== "object" || depth > 32) return value;
		if (Array.isArray(value)) return value.map((item) => this.value(item, depth + 1)) as T;
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = typeof item === "string" && isSecretKey(key) && item.trim() !== "" && !item.includes(REDACTED) ? REDACTED : this.value(item, depth + 1);
		}
		return out as T;
	}

	/** A tool result with its text, details, structured output and diagnostics scrubbed; other parts (images) as they are. */
	result(result: ToolExecutionResult): ToolExecutionResult {
		const next: Record<string, unknown> = { ...result };
		if (result.output !== undefined) {
			next.output = (result.output as readonly Part[]).map((part) => (part.type === "text" && typeof part.text === "string" ? { ...part, text: this.text(part.text) } : part));
		}
		if (result.details !== undefined) next.details = this.value(result.details);
		if (result.structuredOutput !== undefined) next.structuredOutput = this.value(result.structuredOutput);
		if (result.diagnostics !== undefined) next.diagnostics = result.diagnostics.map((d) => this.value(d));
		return next as ToolExecutionResult;
	}

	/** The library's extension: scrubs every tool's final result. Selected last, so it sees what other hooks settled on. */
	extension(): Extension {
		return defineExtension({
			name: SCRUB_EXTENSION,
			hooks: [hook(ToolTask, { afterTool: (_call, result) => this.result(result) })],
		});
	}

	/**
	 * An extension whose tools scrub what they report while they run (the output, details and diagnostics of a command
	 * still going). A secret split across two chunks is caught when the result settles (`extension`).
	 */
	protect(extension: Extension): Extension {
		if (extension.tools === undefined || extension.tools.length === 0) return extension;
		return { ...extension, tools: extension.tools.map((tool) => this.protectTool(tool)) };
	}

	private protectTool(tool: ToolRegistration): ToolRegistration {
		const execute = tool.execute;
		if (typeof execute !== "function") return tool;
		return {
			...tool,
			execute: (args: unknown, api: unknown, context: unknown) => (execute as (...a: unknown[]) => unknown).call(tool, args, this.reporting(api as object), context),
		} as ToolRegistration;
	}

	private reporting(api: object): object {
		return new Proxy(api, {
			get: (target, property) => {
				const value = Reflect.get(target, property, target) as unknown;
				if (typeof value !== "function") return value;
				const bound = (value as (...a: unknown[]) => unknown).bind(target);
				switch (property) {
					case "output":
						return (chunk: unknown, ...rest: unknown[]) => bound(typeof chunk === "string" ? this.text(chunk) : chunk, ...rest);
					case "details":
						return (details: unknown, ...rest: unknown[]) => bound(this.value(details), ...rest);
					case "diagnostic":
						return (diagnostic: unknown, ...rest: unknown[]) => bound(this.value(diagnostic), ...rest);
					default:
						return bound;
				}
			},
		});
	}
}

/** Whether the switch is on: `SCRUB_SECRETS` (the agent's `security.scrubSecrets`); on unless it says false. */
export function scrubEnabled(env: Record<string, string | undefined>): boolean {
	return !["false", "off", "0", "no"].includes((env.SCRUB_SECRETS ?? "").trim().toLowerCase());
}

type LogMethod = "log" | "info" | "warn" | "error" | "debug";
const LOG_METHODS: LogMethod[] = ["log", "info", "warn", "error", "debug"];

/**
 * Cleans what this process logs (`console.*`, which the app writes to the agent's logs): each call is formatted, then
 * scrubbed like a tool result. Always on: the agent's switch is for what its tools return. Returns an undo (tests).
 */
export function installLogScrubbing(env: Record<string, string | undefined>, target: Console = console, more?: () => readonly string[]): () => void {
	const scrubber = new Scrubber(env, more);
	const originals = new Map<LogMethod, (...args: unknown[]) => void>();
	for (const method of LOG_METHODS) {
		const original = target[method].bind(target) as (...args: unknown[]) => void;
		originals.set(method, target[method] as (...args: unknown[]) => void);
		target[method] = (...args: unknown[]) => original(scrubber.text(format(...args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : a)))));
	}
	return () => {
		for (const method of LOG_METHODS) target[method] = originals.get(method) as never;
	};
}

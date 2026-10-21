import { isAbsolute, resolve } from "node:path";
import type { SandboxPolicy, SandboxRules } from "./types.ts";

/**
 * What a command's output says about the sandbox: when it complains that something "is not permitted" (the error the
 * sandbox gives, EPERM), a line for the model that says so plainly, so it doesn't try the same thing again or conclude
 * the file is broken. Heuristic: only what the output shows, and only where the sandbox's rules agree.
 */

const MAX_SCANNED = 256 * 1024;
const MAX_PATHS = 3;

/** Collects what a command printed (bounded, the tail). */
export class OutputScan {
	private text = "";
	push(chunk: string): void {
		this.text += chunk;
		if (this.text.length > MAX_SCANNED * 2) this.text = this.text.slice(-MAX_SCANNED);
	}
	get value(): string {
		return this.text.slice(-MAX_SCANNED);
	}
}

/** Paths a "not permitted" message names, in the forms the usual tools print. */
function blockedPaths(text: string, workspace: string): string[] {
	const found: string[] = [];
	const add = (raw: string | undefined) => {
		const path = raw?.trim();
		if (!path || path.length > 500) return;
		const absolute = path.startsWith("~") ? undefined : isAbsolute(path) ? path : resolve(workspace, path);
		if (absolute !== undefined && !found.includes(absolute)) found.push(absolute);
	};
	for (const line of text.split("\n")) {
		if (!/operation not permitted|deny\(\d+\)/i.test(line)) continue;
		// `touch: /path: Operation not permitted`, `bash: /path: Operation not permitted`
		const colon = line.match(/(?:^|: )([^:\n]+): Operation not permitted/i);
		if (colon) add(colon[1]);
		// Python: `PermissionError: [Errno 1] Operation not permitted: '/path'`
		const python = line.match(/Operation not permitted: ['"]([^'"]+)['"]/i);
		if (python) add(python[1]);
		// Node: `EPERM: operation not permitted, open '/path'`
		const node = line.match(/operation not permitted,? \w+ ['"]([^'"]+)['"]/i);
		if (node) add(node[1]);
		// The system's own sandbox log line: `Sandbox: bash(1) deny(1) file-write-create /path`
		const log = line.match(/deny\(\d+\)\s+file-\S+\s+(\/\S.*)$/);
		if (log) add(log[1]);
	}
	return found;
}

/** Messages a refused connection gives. */
const NETWORK_FAILURE =
	/couldn'?t connect|could not connect|failed to connect|unable to connect|connection refused|network is unreachable|no route to host|could not resolve host|name or service not known|nodename nor servname|temporary failure in name resolution|getaddrinfo|ECONNREFUSED|ENETUNREACH|ENOTFOUND|connect.*operation not permitted|operation not permitted.*(?:sendto|connect|socket)|(?:sendto|connect)\b.*not permitted/i;

/**
 * The hint to add after a command's output, or undefined when the output shows nothing the sandbox did. `rules` is what
 * the sandbox allows (to say which of its walls a path hit).
 */
export function sandboxHint(output: string, policy: SandboxPolicy, rules: SandboxRules): string | undefined {
	const parts: string[] = [];
	const paths = blockedPaths(output, policy.workspace);
	const closed = paths.filter((p) => !rules.canRead(p) || !rules.canWrite(p));
	const unreadable = closed.filter((p) => !rules.canRead(p)).slice(0, MAX_PATHS);
	const unwritable = closed.filter((p) => rules.canRead(p)).slice(0, MAX_PATHS);
	if (unreadable.length > 0) {
		parts.push(`The sandbox blocked access to ${unreadable.join(", ")}: it keeps credentials and other agents' data private.`);
	}
	if (unwritable.length > 0) {
		parts.push(`The sandbox blocked writing outside the workspace: ${unwritable.join(", ")}. Commands can write in the workspace, its temp folder and /tmp.`);
	}
	if (!policy.network && NETWORK_FAILURE.test(output)) {
		parts.push("The network is off for this agent, so commands can't connect to anything (that may be why this failed).");
	}
	if (parts.length === 0 && paths.length === 0 && /operation not permitted/i.test(output)) {
		parts.push("This may be the sandbox: commands can only write in the workspace, its temp folder and /tmp.");
	}
	return parts.length === 0 ? undefined : parts.join(" ");
}

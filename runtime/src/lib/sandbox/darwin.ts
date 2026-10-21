import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SandboxPlatform, SandboxPolicy, SandboxRules, SandboxStatus } from "./types.ts";

/**
 * macOS: `sandbox-exec -p <profile> <command>`. The profile is generated per agent (`buildProfile`) from what its
 * policy says. `sandbox-exec` is deprecated in name only: it is the interface the system's own tools and every
 * well-known macOS sandboxing tool still use (Apple's `sandbox_init` underneath), and it is on every Mac.
 *
 * What a sandboxed command may do:
 *
 *  - Run processes, fork, signal its own children, use the system's services (mach lookups), sysctls, and so on:
 *    the profile starts from `(allow default)` and takes away.
 *  - Read anywhere, except the credential folders (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/Library/Keychains`) and the app's
 *    data folder outside this agent's own folder (other agents' conversations and files, the app's database). The
 *    folders leading to this agent's own can be looked at but not listed or read (tools that look for a project root
 *    by walking up from the workspace would fail on them otherwise).
 *    The keychain's system service (`securityd`) is not reachable either, or `security find-generic-password` would
 *    read keychain items without touching a closed file.
 *  - Write only: the workspace; the agent's temporary folder; the harmless devices (`/dev/null`, the terminal, `/dev/fd`);
 *    `/private/tmp` (many tools hard-code /tmp, and it is where `mktemp -t` and test runners go); and this user's own
 *    temporary and cache folders under `/private/var/folders/<xx>/<yyyy>/` (where macOS puts `$TMPDIR`; compilers and
 *    system tools write there without being asked). Not the rest of `/private/var/folders`, which holds other users'.
 *    Never the data folder outside the workspace and temporary folder, or the credential folders, wherever they are.
 *  - Use the network (both ways) unless the agent's network is off: then no connection to or from an IP address, and
 *    no listening sockets. Unix sockets (local services such as ssh-agent) still work.
 */

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** The folders under the home folder that hold credentials, closed to reading and writing. */
const CREDENTIAL_FOLDERS = ["Library/Keychains", ".ssh", ".gnupg", ".aws"];

/** Devices a command may write: the sinks, the terminal and pseudo-terminals, and the file descriptors' directory. */
const DEVICE_LITERALS = ["/dev/null", "/dev/zero", "/dev/dtracehelper", "/dev/tty", "/dev/ptmx", "/dev/stdout", "/dev/stderr", "/dev/random", "/dev/urandom"];
const DEVICE_REGEXES = ["^/dev/tty[A-Za-z0-9]*$", "^/dev/pty[A-Za-z0-9]*$", "^/dev/fd/[0-9]+$"];

/** Mach services of the keychain, closed (see above). TLS and code signing keep working without them. */
const KEYCHAIN_SERVICES = ["com.apple.SecurityServer", "com.apple.securityd", "com.apple.secd", "com.apple.security.agentd"];

/** The real path of `path`, even when it doesn't exist yet: its deepest existing ancestor's real path, plus the rest. */
export function realish(path: string): string {
	const missing: string[] = [];
	let current = resolve(path);
	for (;;) {
		try {
			return join(realpathSync(current), ...missing.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return join(current, ...missing.reverse());
			missing.push(basename(current));
			current = parent;
		}
	}
}

const within = (root: string, path: string) => {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

let userDirCache: string | null | undefined;

/**
 * This user's folder under /private/var/folders (`<xx>/<yyyy>`, the parent of $TMPDIR's `T`, the cache's `C` and `0`),
 * or none when it can't be told.
 */
export function userTempRoot(): string | undefined {
	if (userDirCache === undefined) {
		try {
			const temp = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 5000 }).trim();
			userDirCache = temp ? dirname(realish(temp.replace(/\/+$/, ""))) : null;
		} catch {
			userDirCache = null;
		}
	}
	return userDirCache ?? undefined;
}

/** The paths of a policy, as the real paths the sandbox matches. */
function resolved(policy: SandboxPolicy) {
	return {
		workspace: realish(policy.workspace),
		temp: realish(policy.tempDir),
		credentials: CREDENTIAL_FOLDERS.map((f) => realish(join(policy.home, f))),
		data: policy.dataDir ? realish(policy.dataDir) : undefined,
		agent: policy.agentDir ? realish(policy.agentDir) : undefined,
		userTemp: userTempRoot(),
	};
}

/** A string in SBPL: quoted, with backslashes and quotes escaped. */
function q(value: string): string {
	if (/[\0\n\r]/.test(value)) throw new Error("A sandbox path can't contain a line break or NUL");
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const sub = (paths: readonly string[]) => paths.map((p) => `(subpath ${q(p)})`).join(" ");

/**
 * The SBPL profile for a policy. Later rules win over earlier ones, so it reads from the general to the specific:
 * nothing writable, then what may be written, then the data folder closed again (it may sit under /tmp or the user's
 * temp folder, as in tests) with this agent's workspace and temporary folder let back in, then the credentials.
 */
export function buildProfile(policy: SandboxPolicy): string {
	const r = resolved(policy);
	const lines: string[] = ["(version 1)", "(allow default)", ""];

	lines.push(";; Writing: nowhere, except...");
	lines.push("(deny file-write*)");
	const writable = ["/private/tmp", ...(r.userTemp ? [r.userTemp] : [])];
	lines.push(
		`(allow file-write* ${DEVICE_LITERALS.map((d) => `(literal ${q(d)})`).join(" ")} ${DEVICE_REGEXES.map((d) => `(regex #${q(d)})`).join(" ")} ${sub(writable)})`,
	);
	lines.push("");

	if (r.data !== undefined) {
		lines.push(";; The app's data folder: other agents' files and the app's own are closed; this agent's folder is readable");
		lines.push(`(deny file-write* file-read* ${sub([r.data])})`);
		if (r.agent !== undefined) {
			lines.push(`(allow file-read* ${sub([r.agent])})`);
			// The folders on the way to this agent's folder can be looked at (stat), not listed or read: tools that walk up
			// from the workspace to find a project root (git, node, cargo) fail with an error otherwise.
			const ancestors: string[] = [];
			for (let dir = dirname(r.agent); within(r.data, dir) && !ancestors.includes(dir); dir = dirname(dir)) ancestors.push(dir);
			ancestors.reverse();
			if (ancestors.length > 0) lines.push(`(allow file-read-metadata ${ancestors.map((a) => `(literal ${q(a)})`).join(" ")})`);
		}
		lines.push("");
	}

	lines.push(";; The workspace and the temporary folder: read and write");
	lines.push(`(allow file-write* file-read* ${sub([r.workspace, r.temp])})`);
	lines.push("");

	lines.push(";; Credentials: closed, wherever else they might have been let in");
	lines.push(`(deny file-read* file-write* ${sub(r.credentials)})`);
	lines.push(`(deny mach-lookup ${KEYCHAIN_SERVICES.map((s) => `(global-name ${q(s)})`).join(" ")})`);

	if (!policy.network) {
		lines.push("");
		lines.push(";; The network is off for this agent");
		lines.push("(deny network-outbound (remote ip))");
		lines.push("(deny network-inbound)");
		lines.push("(deny network-bind)");
	}
	return `${lines.join("\n")}\n`;
}

function rulesOf(policy: SandboxPolicy): SandboxRules {
	const r = resolved(policy);
	const anyWithin = (roots: readonly string[], p: string) => roots.some((root) => within(root, p));
	const abs = (p: string) => realish(isAbsolute(p) ? p : resolve(policy.workspace, p));
	return {
		canRead(path) {
			const p = abs(path);
			if (anyWithin(r.credentials, p)) return false;
			if (anyWithin([r.workspace, r.temp], p)) return true;
			if (r.data !== undefined && within(r.data, p)) return r.agent !== undefined && within(r.agent, p);
			return true;
		},
		canWrite(path) {
			const p = abs(path);
			if (anyWithin(r.credentials, p)) return false;
			if (anyWithin([r.workspace, r.temp], p)) return true;
			if (r.data !== undefined && within(r.data, p)) return false;
			if (p.startsWith("/dev/")) return true;
			return anyWithin(["/private/tmp", ...(r.userTemp ? [r.userTemp] : [])], p);
		},
	};
}

export const darwinSandbox: SandboxPlatform = {
	id: "darwin",
	check(): SandboxStatus {
		if (existsSync(SANDBOX_EXEC)) return { ok: true };
		return {
			ok: false,
			reason: `The shell sandbox needs ${SANDBOX_EXEC}, which isn't on this computer. Turn it off for this agent (Tools, "Run commands in a sandbox") to run commands without it.`,
		};
	},
	wrap: (argv, policy) => [SANDBOX_EXEC, "-p", buildProfile(policy), ...argv],
	rules: rulesOf,
};

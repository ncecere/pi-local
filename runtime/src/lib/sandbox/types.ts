/**
 * The shell sandbox's platform interface. A platform turns a command line into one that runs confined by a
 * `SandboxPolicy`: macOS with `sandbox-exec` (darwin.ts). Linux (bubblewrap) and Windows (AppContainer) have the stubs
 * in unavailable.ts until their backends land; adding one means implementing `SandboxPlatform` and choosing it in
 * index.ts, nothing else.
 */

/** What the sandbox lets a command do. Paths are absolute. */
export type SandboxPolicy = {
	/** The agent's workspace folder: its commands may write here. */
	workspace: string;
	/** The agent's temporary folder: writable too (it is the commands' TMPDIR). */
	tempDir: string;
	/** The person's home folder: its credential folders (.ssh, .aws, .gnupg, Keychains) are closed. */
	home: string;
	/** The app's data folder, closed to commands except for `agentDir` (this agent's own folder, readable, not writable). */
	dataDir?: string;
	agentDir?: string;
	/** Whether commands may use the network. */
	network: boolean;
};

export type SandboxStatus = { ok: true } | { ok: false; reason: string };

/** Where a command may read and write under a policy: what the hints use to say what was blocked. */
export interface SandboxRules {
	canRead(path: string): boolean;
	canWrite(path: string): boolean;
}

export interface SandboxPlatform {
	/** The OS it is for (`process.platform`). */
	readonly id: string;
	/** Whether the mechanism is on this computer (cheap: no process started). */
	check(): SandboxStatus;
	/** The program and arguments that run `argv` confined by `policy`. */
	wrap(argv: readonly string[], policy: SandboxPolicy): string[];
	/** What `policy` allows, for explaining a refusal. */
	rules(policy: SandboxPolicy): SandboxRules;
}

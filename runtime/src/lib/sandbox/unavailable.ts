import type { SandboxPlatform } from "./types.ts";

/**
 * A platform without a sandbox (yet): says so, and wraps nothing. The shell then refuses to run while the agent's
 * sandbox is on: it never runs unsandboxed silently.
 */
export function unavailableSandbox(id: string, osName: string): SandboxPlatform {
	return {
		id,
		check: () => ({
			ok: false,
			reason: `The shell sandbox is not available on ${osName} yet. Turn it off for this agent (Tools, "Run commands in a sandbox") to run commands without it.`,
		}),
		wrap: () => {
			throw new Error(`The shell sandbox is not available on ${osName} yet`);
		},
		rules: () => ({ canRead: () => true, canWrite: () => true }),
	};
}

import { execFile } from "node:child_process";
import type { Context } from "@earendil-works/chord/context";
import { err, type ExecutionEnv, ExecutionError } from "@earendil-works/pi-durable/env";
import { darwinSandbox } from "./darwin.ts";
import { OutputScan, sandboxHint } from "./hints.ts";
import { linuxSandbox } from "./linux.ts";
import type { SandboxPlatform, SandboxPolicy, SandboxStatus } from "./types.ts";
import { unavailableSandbox } from "./unavailable.ts";
import { win32Sandbox } from "./win32.ts";

export type { SandboxPlatform, SandboxPolicy, SandboxRules, SandboxStatus } from "./types.ts";
export { buildProfile } from "./darwin.ts";

/** The sandbox for an OS (`process.platform`). Anything else is reported as not available. */
export function sandboxFor(platform: string = process.platform): SandboxPlatform {
	switch (platform) {
		case "darwin":
			return darwinSandbox;
		case "linux":
			return linuxSandbox;
		case "win32":
			return win32Sandbox;
		default:
			return unavailableSandbox(platform, platform);
	}
}

/** Starts a harmless program inside the sandbox: whether it really starts (it can't inside another sandbox, for one). */
function probe(platform: SandboxPlatform, policy: SandboxPolicy): Promise<SandboxStatus> {
	const status = platform.check();
	if (!status.ok) return Promise.resolve(status);
	let argv: string[];
	try {
		argv = platform.wrap(["/usr/bin/true"], policy);
	} catch (error) {
		return Promise.resolve({ ok: false, reason: `The shell sandbox could not be set up: ${(error as Error).message}` });
	}
	return new Promise((resolve) => {
		execFile(argv[0]!, argv.slice(1), { timeout: 10_000, encoding: "utf8" }, (error, _stdout, stderr) => {
			if (!error) return resolve({ ok: true });
			const why = stderr.trim() || error.message;
			resolve({
				ok: false,
				reason: `The shell sandbox could not start (${why}). Pi Local may be running inside another sandbox. Turn the sandbox off for this agent (Tools, "Run commands in a sandbox") to run commands without it.`,
			});
		});
	});
}

export type SandboxedShellOptions = {
	platform?: SandboxPlatform;
	policy: SandboxPolicy;
	/** The program that runs a command line given as one string (default /bin/bash -c). */
	shell?: readonly string[];
	/** Variables for the commands: where tools that cache under the home folder (closed to writing) may cache instead. */
	env?: Record<string, string>;
};

/**
 * `exec` for an environment whose commands run in the sandbox: the same arguments and results as the environment's own,
 * through the platform's wrapper. When the sandbox can't be used (no mechanism on this OS, or it doesn't start) the
 * command is refused with the reason, never run without it. A command whose output shows the sandbox in the way gets a
 * line saying so after its output.
 */
export function sandboxedExec(base: Pick<ExecutionEnv, "exec">, options: SandboxedShellOptions): ExecutionEnv["exec"] {
	const platform = options.platform ?? sandboxFor();
	const shell = options.shell ?? ["/bin/bash", "-c"];
	const rules = platform.check().ok ? platform.rules(options.policy) : undefined;
	let started: Promise<SandboxStatus> | undefined;
	return async (command, execOptions, context: Context) => {
		started ??= probe(platform, options.policy);
		const status = await started;
		if (!status.ok) {
			started = undefined; // looked at again next time
			return err(new ExecutionError("shell_unavailable", status.reason));
		}
		const argv = typeof command === "string" ? [...shell, command] : command;
		const scan = new OutputScan();
		const original = execOptions?.onOutput;
		const result = await base.exec(
			platform.wrap(argv, options.policy),
			{
				...execOptions,
				env: { ...options.env, ...execOptions?.env },
				onOutput: (text, ctx, info) => {
					scan.push(text);
					original?.(text, ctx, info);
				},
			},
			context,
		);
		if (rules !== undefined && !context.abortSignal?.aborted) {
			const execution = result.ok ? { command: typeof command === "string" ? command : command.join(" "), exitCode: result.value.exitCode } : undefined;
			const hint = sandboxHint(scan.value, options.policy, rules, execution);
			if (hint !== undefined) original?.(`\n${hint}\n`, context, { stream: "stderr" } as never);
		}
		return result;
	};
}

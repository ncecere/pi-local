import { mkdirSync, realpathSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { err, type ExecutionEnv, FileError, ok } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

/** The workspace tools an agent may have (WORKSPACE_TOOLS, comma-separated). */
export const WORKSPACE_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;
export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

/** Variables a workspace `bash` passes on from the runtime's own environment; everything else (keys!) stays out. */
const SHELL_ENV_KEEP = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ"];

/** File operations and which of their arguments are paths. Anything not listed passes through untouched. */
const PATH_ARGS: Record<string, number[]> = {
	openTextLineReader: [0],
	readTextFile: [0],
	readTextLines: [0],
	readBinaryFile: [0],
	openBinaryReader: [0],
	writeFile: [0],
	appendFile: [0],
	truncateFile: [0],
	flushFile: [0],
	renameFile: [0, 1],
	fileInfo: [0],
	listDir: [0],
	listFiles: [0],
	openDirReader: [0],
	canonicalPath: [0],
	exists: [0],
	createDir: [0],
	remove: [0],
};

export type WorkspaceEnvOptions = {
	/** The folder the agent's tools may touch. Created when missing. */
	root: string;
	/** A private directory for temporary files (bash output that spills, temp files). Created when missing. */
	tempDir: string;
	/** The runtime's environment, filtered to SHELL_ENV_KEEP for `bash`. */
	processEnv?: NodeJS.ProcessEnv;
};

/**
 * NodeExecutionEnv with its temporary files in the agent's own directory instead of the system's. A subclass, not a
 * wrapper, so the environment's own calls (bash spilling long output to a file) land there too, inside what the
 * agent's `read` may open.
 */
class AgentTempEnv extends NodeExecutionEnv {
	constructor(
		options: ConstructorParameters<typeof NodeExecutionEnv>[0],
		private readonly tempRoot: string,
	) {
		super(options);
	}

	override async createTempDir(prefix: string | undefined, context: Context) {
		if (context.abortSignal?.aborted) return err<string, FileError>(new FileError("aborted", "Aborted"));
		try {
			return ok<string, FileError>(await mkdtemp(join(this.tempRoot, prefix ?? "tmp-")));
		} catch (error) {
			return err<string, FileError>(new FileError("unknown", (error as Error).message, this.tempRoot));
		}
	}
}

/**
 * The real path of `path`, even when it doesn't exist yet: the real path of its deepest existing ancestor plus the
 * rest, so a symlink anywhere on the way is followed before deciding where a path really is.
 */
async function realPathOf(path: string): Promise<string> {
	const missing: string[] = [];
	let current = path;
	for (;;) {
		try {
			return join(await realpath(current), ...missing.reverse());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
			const parent = dirname(current);
			if (parent === current) return join(current, ...missing.reverse());
			missing.push(basename(current));
			current = parent;
		}
	}
}

const inside = (root: string, path: string) => {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

/**
 * An ExecutionEnv whose file operations stay inside the workspace (and the agent's temp directory). Every path is
 * resolved against the workspace, symlinks followed, and refused with `permission_denied` when it lands outside, for
 * read, write, edit and anything else that uses the environment's files. `bash` runs in the workspace with a minimal
 * environment, but a shell can reach anything the person can: it is not confined, which is why it asks for approval
 * by default (the app's policy). Not a sandbox against code the agent runs; a guard against the model's file tools
 * wandering off, including through prompt injection.
 */
export function createWorkspaceEnv(options: WorkspaceEnvOptions): ExecutionEnv {
	mkdirSync(options.root, { recursive: true });
	mkdirSync(options.tempDir, { recursive: true });
	const roots = [realpathSync(options.root), realpathSync(options.tempDir)];
	const processEnv = options.processEnv ?? process.env;
	const shellEnv: NodeJS.ProcessEnv = { TMPDIR: roots[1] };
	for (const key of SHELL_ENV_KEEP) if (processEnv[key] !== undefined && key !== "TMPDIR") shellEnv[key] = processEnv[key];
	const base = new AgentTempEnv({ cwd: roots[0]!, shellEnv }, roots[1]!);

	const check = async (path: unknown): Promise<FileError | undefined> => {
		if (typeof path !== "string") return new FileError("invalid", "A path must be a string");
		if (path.includes("\0")) return new FileError("invalid", "A path cannot contain a NUL character", path);
		const absolute = isAbsolute(path) ? resolve(path) : resolve(roots[0]!, path);
		let real: string;
		try {
			real = await realPathOf(absolute);
		} catch (error) {
			return new FileError("permission_denied", `Cannot resolve ${path}: ${(error as Error).message}`, path);
		}
		if (roots.some((root) => inside(root, real))) return undefined;
		return new FileError("permission_denied", `${path} is outside the agent's workspace (${roots[0]}); only files inside it can be used`, path);
	};

	const guarded: Record<string, unknown> = {};
	for (const [method, positions] of Object.entries(PATH_ARGS)) {
		guarded[method] = async (...args: unknown[]) => {
			for (const i of positions) {
				const problem = await check(args[i]);
				if (problem) return err(problem);
			}
			return (base as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(base, args);
		};
	}
	guarded.watch = async (targets: readonly { path: string }[], onChange: unknown, context: Context) => {
		for (const target of targets) {
			const problem = await check(target.path);
			if (problem) return err(problem);
		}
		return base.watch(targets as never, onChange as never, context);
	};

	return new Proxy(base, {
		get(target, property, receiver) {
			if (typeof property === "string" && property in guarded) return guarded[property];
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as ExecutionEnv;
}

/** The workspace tools an agent was given, as an extension (`workspace`), or undefined for none. */
export function workspaceExtension(tools: readonly WorkspaceToolName[]): Extension | undefined {
	if (tools.length === 0) return undefined;
	const make: Record<WorkspaceToolName, () => unknown> = {
		read: () => createReadTool(),
		write: () => createWriteTool(),
		edit: () => createEditTool(),
		bash: () => createBashTool(),
	};
	return defineExtension({ name: "workspace", tools: tools.map((name) => make[name]()) as never });
}

/** WORKSPACE_TOOLS: a comma-separated subset of read, write, edit, bash. An unknown name is a misconfiguration. */
export function parseWorkspaceTools(raw: string | undefined): WorkspaceToolName[] {
	if (!raw?.trim()) return [];
	const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
	for (const name of names) {
		if (!(WORKSPACE_TOOL_NAMES as readonly string[]).includes(name)) throw new Error(`Unknown workspace tool "${name}" in WORKSPACE_TOOLS`);
	}
	return [...new Set(names)] as WorkspaceToolName[];
}

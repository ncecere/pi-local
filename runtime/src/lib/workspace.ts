import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { mkdir, mkdtemp, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { err, type ExecutionEnv, FileError, ok } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { DocumentError, documentKindOf, documentToMarkdown, MAX_DOCUMENT_BYTES } from "./documents.ts";
import { imageProcessor } from "./images.ts";
import { type SandboxPlatform, sandboxedExec } from "./sandbox/index.ts";

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
	/**
	 * Run `bash` (every command the environment executes) in the OS sandbox (lib/sandbox): reads anywhere but the
	 * credential folders and the app's data folder outside this agent's own, writes only the workspace and temporary
	 * folders (and /tmp), the network on or off. Absent: commands run unconfined, as the person's own shell would.
	 */
	sandbox?: WorkspaceSandbox;
};

export type WorkspaceSandbox = {
	/** Whether commands may use the network. */
	network: boolean;
	/** The app's data folder and this agent's folder in it (the rest of the data folder is closed to commands). */
	dataDir?: string;
	agentDir?: string;
	/** The person's home folder (default: the runtime's HOME). */
	home?: string;
	/** The OS's sandbox (default: the running OS's). For tests. */
	platform?: SandboxPlatform;
};

/**
 * The sandbox settings in the runtime's environment: `WORKSPACE_SANDBOX=on` turns it on, `WORKSPACE_SANDBOX_NETWORK=off`
 * closes the network, `WORKSPACE_SANDBOX_DATA_DIR` and `WORKSPACE_SANDBOX_AGENT_DIR` name the app's data folder and this
 * agent's folder. None when the sandbox is off.
 */
export function parseSandboxEnv(env: Record<string, string | undefined>): WorkspaceSandbox | undefined {
	if (env.WORKSPACE_SANDBOX !== "on") return undefined;
	return {
		network: env.WORKSPACE_SANDBOX_NETWORK !== "off",
		...(env.WORKSPACE_SANDBOX_DATA_DIR ? { dataDir: env.WORKSPACE_SANDBOX_DATA_DIR } : {}),
		...(env.WORKSPACE_SANDBOX_AGENT_DIR ? { agentDir: env.WORKSPACE_SANDBOX_AGENT_DIR } : {}),
	};
}

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
 * read, write, edit and anything else that uses the environment's files. A guard against the model's file tools
 * wandering off, including through prompt injection.
 *
 * `bash` runs in the workspace, and without `options.sandbox` a shell can reach anything the person can, which is why
 * it asks for approval by default (the app's policy). With it, every command runs in the OS sandbox (lib/sandbox) and
 * is refused when the sandbox can't be used: never run without it silently.
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
	// pi's bash asks to inherit the process's environment, which is the runtime's: its model key, its gateway key, its
	// MCP servers' secrets. A command gets only the filtered environment (SHELL_ENV_KEEP, TMPDIR) and what the call adds;
	// the sandbox, when on, wraps this.
	const plainExec = ((command: string, opts: Record<string, unknown> | undefined, context: Context) =>
		base.exec(
			command,
			{ ...(opts ?? {}), inheritEnv: false, env: { ...(shellEnv as Record<string, string>), ...((opts?.env as Record<string, string> | undefined) ?? {}) } } as never,
			context,
		)) as typeof base.exec;
	guarded.exec = plainExec;
	if (options.sandbox) {
		const sb = options.sandbox;
		const cache = join(roots[1]!, "cache");
		guarded.exec = sandboxedExec(
			{ exec: plainExec },
			{
				platform: sb.platform,
				policy: {
					workspace: roots[0]!,
					tempDir: roots[1]!,
					home: sb.home ?? processEnv.HOME ?? homedir(),
					dataDir: sb.dataDir,
					agentDir: sb.agentDir,
					network: sb.network,
				},
				// Package managers and compilers cache under the home folder, which is closed to writing: they cache in the
				// agent's temporary folder instead.
				env: { XDG_CACHE_HOME: cache, GOCACHE: join(cache, "go-build"), npm_config_cache: join(cache, "npm"), PIP_CACHE_DIR: join(cache, "pip") },
			},
		);
	}
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

export type WorkspaceExtensionOptions = {
	/** Where `read` keeps PDF and Office files it converted to text (in the agent's temp directory). */
	convertedDir?: string;
};

/** The workspace tools an agent was given, as an extension (`workspace`), or undefined for none. */
export function workspaceExtension(tools: readonly WorkspaceToolName[], options: WorkspaceExtensionOptions = {}): Extension | undefined {
	if (tools.length === 0) return undefined;
	const make: Record<WorkspaceToolName, () => unknown> = {
		read: () => createDocumentReadTool(options.convertedDir),
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

/**
 * pi's `read` (text files, and images, resized to fit the model), which also reads PDF, Word, Excel and PowerPoint
 * files: converted to Markdown once (kept in `convertedDir` by the file's path, size and time), then read like a text
 * file, with the same offset, limit and truncation. Without `convertedDir` (no temp directory) they are converted
 * into the environment's own temp directory each time.
 */
export function createDocumentReadTool(convertedDir?: string) {
	const inner = createReadTool({ images: imageProcessor });
	const execute = inner.execute.bind(inner) as (args: ReadArgs, api: ToolExecutionApi, context: Context) => Promise<ToolResult>;
	return {
		...inner,
		description: `${inner.description} Also reads PDF, Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files, as text.`,
		execute: async (args: ReadArgs, api: ToolExecutionApi, context: Context) => {
			const kind = documentKindOf(args.path);
			if (kind === undefined || api.env === undefined) return execute(args, api, context);
			const env = api.env;
			const info = await env.fileInfo(args.path, context);
			if (!info.ok) return execute(args, api, context); // the read tool says why (missing, outside the workspace)
			if (info.value.size > MAX_DOCUMENT_BYTES) return errorResult(`${args.path} is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB, too large to read`);
			const key = createHash("sha256").update(`${info.value.path}\0${info.value.size}\0${info.value.mtimeMs}`).digest("hex").slice(0, 24);
			let dir = convertedDir;
			if (dir === undefined) {
				const temp = await env.createTempDir("converted-", context);
				if (!temp.ok) return errorResult(`${args.path} could not be converted: ${temp.error.message}`);
				dir = temp.value;
			}
			const converted = join(dir, `${key}.md`);
			if (!existsSync(converted)) {
				const bytes = await env.readBinaryFile(args.path, context);
				if (!bytes.ok) return execute(args, api, context);
				let markdown: string;
				try {
					markdown = await documentToMarkdown(bytes.value, kind, basename(args.path));
				} catch (error) {
					return errorResult(error instanceof DocumentError ? `${error.message}.` : `${args.path} could not be read: ${(error as Error).message}`);
				}
				await mkdir(dir, { recursive: true });
				const tmp = `${converted}.${process.pid}.tmp`;
				await writeFile(tmp, markdown, { mode: 0o600 });
				await rename(tmp, converted);
			}
			const result = await execute({ ...args, path: converted }, api, context);
			// Its notes (truncation, "use offset=…") name the converted copy: the agent should go on with the original.
			return {
				...result,
				output: result.output.map((part) => (part.type === "text" && typeof part.text === "string" ? { ...part, text: part.text.split(converted).join(args.path) } : part)),
			};
		},
	};
}

type ReadArgs = { path: string; offset?: number; limit?: number };
type ToolResult = { output: { type: string; text?: string }[]; isError?: boolean; details?: unknown } & Record<string, unknown>;

function errorResult(text: string): ToolResult {
	return { output: [{ type: "text", text }], isError: true };
}

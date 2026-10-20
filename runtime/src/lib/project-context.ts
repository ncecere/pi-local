// A project's own instructions for coding agents, found the way the pi coding agent finds them
// (@earendil-works/pi-coding-agent's resource-loader.js): AGENTS.md or CLAUDE.md, one per folder.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The context files pi reads, in the order it prefers them within one folder. */
const CONTEXT_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const MAX_CONTEXT_FILE = 32 * 1024;
const MAX_CONTEXT_TOTAL = 96 * 1024;

function contextFileIn(dir: string): { path: string; content: string } | undefined {
	for (const name of CONTEXT_CANDIDATES) {
		const path = join(dir, name);
		try {
			if (!statSync(path).isFile()) continue;
			let content = readFileSync(path, "utf8");
			if (content.length > MAX_CONTEXT_FILE) content = `${content.slice(0, MAX_CONTEXT_FILE)}\n\n[… cut: the file is longer than ${MAX_CONTEXT_FILE / 1024} KiB]`;
			return { path, content };
		} catch {
			// Not there, or unreadable: the next candidate.
		}
	}
	return undefined;
}

/**
 * The project's instruction files: one per folder from the repository's root (the nearest folder above with .git) down
 * to the workspace, outermost first, as pi does. Never above the home folder, never more than 96 KiB in all.
 */
export function projectContextFiles(workspace: string): { path: string; content: string }[] {
	const home = homedir();
	const dirs: string[] = [];
	let dir = resolve(workspace);
	for (;;) {
		dirs.push(dir);
		if (existsSync(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir || dir === home || !parent.startsWith(home)) break;
		dir = parent;
	}
	const files: { path: string; content: string }[] = [];
	let total = 0;
	for (const d of dirs.reverse()) {
		const file = contextFileIn(d);
		if (file === undefined || total + file.content.length > MAX_CONTEXT_TOTAL) continue;
		total += file.content.length;
		files.push(file);
	}
	return files;
}


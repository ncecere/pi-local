import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type Extension, section, Type } from "./facade.ts";

/**
 * Skills (SKILL_DIRS): folders with a `SKILL.md` (pi's format: YAML front matter with `name` and `description`, then
 * instructions) that tell the agent how to do something specific.
 *
 *  - Every turn, a prompt section lists the enabled skills: name, description and where SKILL.md is. Read from disk
 *    each time, so a skill added or edited while the agent is awake shows up on the next message.
 *  - The `skill` tool returns a skill's SKILL.md (with the folder it lives in) or another file of its folder. It is the
 *    way to read a skill: the agent may have no `read` tool, and a skill's folder is outside its workspace (a shared
 *    skill is in the app's data folder), which the workspace tools never reach. Only files inside the skill's own
 *    folder can be read, symlinks followed.
 *
 * The app tells the runtime where skills are: SKILL_DIRS is a JSON array of `{root, names?}`, a folder holding skill
 * folders and, optionally, which of them are enabled (an agent's own skills have no `names`: all are; shared ones list
 * the ones the agent picked). The first source with a skill of a given name wins.
 */

export const SKILLS_EXTENSION = "pdp-skills";

export type SkillSource = { root: string; names?: string[] };

export type Skill = {
	/** The folder's name: how the agent and the app refer to the skill. */
	name: string;
	description: string;
	/** The skill's folder (absolute). */
	dir: string;
	/** Its SKILL.md (absolute). */
	file: string;
};

export const SKILL_FILE = "SKILL.md";
/** Skill names: lowercase letters, digits and dashes, as pi's skills (also what the app accepts). */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILLS = 100;
const MAX_DESCRIPTION = 1024;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_LISTED_FILES = 60;
const FRONT_MATTER_BYTES = 16 * 1024;

/** SKILL_DIRS: a JSON array of sources. A malformed value is a misconfiguration. */
export function parseSkillSources(raw: string | undefined): SkillSource[] {
	if (!raw?.trim()) return [];
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("SKILL_DIRS is not valid JSON");
	}
	if (!Array.isArray(value)) throw new Error("SKILL_DIRS must be a JSON array");
	return value.map((item, i) => {
		const entry = item as { root?: unknown; names?: unknown };
		if (typeof entry?.root !== "string" || !isAbsolute(entry.root)) throw new Error(`SKILL_DIRS[${i}] needs an absolute "root"`);
		if (entry.names !== undefined && (!Array.isArray(entry.names) || entry.names.some((n) => typeof n !== "string"))) {
			throw new Error(`SKILL_DIRS[${i}].names must be a list of names`);
		}
		return { root: entry.root, ...(entry.names ? { names: entry.names as string[] } : {}) };
	});
}

/**
 * The front matter of a Markdown file and the rest. Reads what skills use: `key: value` lines (plain, quoted, or a
 * `>` / `|` block), the value continuing on indented lines. Without front matter: no data and the whole text.
 */
export function parseFrontMatter(text: string): { data: Record<string, string>; body: string } {
	const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	if (!source.startsWith("---\n")) return { data: {}, body: source };
	const end = /^---[ \t]*(?:\n|$)/m.exec(source.slice(4));
	if (!end) return { data: {}, body: source };
	const head = source.slice(4, 4 + end.index);
	const body = source.slice(4 + end.index + end[0].length);
	const data: Record<string, string> = {};
	let key: string | undefined;
	let style = "";
	let parts: string[] = [];
	const finish = () => {
		if (key === undefined) return;
		let value = style.startsWith("|") ? parts.join("\n") : parts.join(" ");
		value = value.trim();
		if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
			const quote = value[0]!;
			value = value.slice(1, -1);
			value = quote === '"' ? value.replace(/\\(["\\])/g, "$1") : value.replace(/''/g, "'");
		}
		data[key] = value;
		key = undefined;
	};
	for (const line of head.split("\n")) {
		if (line.trimStart().startsWith("#")) continue;
		const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
		if (m && !/^\s/.test(line)) {
			finish();
			key = m[1]!;
			const rest = m[2]!;
			if (/^[>|][+-]?$/.test(rest.trim())) {
				style = rest.trim();
				parts = [];
			} else {
				style = "";
				parts = rest === "" ? [] : [rest];
			}
		} else if (key !== undefined && line.trim() !== "" && /^[ \t]/.test(line)) {
			parts.push(line.trim());
		}
	}
	finish();
	return { data, body };
}

async function readHead(path: string): Promise<string | undefined> {
	let handle;
	try {
		handle = await open(path, "r");
		const buffer = Buffer.alloc(FRONT_MATTER_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => {});
	}
}

/**
 * The skills in the sources, in order: a folder with a SKILL.md that has a description (a skill without one can't be
 * told to the model, so it is left out), named by its folder. A name another source already gave is skipped.
 */
export async function listSkills(sources: readonly SkillSource[]): Promise<Skill[]> {
	const found = new Map<string, Skill>();
	for (const source of sources) {
		let entries: string[];
		if (source.names) {
			entries = source.names.filter((n) => SKILL_NAME.test(n));
		} else {
			try {
				entries = (await readdir(source.root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
			} catch {
				continue;
			}
		}
		for (const name of entries.sort()) {
			if (found.has(name) || name.length > 64 || !SKILL_NAME.test(name)) continue;
			const dir = join(source.root, name);
			if (!(await lstat(dir).catch(() => undefined))?.isDirectory()) continue;
			const file = join(dir, SKILL_FILE);
			const realDir = await realpath(dir).catch(() => undefined);
			const realFile = await realpath(file).catch(() => undefined);
			if (!realDir || !realFile || !inside(realDir, realFile)) continue;
			const info = await stat(realFile).catch(() => undefined);
			if (!info?.isFile() || info.size > 256 * 1024) continue;
			const head = await readHead(realFile);
			if (head === undefined) continue;
			const data = parseFrontMatter(head).data;
			const description = data.description?.trim();
			if (!description || [...description].length > MAX_DESCRIPTION || data.name?.trim() !== name) continue;
			found.set(name, { name, description: description.slice(0, MAX_DESCRIPTION), dir, file });
		}
	}
	return [...found.values()].slice(0, MAX_SKILLS);
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The prompt's list of skills (undefined: none). */
export function skillsPrompt(skills: readonly Skill[]): string | undefined {
	if (skills.length === 0) return undefined;
	const lines = [
		"You have skills: folders of instructions for specific tasks. When a task matches a skill's description, call the `skill` tool with its name before you start, and follow what it says. Paths inside a skill are relative to its folder (the tool says where that is, and `skill` with a `file` reads any other file in it).",
		"",
		"<available_skills>",
	];
	for (const skill of skills) {
		lines.push(
			"  <skill>",
			`    <name>${escapeXml(skill.name)}</name>`,
			`    <description>${escapeXml(skill.description)}</description>`,
			`    <location>${escapeXml(skill.file)}</location>`,
			"  </skill>",
		);
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

function text(value: string, isError = false) {
	return { output: [{ type: "text" as const, text: value }], ...(isError ? { isError: true } : {}) };
}

/** Files of a skill's folder, relative, shallow first (at most `limit`), without hidden ones. */
async function filesOf(dir: string, limit: number): Promise<{ files: string[]; more: boolean }> {
	const files: string[] = [];
	const queue = [""];
	let more = false;
	let visited = 0;
	while (queue.length > 0) {
		if (++visited > 1000) return { files, more: true };
		const rel = queue.shift()!;
		let entries;
		try {
			entries = await readdir(join(dir, rel), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (e.name.startsWith(".")) continue;
			const path = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) queue.push(path);
			else if (e.isFile() && path !== SKILL_FILE) {
				if (files.length >= limit) return { files, more: true };
				files.push(path);
			}
		}
	}
	return { files, more };
}

export type SkillsOptions = { sources: readonly SkillSource[] };

export function skillsExtension(options: SkillsOptions): Extension {
	const skills = () => listSkills(options.sources);
	return defineExtension({
		name: SKILLS_EXTENSION,
		sections: [section("skills", async () => skillsPrompt(await skills()))],
		tools: [
			defineTool({
				name: "skill",
				description:
					"Read one of your skills (instructions for a specific task, listed in available_skills). With just a name it returns the skill's SKILL.md and the folder it is in; with `file` (a path relative to that folder) it returns another file of the skill.",
				parameters: Type.Object({
					name: Type.String({ description: "The skill's name, as listed." }),
					file: Type.Optional(Type.String({ description: "A file in the skill's folder, relative to it (for example references/forms.md). Leave out for SKILL.md." })),
				}),
				replay: "safe",
				execute: async (args, _api, _ctx: Context) => {
					const all = await skills();
					const skill = all.find((s) => s.name === args.name);
					if (!skill) {
						return text(`There is no skill "${args.name}".${all.length ? ` Your skills: ${all.map((s) => s.name).join(", ")}.` : " You have no skills."}`, true);
					}
					return readSkillFile(skill, args.file || SKILL_FILE);
				},
			}),
		],
	});
}

function inside(dir: string, file: string): boolean {
	const rel = relative(dir, file);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function readSkillFile(skill: Skill, file: string) {
	if (file.includes("\0")) return text("A path can't contain a NUL character.", true);
	if (isAbsolute(file)) return text(`Give the file's path relative to the skill's folder, not ${file}.`, true);
	if (file.includes("\\") || file.split("/").includes("..")) return text(`${file} is outside the skill's folder; only its own files can be read.`, true);
	let dir: string;
	let real: string;
	try {
		dir = await realpath(skill.dir);
		real = await realpath(resolve(dir, file));
	} catch {
		return text(`${file} isn't in the skill "${skill.name}".`, true);
	}
	const rel = relative(dir, real);
	if (!inside(dir, real)) return text(`${file} is outside the skill's folder; only its own files can be read.`, true);
	const info = await stat(real).catch(() => undefined);
	if (!info?.isFile()) return text(`${file} isn't a file in the skill "${skill.name}".`, true);
	const handle = await open(real, "r");
	try {
		const buffer = Buffer.alloc(Math.min(info.size, MAX_FILE_BYTES));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const data = buffer.subarray(0, bytesRead);
		if (data.subarray(0, 8192).includes(0)) return text(`${file} is a binary file (${info.size} bytes). Run it or open it from the shell if you need it: ${join(skill.dir, file)}`);
		const note = info.size > MAX_FILE_BYTES ? `\n\n[Shown the first ${MAX_FILE_BYTES / 1024} KB of ${Math.round(info.size / 1024)} KB.]` : "";
		if (file === SKILL_FILE) {
			const { body } = parseFrontMatter(data.toString("utf8"));
			const { files, more } = await filesOf(dir, MAX_LISTED_FILES);
			const out = [`Skill: ${skill.name}`, `Folder: ${skill.dir} (paths in the skill are relative to it)`, "", body.trim() + note];
			if (files.length > 0) out.push("", `Other files in this skill (read with skill name="${skill.name}" file=...):`, ...files.map((f) => `- ${f}`), ...(more ? ["- …"] : []));
			return text(out.join("\n"));
		}
		return text(`${basename(skill.dir)}/${rel.split(sep).join("/")}:\n\n${data.toString("utf8")}${note}`);
	} finally {
		await handle.close().catch(() => {});
	}
}

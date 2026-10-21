import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc } from "@earendil-works/pi-durable";
import { answer, startTestAgent, toolCall } from "@pdp/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { listSkills, SKILLS_EXTENSION, parseFrontMatter, parseSkillSources, skillsPrompt } from "../src/lib/skills.ts";
import { tempAgentDir } from "./support.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

/** The system prompt a model request carried. */
const systemOf = (context: { messages: { role: string }[] }) => JSON.stringify(context.messages.filter((m) => m.role === "system"));

function skill(root: string, name: string, front: string, body = "Do the thing.\n", files: Record<string, string> = {}) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\n${front}\n---\n\n${body}`);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	return dir;
}

describe("skill front matter", () => {
	it("reads plain, quoted and block values, and the body after", () => {
		const { data, body } = parseFrontMatter(
			['---', 'name: pdf-tools', 'description: "Fill and merge PDFs: forms, \\"merge\\""', "metadata: ignored", "---", "", "# Body", "text"].join("\n"),
		);
		expect(data.name).toBe("pdf-tools");
		expect(data.description).toBe('Fill and merge PDFs: forms, "merge"');
		expect(body.trim()).toBe("# Body\ntext");
		expect(parseFrontMatter("---\nname: a\ndescription: >\n  one line\n  continued\n---\nbody").data.description).toBe("one line continued");
		expect(parseFrontMatter("---\nname: a\ndescription: |\n  first\n  second\n---\nbody").data.description).toBe("first\nsecond");
		expect(parseFrontMatter("---\r\nname: a\r\ndescription: crlf\r\n---\r\nbody").data.description).toBe("crlf");
		expect(parseFrontMatter("description: 'it''s fine'\n").data).toEqual({});
		expect(parseFrontMatter("# no front matter\n").body).toBe("# no front matter\n");
		expect(parseFrontMatter("---\nunterminated: yes\n").data).toEqual({});
		expect(parseFrontMatter("---\nname: a\n# explanation\n---not-a-delimiter\ndescription: |+\n  first\n  second\n---   \nbody")).toEqual({
			data: { name: "a", description: "first\nsecond" }, body: "body",
		});
	});
});

describe("SKILL_DIRS", () => {
	it("is a JSON array of absolute roots with optional names", () => {
		expect(parseSkillSources(undefined)).toEqual([]);
		expect(parseSkillSources("")).toEqual([]);
		expect(parseSkillSources('[{"root":"/a"},{"root":"/b","names":["x"]}]')).toEqual([{ root: "/a" }, { root: "/b", names: ["x"] }]);
		expect(() => parseSkillSources("nope")).toThrow(/not valid JSON/);
		expect(() => parseSkillSources("{}")).toThrow(/array/);
		expect(() => parseSkillSources('[{"root":"relative"}]')).toThrow(/absolute/);
		expect(() => parseSkillSources('[{"root":"/a","names":[1]}]')).toThrow(/names/);
	});
});

describe("listing skills", () => {
	it("lists folders with a described SKILL.md, own sources first, shared ones only by name", async () => {
		const own = await tempAgentDir(cleanup);
		const shared = await tempAgentDir(cleanup);
		skill(own, "alpha", "name: alpha\ndescription: Own alpha.");
		skill(own, "no-description", "name: no-description");
		skill(own, "Bad_Name", "name: x\ndescription: Not a valid folder name.");
		mkdirSync(join(own, "empty"));
		skill(shared, "alpha", "name: alpha\ndescription: Shared alpha (loses).");
		skill(shared, "beta", "name: beta\ndescription: Shared beta.");
		skill(shared, "gamma", "name: gamma\ndescription: Not enabled.");
		const skills = await listSkills([{ root: own }, { root: shared, names: ["alpha", "beta", "missing", "../escape"] }]);
		expect(skills.map((s) => [s.name, s.description])).toEqual([
			["alpha", "Own alpha."],
			["beta", "Shared beta."],
		]);
		expect(skills[0]!.file).toBe(join(own, "alpha", "SKILL.md"));
		expect(await listSkills([{ root: join(own, "nowhere") }])).toEqual([]);
	});

	it("rejects missing or mismatched names and symlink escapes, including SKILL.md itself", async () => {
		const root = await tempAgentDir(cleanup);
		const outside = await tempAgentDir(cleanup);
		skill(outside, "secret", "name: secret\ndescription: Outside instructions.");
		skill(root, "no-name", "description: Missing name.");
		skill(root, "wrong-name", "name: other\ndescription: Wrong name.");
		symlinkSync(join(outside, "secret"), join(root, "linked-folder"));
		mkdirSync(join(root, "linked-file"));
		symlinkSync(join(outside, "secret", "SKILL.md"), join(root, "linked-file", "SKILL.md"));
		expect(await listSkills([{ root }])).toEqual([]);
		expect(await listSkills([{ root, names: ["linked-folder", "linked-file"] }])).toEqual([]);
	});

	it("writes the prompt with name, description and location, escaped; nothing without skills", () => {
		expect(skillsPrompt([])).toBeUndefined();
		const text = skillsPrompt([{ name: "a", description: 'Use for <b> & "c"', dir: "/s/a", file: "/s/a/SKILL.md" }])!;
		expect(text).toContain("<name>a</name>");
		expect(text).toContain("<description>Use for &lt;b&gt; &amp; &quot;c&quot;</description>");
		expect(text).toContain("<location>/s/a/SKILL.md</location>");
		expect(text).toContain("`skill` tool");
	});
});

describe("an agent with skills", () => {
	async function agentWith(sources: unknown) {
		const agent = await startTestAgent(undefined, { env: { SKILL_DIRS: JSON.stringify(sources) } });
		cleanup.push(() => agent.close());
		return agent;
	}
	const promptsSeen = (agent: Awaited<ReturnType<typeof startTestAgent>>, seen: string[]) =>
		agent.model.reply((context) => {
			seen.push(systemOf(context));
			return answer("ok");
		});
	const toolResults = async (agent: Awaited<ReturnType<typeof startTestAgent>>, thread: string) => (await agent.settled(thread)).messages.filter((m) => m.role === "tool");

	it("lists its skills in the system prompt, and sees one added while it runs", async () => {
		const root = await tempAgentDir(cleanup);
		skill(root, "release-notes", "name: release-notes\ndescription: Write release notes from a changelog.");
		const agent = await agentWith([{ root }]);
		const seen: string[] = [];
		promptsSeen(agent, seen);
		await agent.send("t1", "hi");
		await agent.settled("t1");
		expect(seen[0]).toContain("<available_skills>");
		expect(seen[0]).toContain("<name>release-notes</name>");
		expect(seen[0]).toContain("Write release notes from a changelog.");
		expect(seen[0]).toContain(join(root, "release-notes", "SKILL.md"));
		expect(seen[0]).not.toContain("<name>second</name>");

		skill(root, "second", "name: second\ndescription: A skill added later.");
		promptsSeen(agent, seen);
		await agent.send("t1", "again");
		await agent.settled("t1", { messages: 4 });
		expect(seen[1]).toContain("<name>second</name>");
	}, 20_000);

	it("has no skills section or tool without SKILL_DIRS", async () => {
		const agent = await startTestAgent();
		cleanup.push(() => agent.close());
		const seen: string[] = [];
		agent.model.reply((context) => {
			seen.push(systemOf(context));
			return answer("ok");
		});
		await agent.send("t1", "hi");
		await agent.settled("t1");
		expect(seen[0]).not.toContain("available_skills");
		const conversation = (await agent.agent.threads.get("t1"))!;
		expect((await agent.harness.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT))?.extensions).not.toContain(SKILLS_EXTENSION);
	}, 20_000);

	it("reads a skill's SKILL.md, its other files, and nothing outside the folder", async () => {
		const root = await tempAgentDir(cleanup);
		const outside = await tempAgentDir(cleanup);
		writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
		const dir = skill(root, "forms", "name: forms\ndescription: Fill forms.", "Step one: read references/fields.md.\n", {
			"references/fields.md": "Field list",
			"scripts/run.sh": "echo hi",
		});
		writeFileSync(join(dir, "blob.bin"), Buffer.from([1, 2, 0, 3]));
		writeFileSync(join(dir, "large.txt"), "x".repeat(210 * 1024));
		symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
		symlinkSync(outside, join(dir, "linkdir"));
		skill(root, "other", "name: other\ndescription: Another.", "Other skill body\n");
		const agent = await agentWith([{ root }]);
		agent.model.reply(
			toolCall("skill", { name: "forms" }, { id: "c1" }),
			toolCall("skill", { name: "forms", file: "references/fields.md" }, { id: "c2" }),
			toolCall("skill", { name: "forms", file: "../other/SKILL.md" }, { id: "c3" }),
			toolCall("skill", { name: "forms", file: "link.txt" }, { id: "c4" }),
			toolCall("skill", { name: "forms", file: "linkdir/secret.txt" }, { id: "c5" }),
			toolCall("skill", { name: "forms", file: join(outside, "secret.txt") }, { id: "c6" }),
			toolCall("skill", { name: "forms", file: "blob.bin" }, { id: "c7" }),
			toolCall("skill", { name: "nope" }, { id: "c8" }),
			toolCall("skill", { name: "forms", file: "large.txt" }, { id: "c9" }),
			answer("done"),
		);
		await agent.send("t1", "go");
		const [main, file, up, link, linkdir, absolute, binary, unknown, large] = await toolResults(agent, "t1");
		expect(main?.isError).toBeFalsy();
		expect(main?.text).toContain(`Folder: ${dir}`);
		expect(main?.text).toContain("Step one: read references/fields.md.");
		expect(main?.text).not.toContain("description: Fill forms"); // the front matter is not repeated
		expect(main?.text).toContain("- references/fields.md");
		expect(main?.text).toContain("- scripts/run.sh");
		expect(file?.text).toContain("Field list");
		for (const refused of [up, link, linkdir, absolute]) {
			expect(refused?.isError).toBe(true);
			expect(refused?.text).not.toContain("TOP SECRET");
			expect(refused?.text).not.toContain("Other skill body");
		}
		expect(binary?.text).toContain("binary file");
		expect(unknown?.isError).toBe(true);
		expect(unknown?.text).toContain("Your skills: forms, other");
		expect(large?.isError).toBeFalsy();
		// The harness may apply its own tighter output limit after the skill's 200 KB bound.
		expect(large?.text).toMatch(/Shown the first 200 KB|Output truncated/);
		expect(large!.text.length).toBeLessThan(201 * 1024);
	}, 30_000);
});

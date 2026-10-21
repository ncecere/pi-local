import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractFile, runExtract } from "../src/lib/extract.ts";
import { docx, pdf, pptx, xlsx } from "./fixtures/documents.ts";
import { tempAgentDir } from "./support.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

async function folder() {
	const dir = await tempAgentDir(cleanup);
	writeFileSync(join(dir, "notes.md"), "# Notes\n\nPlain **Markdown** stays as it is.\n");
	writeFileSync(join(dir, "plain.txt"), "Just text, with ünïcode.\n");
	writeFileSync(join(dir, "report.docx"), docx());
	writeFileSync(join(dir, "budget.xlsx"), xlsx());
	writeFileSync(join(dir, "deck.pptx"), pptx());
	writeFileSync(join(dir, "paper.pdf"), pdf(["Hello from page one", "And page two"]));
	writeFileSync(join(dir, "broken.pdf"), "this is not a pdf");
	writeFileSync(join(dir, "binary.dat"), Buffer.from([1, 2, 0, 3, 4]));
	mkdirSync(join(dir, "sub"));
	return dir;
}

/** The extract mode with in-memory streams. */
async function run(args: string[], stdin = "") {
	let out = "";
	let err = "";
	const code = await runExtract(args, {
		stdin: async () => stdin,
		stdout: async (text) => {
			out += text;
		},
		stderr: async (text) => {
			err += text;
		},
	});
	return { code, out, err };
}

describe("extract mode", () => {
	it("prints a document as Markdown, page by page, sheet by sheet, slide by slide", async () => {
		const dir = await folder();
		const paper = await run([join(dir, "paper.pdf")]);
		expect(paper.code).toBe(0);
		expect(paper.out).toMatch(/## Page 1\n\nHello from page one/);
		expect(paper.out).toMatch(/## Page 2\n\nAnd page two/);
		expect((await run([join(dir, "budget.xlsx")])).out).toContain("## Sheet: Budget");
		expect((await run([join(dir, "deck.pptx")])).out).toContain("## Slide 2");
		expect((await run([join(dir, "report.docx")])).out).toContain("Sales grew 12%");
	});

	it("reads any other text file as it is, and refuses binary files", async () => {
		const dir = await folder();
		expect((await run([join(dir, "notes.md")])).out).toBe("# Notes\n\nPlain **Markdown** stays as it is.\n");
		expect((await run([join(dir, "plain.txt")])).out).toContain("ünïcode");
		const binary = await run([join(dir, "binary.dat")]);
		expect(binary.code).toBe(1);
		expect(binary.err).toContain("not a text file");
	});

	it("says why a file can't be read, and exits 1", async () => {
		const dir = await folder();
		const broken = await run([join(dir, "broken.pdf")]);
		expect(broken.code).toBe(1);
		expect(broken.err).toMatch(/broken\.pdf could not be read as a PDF/);
		expect((await run([join(dir, "missing.pdf")])).err).toContain("could not be found");
		expect((await run([join(dir, "sub")])).err).toContain("is not a file");
		expect((await run([])).code).toBe(2);
	});

	it("reads many files from stdin, one JSON line each, and a bad file doesn't stop the rest", async () => {
		const dir = await folder();
		const paths = ["notes.md", "broken.pdf", "paper.pdf", "missing.docx", "report.docx"].map((name) => join(dir, name));
		const { code, out } = await run(["--batch"], `${paths.join("\n")}\n\n`);
		expect(code).toBe(0);
		const lines = out.trim().split("\n").map((line) => JSON.parse(line) as { path: string; markdown?: string; error?: string });
		expect(lines.map((l) => l.path)).toEqual(paths);
		expect(lines[0]!.markdown).toContain("Plain **Markdown**");
		expect(lines[1]!.error).toMatch(/broken\.pdf could not be read as a PDF/);
		expect(lines[2]!.markdown).toContain("## Page 2");
		expect(lines[3]!.error).toContain("could not be found");
		expect(lines[4]!.markdown).toContain("Sales grew 12%");
	});

	it("extractFile throws a plain message", async () => {
		const dir = await folder();
		await expect(extractFile(join(dir, "broken.pdf"))).rejects.toThrow(/could not be read as a PDF/);
	});

	it("runs as the runtime process: --extract and --extract --batch (what the app calls)", async () => {
		const dir = await folder();
		const main = join(import.meta.dirname, "..", "src", "main.ts");
		const exec = (args: string[], input?: string) =>
			new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
				const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", main, ...args], { cwd: join(import.meta.dirname, "..") });
				let out = "";
				let err = "";
				child.stdout.on("data", (d) => {
					out += d;
				});
				child.stderr.on("data", (d) => {
					err += d;
				});
				child.on("close", (code) => resolve({ code, out, err }));
				child.stdin.end(input ?? "");
			});
		const single = await exec(["--extract", join(dir, "paper.pdf")]);
		expect(single.code).toBe(0);
		expect(single.out).toContain("## Page 1");
		const batch = await exec(["--extract", "--batch"], `${join(dir, "notes.md")}\n${join(dir, "deck.pptx")}\n`);
		expect(batch.code).toBe(0);
		expect(batch.out.trim().split("\n")).toHaveLength(2);
		expect(batch.out).toContain("## Slide 1");
	}, 60_000);
});

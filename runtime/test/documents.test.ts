import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { err, FileError } from "@earendil-works/pi-durable/env";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentError, documentKindOf, documentToMarkdown } from "../src/lib/documents.ts";
import { createDocumentReadTool, createWorkspaceEnv } from "../src/lib/workspace.ts";
import { docx, pdf, png, pptx, xlsx } from "./fixtures/documents.ts";

describe("documents as Markdown", () => {
	it("knows the kinds by extension", () => {
		expect(documentKindOf("a/Report.PDF")).toBe("pdf");
		expect(documentKindOf("x.docx")).toBe("docx");
		expect(documentKindOf("x.doc")).toBeUndefined();
		expect(documentKindOf("notes")).toBeUndefined();
	});

	it("reads a Word document: headings, lists, tables; not deleted text, field codes or tab stops", async () => {
		const md = await documentToMarkdown(docx(), "docx", "report.docx");
		expect(md).toContain("(Word document, as text)");
		expect(md).toContain("## Quarterly report");
		expect(md).toContain("## Summary\n");
		expect(md).toContain("Sales grew 12% & costs fell.");
		expect(md).toContain("- First point");
		expect(md).toContain("| Region | Total |\n| --- | --- |\n| North \\| East | 40 |");
		expect(md).not.toContain("removed text");
		expect(md).not.toContain("PAGE");
		expect(md).not.toContain("\t");
	});

	it("reads an Excel workbook: each sheet a table, shared and inline strings, booleans", async () => {
		const md = await documentToMarkdown(xlsx(), "xlsx", "budget.xlsx");
		expect(md).toContain("## Sheet: Budget\n\n| Item | Cost | Paid |\n| --- | --- | --- |\n| Rent (office) | 1200.5 | TRUE |\n| Power |  | FALSE |");
		expect(md).toContain("## Sheet: Empty\n\n(empty)");
	});

	it("reads a presentation in slide order, with speaker notes", async () => {
		const md = await documentToMarkdown(pptx(), "pptx", "deck.pptx");
		expect(md.indexOf("Welcome")).toBeLessThan(md.indexOf("Later slide"));
		expect(md).toContain("## Slide 1\n\n**Welcome**\n- Opening point\n\nNotes: Say hello first.");
		expect(md).toContain("## Slide 2\n\n**Later slide**\n- Second in order");
	});

	it("reads a PDF page by page, and says when a PDF has no text", async () => {
		const md = await documentToMarkdown(pdf(["Hello from page one", "And page two"]), "pdf", "paper.pdf");
		expect(md).toContain("(PDF, 2 pages, as text)");
		expect(md).toMatch(/## Page 1\n\nHello from page one/);
		expect(md).toMatch(/## Page 2\n\nAnd page two/);
		const scanned = await documentToMarkdown(pdf([""]), "pdf", "scan.pdf");
		expect(scanned).toContain("no text layer");
	});

	it("refuses what isn't the document it claims, and zip bombs", async () => {
		await expect(documentToMarkdown(strToU8("not a zip"), "docx", "fake.docx")).rejects.toBeInstanceOf(DocumentError);
		await expect(documentToMarkdown(strToU8("not a pdf"), "pdf", "fake.pdf")).rejects.toBeInstanceOf(DocumentError);
		await expect(documentToMarkdown(zipSync({ "other.xml": strToU8("<x/>") }), "docx", "empty.docx")).rejects.toThrow(/no document part/);
		// 400 MB of zeros compresses to a few hundred KB.
		const bomb = zipSync({ "word/document.xml": new Uint8Array(400 * 1024 * 1024) }, { level: 9 });
		await expect(documentToMarkdown(bomb, "docx", "bomb.docx")).rejects.toThrow(/unpacks to more than/);
	}, 60_000);
});

describe("read, for documents", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const setup = (reuseCache = true) => {
		const base = mkdtempSync(join(tmpdir(), "docread-"));
		dirs.push(base);
		const root = join(base, "workspace");
		const temp = join(base, "tmp");
		const env = createWorkspaceEnv({ root, tempDir: temp });
		writeFileSync(join(root, "report.docx"), docx());
		writeFileSync(join(root, "notes.txt"), "plain text\n");
		const convertedDir = join(temp, "converted");
		const tool = createDocumentReadTool(reuseCache ? convertedDir : undefined);
		const run = (args: { path: string; offset?: number; limit?: number }, executionEnv = env) =>
			tool.execute(args, { env: executionEnv, agent: async () => ({}), models: { getModel: () => undefined } } as never, {} as never) as Promise<{ output: { type: string; text?: string }[]; isError?: boolean }>;
		const cachePath = async () => {
			const info = await env.fileInfo("report.docx", {} as never);
			if (!info.ok) throw info.error;
			const key = createHash("sha256").update(`${info.value.path}\0${info.value.size}\0${info.value.mtimeMs}`).digest("hex").slice(0, 24);
			return join(convertedDir, `${key}.md`);
		};
		return { base, root, temp, convertedDir, cachePath, env, run };
	};
	const text = (r: { output: { type: string; text?: string }[] }) => r.output.map((p) => p.text ?? "").join("\n");

	it("reads a Word file as text, pages through it with offset, and names the original in its notes", async () => {
		const { temp, run } = setup();
		const first = await run({ path: "report.docx", limit: 3 });
		expect(first.isError).toBeFalsy();
		expect(text(first)).toContain("# report.docx");
		expect(text(first)).toContain("report.docx");
		expect(text(first)).not.toContain(temp);
		const later = await run({ path: "report.docx", offset: 5 });
		expect(text(later)).toContain("Quarterly report");
		expect(text(later)).not.toContain("# report.docx");
	});

	it("refuses a preexisting cache-directory symlink before writing Markdown outside the roots", async () => {
		const { base, convertedDir, run } = setup();
		const outside = join(base, "outside");
		mkdirSync(outside);
		symlinkSync(outside, convertedDir);
		const result = await run({ path: "report.docx" }).catch((error: Error) => error);
		expect(readdirSync(outside)).toEqual([]);
		if (result instanceof Error) throw result; // failures must be returned as clear tool errors, not thrown
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("could not be converted");
		expect(text(result)).toContain("outside the agent's workspace");
	});

	it("refuses a dangling cache-tempfile symlink before it creates an outside target", async () => {
		const { base, convertedDir, cachePath, run } = setup();
		const outside = join(base, "outside");
		mkdirSync(outside);
		mkdirSync(convertedDir);
		const converted = await cachePath();
		const tmp = `${converted}.${process.pid}.tmp`;
		symlinkSync(join(outside, "new.md"), tmp);
		const result = await run({ path: "report.docx" }).catch((error: Error) => error);
		expect(readdirSync(outside)).toEqual([]);
		if (result instanceof Error) throw result;
		expect(result.isError).toBe(true);
		expect(lstatSync(tmp).isSymbolicLink()).toBe(true);
		expect(existsSync(converted)).toBe(false);
		expect(text(result)).toContain("could not be converted");
		expect(text(result)).toContain("Unresolved symbolic link");
	});

	it("reuses a contained conversion and supports a contained cache-directory symlink", async () => {
		const { temp, convertedDir, cachePath, run } = setup();
		const contained = join(temp, "actual-cache");
		mkdirSync(contained);
		symlinkSync(contained, convertedDir);
		expect((await run({ path: "report.docx" })).isError).toBeFalsy();
		const converted = await cachePath();
		expect(readFileSync(converted, "utf8")).toContain("Quarterly report");
		writeFileSync(converted, "cached conversion sentinel\n");
		const reused = await run({ path: "report.docx" });
		expect(reused.isError).toBeFalsy();
		expect(text(reused)).toContain("cached conversion sentinel");
		expect(readdirSync(contained)).toEqual([basename(converted)]);
	});

	it("without convertedDir, still creates fresh private conversion directories in the environment's temp root", async () => {
		const { temp, run } = setup(false);
		for (let i = 0; i < 2; i++) {
			const result = await run({ path: "report.docx" });
			expect(result.isError).toBeFalsy();
			expect(text(result)).toContain("Quarterly report");
		}
		const convertedDirs = readdirSync(temp);
		expect(convertedDirs).toHaveLength(2);
		for (const dir of convertedDirs) {
			expect(dir).toMatch(/^converted-/);
			expect(readdirSync(join(temp, dir))).toHaveLength(1);
		}
	});

	it.each(["exists", "createDir", "writeFile", "renameFile"])("returns a clear tool error if cache %s fails", async (method) => {
		const { env, run } = setup();
		const failing = new Proxy(env, {
			get(target, property) {
				if (property === method) return async () => err(new FileError("permission_denied", `cache ${method} refused`));
				return Reflect.get(target, property);
			},
		});
		const result = await run({ path: "report.docx" }, failing);
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(`report.docx could not be converted: cache ${method} refused`);
	});

	it("leaves other files to pi's read, and says when a document can't be read", async () => {
		const { root, run } = setup();
		expect(text(await run({ path: "notes.txt" }))).toContain("plain text");
		writeFileSync(join(root, "broken.xlsx"), "nope");
		const broken = await run({ path: "broken.xlsx" });
		expect(broken.isError).toBe(true);
		expect(text(broken)).toMatch(/could not be opened/);
		const missing = await run({ path: "missing.pdf" }).catch((error: Error) => ({ output: [{ type: "text", text: error.message }], isError: true }));
		expect(missing.isError).toBe(true);
		const outside = await run({ path: "../outside.pdf" }).catch((error: Error) => ({ output: [{ type: "text", text: error.message }], isError: true }));
		expect(text(outside)).toMatch(/outside|not found|No such|ENOENT/i);
	});

	it("resizes an image too large for the model instead of refusing it", async () => {
		const { root, run } = setup();
		writeFileSync(join(root, "wide.png"), png(3000, 200));
		const result = (await run({ path: "wide.png" })) as { output: { type: string; text?: string; mimeType?: string }[]; isError?: boolean };
		expect(result.isError).toBeFalsy();
		const image = result.output.find((p) => p.type === "image") as { data?: string } | undefined;
		expect(image?.data?.length).toBeGreaterThan(100);
		expect(JSON.stringify(result)).toMatch(/Resized from 3000x200 to 2000x133/);
	}, 30_000);
});

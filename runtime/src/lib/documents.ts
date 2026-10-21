import { type Unzipped, unzipSync } from "fflate";

/**
 * PDF, Word, Excel and PowerPoint files as Markdown, for the `read` tool: text, headings, lists and tables, page by
 * page, sheet by sheet, slide by slide (with speaker notes). Not a layout-faithful rendering: what a model needs to
 * read the content. A scanned PDF has no text; it says so.
 */

export type DocumentKind = "pdf" | "docx" | "xlsx" | "pptx";

const KINDS: Record<string, DocumentKind> = { ".pdf": "pdf", ".docx": "docx", ".xlsx": "xlsx", ".pptx": "pptx" };
const LABELS: Record<DocumentKind, string> = { pdf: "PDF", docx: "Word document", xlsx: "Excel workbook", pptx: "PowerPoint presentation" };

/** The kind of document a path names (by its extension), or undefined for any other file. */
export function documentKindOf(path: string): DocumentKind | undefined {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? undefined : KINDS[path.slice(dot).toLowerCase()];
}

/** Bigger files are refused (a document this size is rarely text a model should read whole). */
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
/** What an Office file may unpack to: more is a zip bomb, or not worth reading. */
const MAX_UNPACKED_BYTES = 300 * 1024 * 1024;
/** Rows of one sheet; the rest is counted. */
const MAX_SHEET_ROWS = 5000;
const MAX_SHEET_COLUMNS = 100;

export class DocumentError extends Error {}

/** The document as Markdown, with a line saying what it was. */
export async function documentToMarkdown(bytes: Uint8Array, kind: DocumentKind, name: string): Promise<string> {
	if (bytes.length > MAX_DOCUMENT_BYTES) throw new DocumentError(`${name} is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`);
	switch (kind) {
		case "pdf":
			return pdfToMarkdown(bytes, name);
		case "docx":
			return `# ${name}\n\n(${LABELS.docx}, as text)\n\n${docxToMarkdown(unpack(bytes, name, (f) => f === "word/document.xml"))}`;
		case "xlsx":
			return `# ${name}\n\n(${LABELS.xlsx}, as tables)\n\n${xlsxToMarkdown(unpack(bytes, name, (f) => f.startsWith("xl/")))}`;
		case "pptx":
			return `# ${name}\n\n(${LABELS.pptx}, as text)\n\n${pptxToMarkdown(unpack(bytes, name, (f) => f.startsWith("ppt/")))}`;
	}
}

async function pdfToMarkdown(bytes: Uint8Array, name: string): Promise<string> {
	const { extractText, getDocumentProxy } = await import("unpdf");
	let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
	try {
		pdf = await getDocumentProxy(new Uint8Array(bytes));
	} catch (error) {
		const message = (error as Error).message ?? "";
		if (/password/i.test(message)) throw new DocumentError(`${name} is protected by a password`);
		throw new DocumentError(`${name} could not be read as a PDF (${message || "damaged?"})`);
	}
	try {
		const { totalPages, text } = await extractText(pdf, { mergePages: false });
		const pages = text.map((page) => tidy(page));
		const words = pages.join(" ").trim();
		const head = `# ${name}\n\n(${LABELS.pdf}, ${totalPages} page${totalPages === 1 ? "" : "s"}, as text)\n\n`;
		if (words === "") return `${head}This PDF has no text layer: it is probably scanned images. Its text can't be read this way.\n`;
		return head + pages.map((page, i) => `## Page ${i + 1}\n\n${page || "(no text on this page)"}\n`).join("\n");
	} finally {
		// Frees pdf.js's worker-side state (typed loosely: unpdf's declaration leaves it out).
		await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => {});
	}
}

/** pdf.js text: runs of spaces collapsed, at most one blank line in a row. */
function tidy(text: string): string {
	return text
		.replace(/[ \t]+\n/g, "\n")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function unpack(bytes: Uint8Array, name: string, want: (file: string) => boolean): Unzipped {
	let total = 0;
	try {
		return unzipSync(bytes, {
			filter: (file) => {
				if (!want(file.name)) return false;
				total += file.originalSize;
				if (total > MAX_UNPACKED_BYTES) throw new DocumentError(`${name} unpacks to more than ${MAX_UNPACKED_BYTES / 1024 / 1024} MB`);
				return true;
			},
		});
	} catch (error) {
		if (error instanceof DocumentError) throw error;
		throw new DocumentError(`${name} could not be opened (not an Office file, or damaged)`);
	}
}

const decoder = new TextDecoder();
const xml = (files: Unzipped, path: string): string | undefined => (files[path] ? decoder.decode(files[path]) : undefined);

// ——— A small XML walker: enough for Office's XML, no DTDs, no namespaces resolved (prefixes are kept). ———

type XmlEvent = { type: "open" | "close" | "empty"; name: string; attrs: string } | { type: "text"; text: string };

function* events(source: string): Generator<XmlEvent> {
	const pattern = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/g;
	for (let m = pattern.exec(source); m !== null; m = pattern.exec(source)) {
		if (m[2] !== undefined) {
			if (m[1] === "/") yield { type: "close", name: m[2], attrs: "" };
			else yield { type: m[4] === "/" ? "empty" : "open", name: m[2], attrs: m[3] ?? "" };
		} else if (m[5] !== undefined) {
			yield { type: "text", text: m[5] };
		} else if (m[6] !== undefined) {
			yield { type: "text", text: decodeEntities(m[6]) };
		}
	}
}

function attr(attrs: string, name: string): string | undefined {
	const m = new RegExp(`(?:^|\\s)${name.replace(/[.:]/g, "\\$&")}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
	return m ? decodeEntities(m[2] ?? m[3] ?? "") : undefined;
}

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
		if (e === "amp") return "&";
		if (e === "lt") return "<";
		if (e === "gt") return ">";
		if (e === "quot") return '"';
		if (e === "apos") return "'";
		const code = e.startsWith("#x") ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
		return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
	});
}

const cell = (text: string) => text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();

function markdownTable(rows: string[][]): string {
	const width = Math.max(1, ...rows.map((r) => r.length));
	const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i] ?? "")).join(" | ")} |`;
	const [head, ...body] = rows;
	return [line(head ?? []), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
}

// ——— Word ———

function docxToMarkdown(files: Unzipped): string {
	const source = xml(files, "word/document.xml");
	if (source === undefined) throw new DocumentError("This Word file has no document part");
	const out: string[] = [];
	const stack: string[] = [];
	// Tables, possibly nested: rows of cells of text.
	const tables: { rows: string[][]; row: string[] | null; cell: string[] | null }[] = [];
	let para: { text: string; heading: number; list: boolean } | null = null;

	const emit = (block: string) => {
		const table = tables.at(-1);
		if (table?.cell) table.cell.push(block);
		else out.push(block);
	};
	for (const e of events(source)) {
		if (e.type === "text") {
			if (para && stack.at(-1) === "w:t") para.text += decodeEntities(e.text);
			continue;
		}
		const { name } = e;
		if (e.type === "open") stack.push(name);
		if (e.type === "close") stack.pop();
		const opening = e.type !== "close";
		switch (name) {
			case "w:p":
				if (opening) para = { text: "", heading: 0, list: false };
				if (e.type !== "open" && para) {
					const text = para.text.trim();
					if (text) emit(para.heading ? `${"#".repeat(Math.min(para.heading + 1, 6))} ${text}` : para.list ? `- ${text}` : text);
					para = null;
				}
				break;
			case "w:pStyle": {
				const style = attr(e.attrs, "w:val") ?? "";
				const h = /^(?:heading|Heading)\s?(\d)$/.exec(style);
				if (para && h) para.heading = Number(h[1]);
				else if (para && /^Title$/i.test(style)) para.heading = 1;
				else if (para && /^List/i.test(style)) para.list = true;
				break;
			}
			case "w:numPr":
				if (para && opening) para.list = true;
				break;
			// In a run, they are text; a paragraph's tab stops (w:tabs/w:tab) are not.
			case "w:tab":
				if (para && opening && stack.at(-1) === "w:r") para.text += "\t";
				break;
			case "w:br":
			case "w:cr":
				if (para && opening && stack.at(-1) === "w:r") para.text += "\n";
				break;
			case "w:tbl":
				if (e.type === "open") tables.push({ rows: [], row: null, cell: null });
				if (e.type === "close") {
					const table = tables.pop();
					if (table && table.rows.length > 0) emit(markdownTable(table.rows));
				}
				break;
			case "w:tr": {
				const table = tables.at(-1);
				if (!table) break;
				if (e.type === "open") table.row = [];
				if (e.type === "close" && table.row) {
					table.rows.push(table.row);
					table.row = null;
				}
				break;
			}
			case "w:tc": {
				const table = tables.at(-1);
				if (!table) break;
				if (e.type === "open") table.cell = [];
				if (e.type === "close" && table.cell) {
					table.row?.push(table.cell.join(" "));
					table.cell = null;
				}
				break;
			}
		}
	}
	return `${out.join("\n\n")}\n`;
}

// ——— Excel ———

function relTargets(files: Unzipped, relsPath: string, baseDir: string): Map<string, string> {
	const out = new Map<string, string>();
	const source = xml(files, relsPath);
	if (!source) return out;
	for (const e of events(source)) {
		if (e.type === "text" || e.name !== "Relationship") continue;
		const id = attr(e.attrs, "Id");
		const target = attr(e.attrs, "Target");
		if (!id || !target) continue;
		out.set(id, target.startsWith("/") ? target.slice(1) : normalize(`${baseDir}/${target}`));
	}
	return out;
}

function normalize(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "..") parts.pop();
		else if (part !== "." && part !== "") parts.push(part);
	}
	return parts.join("/");
}

function sharedStrings(files: Unzipped): string[] {
	const source = xml(files, "xl/sharedStrings.xml");
	if (!source) return [];
	const out: string[] = [];
	let current: string | null = null;
	const stack: string[] = [];
	for (const e of events(source)) {
		if (e.type === "text") {
			// Phonetic runs (rPh) are readings, not the text.
			if (current !== null && stack.at(-1) === "t" && !stack.includes("rPh")) current += decodeEntities(e.text);
			continue;
		}
		if (e.type === "open") stack.push(e.name);
		if (e.type === "close") stack.pop();
		if (e.name === "si") {
			if (e.type === "open") current = "";
			else if (e.type === "empty") out.push("");
			else if (current !== null) {
				out.push(current);
				current = null;
			}
		}
	}
	return out;
}

/** "AB" → 27 (0-based column of a cell reference). */
function columnOf(ref: string): number {
	let n = 0;
	for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

function xlsxToMarkdown(files: Unzipped): string {
	const workbook = xml(files, "xl/workbook.xml");
	if (!workbook) throw new DocumentError("This Excel file has no workbook part");
	const targets = relTargets(files, "xl/_rels/workbook.xml.rels", "xl");
	const strings = sharedStrings(files);
	const sheets: { name: string; path: string }[] = [];
	for (const e of events(workbook)) {
		if (e.type === "text" || e.name !== "sheet") continue;
		const id = attr(e.attrs, "r:id");
		const path = id ? targets.get(id) : undefined;
		if (path) sheets.push({ name: attr(e.attrs, "name") ?? path, path });
	}
	const out: string[] = [];
	for (const sheet of sheets) {
		const source = xml(files, sheet.path);
		if (source === undefined) continue;
		const rows: string[][] = [];
		let skipped = 0;
		let row: string[] | null = null;
		let col = 0;
		let type = "";
		let value = "";
		let inValue = false;
		const stack: string[] = [];
		for (const e of events(source)) {
			if (e.type === "text") {
				if (inValue) value += decodeEntities(e.text);
				continue;
			}
			if (e.type === "open") stack.push(e.name);
			if (e.type === "close") stack.pop();
			if (e.name === "row") {
				if (e.type !== "close") row = [];
				if (e.type !== "open" && row) {
					if (rows.length < MAX_SHEET_ROWS) {
						if (row.some((v) => v !== "")) rows.push(row);
					} else skipped++;
					row = null;
				}
			} else if (e.name === "c" && row) {
				if (e.type !== "close") {
					const ref = attr(e.attrs, "r");
					col = ref ? columnOf(ref) : row.length;
					type = attr(e.attrs, "t") ?? "";
					value = "";
				}
				if (e.type !== "open" && col < MAX_SHEET_COLUMNS) {
					let shown = value;
					if (type === "s") shown = strings[Number(value)] ?? "";
					else if (type === "b") shown = value === "1" ? "TRUE" : "FALSE";
					while (row.length < col) row.push("");
					row[col] = shown;
				}
			} else if (e.name === "v" || (e.name === "t" && stack.includes("is"))) {
				inValue = e.type === "open";
			}
		}
		out.push(`## Sheet: ${sheet.name}`);
		out.push(rows.length === 0 ? "(empty)" : markdownTable(rows));
		if (skipped > 0) out.push(`(${skipped} more row${skipped === 1 ? "" : "s"} not shown)`);
	}
	if (out.length === 0) return "(no sheets)\n";
	return `${out.join("\n\n")}\n`;
}

// ——— PowerPoint ———

function paragraphs(source: string): string[] {
	const out: string[] = [];
	let current: string | null = null;
	const stack: string[] = [];
	for (const e of events(source)) {
		if (e.type === "text") {
			if (current !== null && stack.at(-1) === "a:t") current += decodeEntities(e.text);
			continue;
		}
		if (e.type === "open") stack.push(e.name);
		if (e.type === "close") stack.pop();
		if (e.name === "a:p") {
			if (e.type === "open") current = "";
			if (e.type === "close" && current !== null) {
				if (current.trim()) out.push(current.trim());
				current = null;
			}
		} else if (e.name === "a:br" && current !== null) current += "\n";
	}
	return out;
}

function pptxToMarkdown(files: Unzipped): string {
	const presentation = xml(files, "ppt/presentation.xml");
	if (!presentation) throw new DocumentError("This PowerPoint file has no presentation part");
	const targets = relTargets(files, "ppt/_rels/presentation.xml.rels", "ppt");
	const slides: string[] = [];
	for (const e of events(presentation)) {
		if (e.type === "text" || e.name !== "p:sldId") continue;
		const id = attr(e.attrs, "r:id");
		const path = id ? targets.get(id) : undefined;
		if (path) slides.push(path);
	}
	const out: string[] = [];
	slides.forEach((path, i) => {
		const source = xml(files, path);
		if (source === undefined) return;
		const lines = paragraphs(source);
		const dir = path.slice(0, path.lastIndexOf("/"));
		const file = path.slice(path.lastIndexOf("/") + 1);
		const rels = relTargets(files, `${dir}/_rels/${file}.rels`, dir);
		const notesPath = [...rels.values()].find((target) => target.includes("notesSlides/"));
		const notesSource = notesPath ? xml(files, notesPath) : undefined;
		// The notes page repeats the slide number as a paragraph of its own.
		const notes = notesSource ? paragraphs(notesSource).filter((line) => !/^\d+$/.test(line)) : [];
		out.push(`## Slide ${i + 1}`);
		out.push(lines.length > 0 ? lines.map((line, j) => (j === 0 ? `**${line}**` : `- ${line}`)).join("\n") : "(no text)");
		if (notes.length > 0) out.push(`Notes: ${notes.join(" ")}`);
	});
	if (out.length === 0) return "(no slides)\n";
	return `${out.join("\n\n")}\n`;
}

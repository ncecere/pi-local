import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { DocumentError, documentKindOf, documentToMarkdown, MAX_DOCUMENT_BYTES } from "./documents.ts";

/**
 * `runtime.mjs --extract <file>`: a file's text as Markdown on stdout, for the app's knowledge index (the converters
 * `read` uses: PDF, Word, Excel, PowerPoint; any other file is read as UTF-8 text). Exit 1 with the reason on stderr
 * when it can't be read.
 *
 * `runtime.mjs --extract --batch`: paths, one per line, on stdin; one JSON object per line on stdout, in order:
 * `{"path", "markdown"}` or `{"path", "error"}`. One process for many files (starting Node and loading the PDF
 * library once), a file that fails never stops the rest.
 */

export type ExtractLine = { path: string; markdown: string } | { path: string; error: string };

/** The Markdown of one file. Throws DocumentError (or an Error with a plain message) when it can't be read. */
export async function extractFile(path: string): Promise<string> {
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(path);
	} catch {
		throw new DocumentError(`${basename(path)} could not be found`);
	}
	if (!info.isFile()) throw new DocumentError(`${basename(path)} is not a file`);
	if (info.size > MAX_DOCUMENT_BYTES) throw new DocumentError(`${basename(path)} is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`);
	const bytes = await readFile(path);
	const kind = documentKindOf(path);
	if (kind) return documentToMarkdown(bytes, kind, basename(path));
	// Anything else is text. A file with NUL bytes is binary, not something to index.
	if (bytes.subarray(0, 8192).includes(0)) throw new DocumentError(`${basename(path)} is not a text file`);
	return new TextDecoder("utf-8").decode(bytes);
}

export type ExtractIo = {
	stdin: () => Promise<string>;
	stdout: (text: string) => Promise<void>;
	stderr: (text: string) => Promise<void>;
};

function reason(error: unknown): string {
	return error instanceof DocumentError ? error.message : `could not be read: ${(error as Error).message ?? error}`;
}

/** Runs the extract mode for the arguments after `--extract`. Resolves with the process's exit code. */
export async function runExtract(args: string[], io: ExtractIo): Promise<number> {
	if (args[0] === "--batch") {
		const paths = (await io.stdin()).split("\n").map((p) => p.replace(/\r$/, "")).filter((p) => p !== "");
		for (const path of paths) {
			let line: ExtractLine;
			try {
				line = { path, markdown: await extractFile(path) };
			} catch (error) {
				line = { path, error: reason(error) };
			}
			await io.stdout(`${JSON.stringify(line)}\n`);
		}
		return 0;
	}
	const [path] = args;
	if (!path || args.length !== 1) {
		await io.stderr("usage: runtime.mjs --extract <file> | --extract --batch (paths on stdin)\n");
		return 2;
	}
	try {
		await io.stdout(await extractFile(path));
		return 0;
	} catch (error) {
		await io.stderr(`${reason(error)}\n`);
		return 1;
	}
}

/** The process's own streams. */
export function processIo(): ExtractIo {
	return {
		stdin: async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
			return Buffer.concat(chunks).toString("utf8");
		},
		stdout: (text) => new Promise((resolve) => process.stdout.write(text, () => resolve())),
		stderr: (text) => new Promise((resolve) => process.stderr.write(text, () => resolve())),
	};
}

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

/**
 * Photon's WebAssembly (images: resize, convert), read from the installed package. The runtime bundle replaces this
 * module with one that has the bytes inlined (scripts/bundle.mjs): the app runs a single file, with no node_modules.
 */
export default async function photonWasm(): Promise<Uint8Array> {
	const from = createRequire(createRequire(import.meta.url).resolve("@earendil-works/pi-durable/images/node"));
	return new Uint8Array(await readFile(from.resolve("@silvia-odwyer/photon/photon_rs_bg.wasm")));
}

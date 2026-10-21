// Bundles the runtime into one ESM file the app embeds and runs on its bundled Node: dist/runtime.mjs.
import { build } from "esbuild";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";

// Photon's WebAssembly (image resizing), inlined: the app runs this one file, with no node_modules beside it.
// src/lib/photon-wasm.ts reads it from the installed package; the bundle gets these bytes instead.
const photonWasm = createRequire(import.meta.resolve("@earendil-works/pi-durable/images/node")).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm");
const inlinePhoton = {
	name: "inline-photon-wasm",
	setup(b) {
		b.onLoad({ filter: /[\\/]src[\\/]lib[\\/]photon-wasm\.ts$/ }, () => ({
			contents: `const bytes = Uint8Array.from(atob(${JSON.stringify(readFileSync(photonWasm).toString("base64"))}), (c) => c.charCodeAt(0));\nexport default async function photonWasm() { return bytes; }\n`,
			loader: "js",
		}));
	},
};

const result = await build({
	entryPoints: ["src/main.ts"],
	outfile: "dist/runtime.mjs",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22.19",
	minify: true,
	sourcemap: "linked",
	legalComments: "linked",
	metafile: true,
	// Some dependencies are CommonJS and call require(); give the ESM bundle one.
	banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
	logLevel: "warning",
	plugins: [inlinePhoton],
});
const kb = (f) => `${(statSync(f).size / 1024).toFixed(0)} KiB`;
console.log(`dist/runtime.mjs ${kb("dist/runtime.mjs")}; inputs: ${Object.keys(result.metafile.inputs).length}`);

// Bundles the runtime into one ESM file the app embeds and runs on its bundled Node: dist/runtime.mjs.
import { build } from "esbuild";
import { statSync } from "node:fs";

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
});
const kb = (f) => `${(statSync(f).size / 1024).toFixed(0)} KiB`;
console.log(`dist/runtime.mjs ${kb("dist/runtime.mjs")}; inputs: ${Object.keys(result.metafile.inputs).length}`);

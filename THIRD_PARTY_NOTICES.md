# Third-party notices

Pi Local's own code is under the [MIT License](LICENSE). The packaged app includes full third-party license,
notice, and copyright texts under `Pi Local.app/Contents/Resources/third-party/`, generated before code signing.
Start with `third-party/index.json` for package/version labels, source provenance, and SHA-256 hashes of the
copied files. These notices do not replace or relicense the individual components.

The directory includes:

- `npm-runtime/` and `npm-frontend/`: installed npm packages, including frontend libraries declared in
  `devDependencies`. License-less distributions use the reviewed, version-specific upstream overrides recorded
  in the index, not just an SPDX identifier. The inventory conservatively includes build dependencies; Vitest's
  test-only `stackback@0.0.2` is explicitly excluded and checked against both release bundler input graphs.
- `go/`: the production Darwin Go module dependencies, with root and inherited notices (including modernc's
  `LICENSE-3RD-PARTY.md`); `go-toolchain/`: the Go distribution license and patents notice.
- `wasm/` and `photon-crate/`: Photon, its Rust standard-library notices, the Roboto font notices, and a
  conservative constituent inventory from the published Cargo.lock plus versions observed in the pinned WASM.
  Lockfile-only build, development, and other-target crates are included for notice completeness, not claimed
  to be shipped code.
- `bundled-npm/`: full pinned PDF.js terms and upstream build notices (PDF.js is prebundled inside unpdf).
- `runtime/runtime.mjs.LEGAL.txt`: the exact runtime bundle's esbuild legal comments, **in addition to** full npm
  license texts. The comments alone are not the complete licenses.
- `node/` and `pi-local/`: copies of the Node distribution license and this adaptation notice. The existing
  `Contents/Resources/node-LICENSE`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` are also retained.

Source review records and the offline generator are in `packaging/licenses/`. These parts are included or
adapted directly:

## Node.js

The app bundles the Node.js runtime (`Pi Local.app/Contents/Resources/node`). Its license, including the notices of
the libraries Node includes, ships beside it as `Contents/Resources/node-LICENSE`.

## pi coding agent

The coding agent kind (`runtime/src/kinds/coding.ts`, `runtime/src/lib/project-context.ts`) adapts the system
prompt and the project-instruction loading of the pi coding agent,
[@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).

> MIT License
>
> Copyright (c) Mario Zechner
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
> persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
> Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
> WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Bundled into the agent runtime

`runtime/dist/runtime.mjs` bundles its npm dependencies; the Go binary embeds the bundle, not the esbuild
sidecar. Packaging therefore explicitly ships `third-party/runtime/runtime.mjs.LEGAL.txt` and full dependency
terms in `third-party/`. Three are worth naming for what they do in the runtime:

- [unpdf](https://github.com/unjs/unpdf) (MIT), with Mozilla's [PDF.js](https://github.com/mozilla/pdf.js)
  (Apache-2.0): reading PDF files as text.
- [fflate](https://github.com/101arrowz/fflate) (MIT): opening Word, Excel and PowerPoint files.
- [Photon](https://github.com/silvia-odwyer/photon) 0.3.3 (Apache-2.0), its WebAssembly inlined: resizing images for
  the model. Constituent notices include Rust, image, flate2/miniz, and Roboto (Apache-2.0).

The frontend includes React, Radix UI, TanStack, Streamdown, Mermaid, and Lucide. Lucide's complete notice retains
both its ISC terms and the Feather-derived icons' MIT terms and Cole Bemis copyright.

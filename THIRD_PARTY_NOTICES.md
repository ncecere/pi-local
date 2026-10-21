# Third-party notices

Pi Local's own code is under the [MIT License](LICENSE). Its npm and Go dependencies carry their own licenses (see
`runtime/node_modules`, `frontend/node_modules` and `go.mod`). These parts are included or adapted directly:

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

## Apple connections

The Calendar, Reminders and Notes bridge is Pi Local's own MIT-licensed code. It calls macOS's installed
`/usr/bin/osascript`; no Apple binaries or third-party MCP server packages are redistributed for these connections.

## Bundled into the agent runtime

`runtime/dist/runtime.mjs` bundles its npm dependencies; esbuild keeps their license comments in
`runtime.mjs.LEGAL.txt`. Three are worth naming for what they do in it:

- [unpdf](https://github.com/unjs/unpdf) (MIT), with Mozilla's [PDF.js](https://github.com/mozilla/pdf.js)
  (Apache-2.0): reading PDF files as text.
- [fflate](https://github.com/101arrowz/fflate) (MIT): opening Word, Excel and PowerPoint files.
- [Photon](https://github.com/silvia-odwyer/photon) (Apache-2.0), its WebAssembly inlined: resizing images for the
  model.

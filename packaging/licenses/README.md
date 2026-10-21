# Release notices

`packaging/macos/package.sh` installs both pnpm projects with frozen lockfiles, builds the runtime and frontend,
and assembles `Contents/Resources/third-party` **before any codesign command**. Notice generation is offline;
it does not run the app, access the Keychain, or sign anything. It refuses an existing output directory.

The generator copies complete files verbatim, labels them by ecosystem/package/version, and records SHA-256
hashes and source references in `index.json`. Original Node LICENSE, Pi Local LICENSE, and the Pi adaptation
notice remain beside the directory. The runtime legal sidecar is copied explicitly; `runtime/embed.go` embeds
only JavaScript, and esbuild's comments are not full dependency terms.

## Coverage and release gates

- All physical pnpm package versions are inventoried, **including frontend devDependencies**. Peer variants with
  different notice files fail. Installed and source lockfiles must match; frozen lockfiles and Go module files
  are included under `provenance/`. Package manifests and copied notice files are hashed in the index.
- Root and nested LICENSE, COPYING, NOTICE, COPYRIGHT, AUTHORS and REUSE notices are retained. License directories
  are traversed; dependency symlinks are not followed. Native build-tool companion packages inherit notices
  only from the identical installed parent version.
- A missing root grant fails unless a reviewed exact-version override supplies it. Short SPDX declarations and
  URL-only notices are not considered full terms. Actual upstream Apache grants that omit the standard terms
  keep their copyright/grant and receive full Apache text from the hash-pinned upstream root recorded as
  `$apache-2.0`; an SPDX label alone never triggers this supplement.
- `stackback@0.0.2` is the sole explicit installed-package exclusion: it is a Vitest-only dependency without a
  published MIT text. Both complete bundler input graphs must contain neither stackback nor its Vitest
  consumer. Build-only receipts under `.cache/licenses/` hash every dist artifact (including chunks that
  Rolldown emits without source maps). Missing or stale receipts fail. The receipts are shipped under
  `provenance/`; no build metadata is added to embedded dist assets.
- Production Go module directories are discovered with `GOOS=darwin GOARCH=<packaged-arch> CGO_ENABLED=1 go list
  -mod=readonly -deps ./cmd/pi-local`, after `go mod verify`. Replacements fail pending review. Root and inherited
  notices include modernc's third-party files, SQLite/SQLite-vec, mmap-go, and yaml's NOTICE. All discovered
  module versions are included, not a hard-coded list. Named notice assertions provide regression gates.
- The Go standard-library root license/patents and nested source notices are included. Nix omits the root files;
  `go-toolchain.json` supplies them from the exact pinned Go release commit, only for the matching Go version.
- Named assertions cover React, Radix, TanStack, Streamdown, Mermaid, Lucide **ISC and Feather MIT**, Earendil,
  standardwebhooks, react-remove-scroll-bar, remark-math, rehype-katex, unpdf, fflate, and Photon.

## Pinned sources and review limitations

`overrides.json`, `photon.json`, `pdfjs.json`, and `go-toolchain.json` record exact source URLs, versions/commits,
review rationale, and file hashes. Their text files are committed under `sources/`; the build fetches no license
from a moving branch or a `latest` endpoint. npm source references resolve through the packaged frozen lockfiles.

Earendil 1.3.0, proxy-agent-negotiate, AI provider-utils, and workflow-serde commits were resolved from the exact
npm release's SLSA provenance. standardwebhooks and the remark packages use registry `gitHead` commits. Source
repositories were retrieved and inspected at those commits; source acquisition caches are not build inputs.

Two overrides deliberately do **not** claim exact release-commit correspondence:

- `react-remove-scroll-bar@2.3.8`'s registry gitHead `b3b1287aad81def2e2ae707274b74531b61ddbaf` is unavailable from
  Git and raw GitHub URLs. Its author/repository/MIT declaration were checked against the pinned upstream author
  grant at `8ca9ba5ea52de03308fe8ced94f7b159a44d28ff` (repository package.json still says 2.3.7). The full Anton
  Korzunov MIT grant is supplied explicitly, not inferred from SPDX or described as the missing release source.
- Three AWS packages omit root terms. Their Apache metadata and AWS authorship were checked, and the monorepo
  root Apache grant is supplied from pinned `v3.972.0` commit `c47a84766e65e9a7f3d7151ff10d58aba29e6df0`.

Photon's npm 0.3.3 WASM hash is a release gate. Its embedded paths identify Rust commit
`3f43b1a636738f41c48df073c5bcb97a97bf8459` and crate versions including image 0.24.9 and flate2 1.0.34. The
inventory is the **union** of the checksum-verified published photon-rs 0.3.3 Cargo.lock and versions observed
in that exact WASM, not a reproducible-build attestation or exact shipped-crate SBOM. It includes conservative
build/dev/other-target entries. Every lockfile crate/checksum and observed crate must be represented with full
terms. All source archive license directories and REUSE copyright records are retained. Omitted monorepo root
licenses use the commit in each crate's `.cargo_vcs_info.json`. The node-sys repository is unavailable; its
checksum-pinned crate source/declaration/authors are retained alongside full Apache terms (the selected dual
license option). Rust LICENSE/COPYRIGHT and the embedded Roboto 2.137 name-table notices and Apache text are
included. No copyright names or grants are fabricated.

PDF.js 6.4.299 is prebundled inside unpdf 1.9.1. Its exact unpdf file hash gates the supplement. All license files
and verbatim legal comment blocks from the integrity-verified, pinned pdfjs-dist archive are included, even for
assets not necessarily used by text extraction.

## Checking and updating

```sh
make test-licenses  # unit/structural checks; integration explicitly skipped without a Node distribution LICENSE
NOTICE_TEST_NODE_LICENSE=/path/to/verified/node-v22.23.0/LICENSE make test-licenses
```

Installed-tree integration requires frozen installs and `make runtime frontend` first. It creates disposable
Resources directories under `.cache/`, generates twice, compares every byte, verifies packaged file hashes,
checks named gaps, and tests rejection of missing overrides. It does not build a DMG, invoke codesign, or launch
the app. The release packaging script itself is syntax-checked, not executed by these tests.

For dependency upgrades, inspect exact installed package terms and upstream notices. Resolve the release commit
from registry metadata/provenance, or retrieve the exact checksum-pinned source archive. Review inherited and
constituent notices, commit the complete texts and provenance, and update hashes only after review. New Photon,
unpdf, or stripped-Go-toolchain versions fail until their pinned inventories are refreshed. Do not replace a
missing copyright/license with a generic SPDX template. Run installed-tree integration after changes.

# Release notices

`packaging/macos/package.sh` installs both pnpm projects with frozen lockfiles, builds the runtime and frontend,
and assembles `Contents/Resources/third-party` **before any codesign command**. Notice generation is offline;
it does not run the app, access the Keychain, or sign anything. It refuses an existing output directory.
Before the Go build, packaging runs online `go mod download` for all explicit pinned requirements, including
modules not linked on Darwin. It fails if this changes `go.mod` or `go.sum`. This cache hydration is separate
from offline assembly, which retains `GOPROXY=off`, `GOSUMDB=off`, and checksum verification.

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

## Phase 1 target build evidence only

`targets.json` is the reviewed target-contract table. `NOTICE_TARGET` unset, `darwin-arm64`, or
`darwin-amd64` retains the existing Schema 1 receipt path and bytes; the generator and macOS package commands
remain Darwin-only. **The existing 733-entry Darwin inventory is not a Windows/Linux inventory.**
New evidence is selected only by explicit `NOTICE_TARGET=windows-amd64` or `NOTICE_TARGET=linux-amd64`.
The Node process must actually run on the matching OS and x64 architecture; neither writer nor validator
accepts a fake host. Unknown targets, conflicting Go/Node target environment, and custom Go build tags fail.
The Windows contract is `GOOS=windows GOARCH=amd64 CGO_ENABLED=0`; Linux is
`GOOS=linux GOARCH=amd64 CGO_ENABLED=1`, **default GTK4**, never CGO-disabled, server or GTK3 fallback.
These Go fields are a **target contract**, not observed Go execution: Phase 1 does not build, load or query Go.
The helper does not mutate the Go environment.

After installing **both** package projects from their own directories with `pnpm install --frozen-lockfile`,
build on the matching native machine (examples use Bash, including Git Bash on Windows):

```sh
# Use windows-amd64 on native Windows x64, linux-amd64 on native Linux x64.
export NOTICE_TARGET=linux-amd64
(cd runtime && pnpm bundle)
(cd frontend && pnpm build)
node packaging/licenses/receipt-evidence.mjs assert --target linux-amd64 --area runtime
node packaging/licenses/receipt-evidence.mjs assert --target linux-amd64 --area frontend
```

Only `.cache/licenses/inventory/<target>/receipts/<area>-build.json` is written. Areas are strictly `runtime`
and `frontend`; no environment variable can redirect the path. Legacy receipts, `Resources/third-party`,
legal catalogs and embedded dist contents are not written by the receipt helper. Snapshot/input failures
precede evidence writes; successful writes replace atomically. Symlinked evidence paths are refused.

Schema 2 records `kind: build-evidence`, target/area, the exact reviewed descriptor and its SHA-256,
observed Node OS/architecture/version from the current process, **both** frozen source/installed lock checks,
both root-manifest hashes, both declared package managers and installed-package identity snapshots, the
bundler-reported input IDs/digest, and every current area dist artifact hash. There are no clocks, worktree
roots or hostnames. `distributionComplete` is always `false`.

The shared physical scanner is the same `noticeFiles`/`installedPackages` public API re-exported by the
Darwin generator, without a generator/receipt import cycle. Its lock equality, declared dependency and full
peer notice comparisons are unchanged. The additional identity snapshot sorts unique IDs and records each
representative package.json byte hash plus the existing fingerprint of all recognized notice file paths and
bytes; its aggregate SHA-256 hashes that JSON array. It retains the scanner's notice-equivalent peer
deduplication and representative manifest selection. **It does not hash every module/source file or every
peer manifest and is not a full source-integrity attestation.** No new license-coverage inference is made.

`declaredPackageManager` is precisely the package.json declaration from a lock-checked installation, not an
observed pnpm execution version. No user-agent inference, pnpm subprocess, or Windows `.cmd` shell query is
used. The dedicated native CI workflow separately checks actual `pnpm --version` equals `11.18.0` in each
package directory; those CI observations are not fabricated from declarations in a receipt.

`validateBuildEvidence(root, expectedTarget, expectedArea)` reads only the selected target path, requires a
matching native Node host and recomputes installation/artifact snapshots. It compares the entire object to
current policy/snapshots and requires the canonical writer JSON bytes (including rejecting duplicate keys,
extra claims, unknown nested fields, legacy Schema 1 and `distributionComplete: true`). Its CLI prints only
a small success summary or a sanitized failure. Missing target evidence never falls back to legacy files.
The exported pure `assertBuildEvidenceSnapshot` comparator is only an exact-object comparison, not an
independent native/installation assertion.

These local hashes are not signatures or tamper-proof attestations. Input IDs are the build hook's reported
graph labels, not an independently reconstructed graph; validation checks their canonical encoding/digest,
not a rerun of the bundler or hashes of all source code. Opaque virtual IDs keep the legacy normalization
semantics. Receipts **cannot establish license coverage, a production Go graph, native-library coverage,
Node archive provenance or a distribution's completeness**.

The dedicated `v05-target-receipt-evidence.yml` lane is restricted to this feature branch and `v0.5`, uses
Windows 2025/Ubuntu 24.04, Node 22.23.0 and actual package-cwd pnpm 11.18.0 checks, frozen installs, native
unit tests, both receipt assertions and repeated receipt hash checks. It does not execute Go, launch apps,
servers or test binaries, access vaults, install apt dependencies, download Node distribution archives for
packaging, package, upload or release. Existing desktop compile workflows keep their legacy receipts.
See [QA and reviewed native evidence](../../docs/qa/v0.5-target-receipt-evidence.md).

The separate [native Go source graph increment](GO-GRAPH-EVIDENCE.md) adds explicit native-only
`go-graph-evidence.mjs write|assert --target windows-amd64|linux-amd64` commands and new unit tests.
It does not feed notice generation or change either existing receipt schema. Independent source review
passed; new native runs remain pending. Mac fixtures do not establish native target execution.

Still deferred: target-specific legal catalogs, Node archive provenance/downloads, Windows/Linux full
notice assembly, distribution/installer work and native-library boundary review.
Both non-Darwin sandbox capabilities remain off and their runtimes unavailable; no app support is enabled.

For dependency upgrades, inspect exact installed package terms and upstream notices. Resolve the release commit
from registry metadata/provenance, or retrieve the exact checksum-pinned source archive. Review inherited and
constituent notices, commit the complete texts and provenance, and update hashes only after review. New Photon,
unpdf, or stripped-Go-toolchain versions fail until their pinned inventories are refreshed. Do not replace a
missing copyright/license with a generic SPDX template. Run installed-tree integration after changes.

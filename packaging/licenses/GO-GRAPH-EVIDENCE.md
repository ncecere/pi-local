# Native production Go source graph evidence

This is a **build-only source graph**, not a notice manifest, SBOM, installer,
linked-library inventory or runtime acceptance. It does not change the Darwin
notice generator, Schema 1 notice receipts, Phase 1 Schema 2 receipts, package
hooks or target descriptors. `distributionComplete` is always `false`.
Independent source review and the offline-routing correction passed. Native
Windows/Linux runs are **pending**; Mac unit fixtures are not native target evidence.

## Commands (matching native hosts only)

Use a trusted, fixed Go **1.26.10** SDK on PATH, Node **22.23.0**, and package-cwd
pnpm **11.18.0**. Windows requires native Windows x64, `GOOS=windows`,
`GOARCH=amd64`, `CGO_ENABLED=0`. Linux requires native Linux x64,
`GOOS=linux`, `GOARCH=amd64`, `CGO_ENABLED=1`, stock GTK4/WebKitGTK6 development
libraries and compiler as in `v05-ubuntu-desktop-build.yml`. No CGO-disabled,
GTK3, server or MCP build-tag fallback is accepted. Runners must already have
the fixed SDK and required build libraries; the collector installs nothing.

The examples use Bash (Git Bash on Windows), from the repository. Do **not** set
`NOTICE_TARGET` globally: bundler hooks retain their existing default Node
Schema 1 receipts. Set the three Go target variables above to match the host.

```sh
export GOTOOLCHAIN=local GOFLAGS=-mod=readonly
# Explicit online hydration OUTSIDE the collector, with guards even on failure.
(
  set -euo pipefail
  before=$(sha256sum go.mod go.sum)
  trap 'status=$?; test "$(sha256sum go.mod go.sum)" = "$before" || exit 1; exit "$status"' EXIT
  GOENV=off GOWORK=off go mod download
  test "$(sha256sum go.mod go.sum)" = "$before"
)
(cd runtime && pnpm install --frozen-lockfile && pnpm bundle)
(cd frontend && pnpm install --frozen-lockfile && pnpm build)
node --test packaging/licenses/go-graph-evidence.test.mjs

# Native Linux x64 only. Substitute windows-amd64 on native Windows x64.
node packaging/licenses/go-graph-evidence.mjs write --target linux-amd64
node packaging/licenses/go-graph-evidence.mjs assert --target linux-amd64
before=$(sha256sum .cache/licenses/go-graph/linux-amd64/production.json)
node packaging/licenses/go-graph-evidence.mjs write --target linux-amd64
node packaging/licenses/go-graph-evidence.mjs assert --target linux-amd64
test "$(sha256sum .cache/licenses/go-graph/linux-amd64/production.json)" = "$before"
```

The CLI accepts exactly `write|assert --target windows-amd64|linux-amd64`.
Root is resolved from the script, entrypoint is **only `./cmd/pi-local`**, and
output is **only `.cache/licenses/go-graph/<target>/production.json`**. There is
no caller root/output, executable, tag, fake-host or Go-executor option. Calling
from another directory cannot redirect collection. Darwin/Node host mismatches
fail before **any** Go subprocess or evidence write. Supported Node hosts use a
small bounded `go env -json` identity probe to require matching Go host, effective
OS/architecture/CGO and exact `go1.26.10` before graph commands. A second probe
obtains trusted physical SDK/cache anchors and checks the main module/workspace.
The actual Node version is observed, not inferred from a descriptor; CI separately
requires the fixed Node/pnpm versions.

Globals are unchanged. Go subprocesses alone use `GOTOOLCHAIN=local`,
`GOENV=off`, `GOWORK=off`, `GOFLAGS=-mod=readonly`, `GOPROXY=off`, `GOSUMDB=off`,
`GOPRIVATE=''` and `GONOPROXY=none`. Private-module routing is explicitly neutralized:
otherwise inherited GOPRIVATE/GONOPROXY can take a direct route before GOPROXY=off.
These are module-routing controls, not an OS-level egress sandbox; trusted toolchain,
compiler and runner prerequisites still apply.
Inherited non-default GOFLAGS (including tags, overlay, modfile, race, toolexec),
selection conflicts, GOEXPERIMENT, non-v1 GOAMD64, alternate GOTOOLCHAIN,
workspace/module-mode overrides and gccgo selection are refused, not silently
reinterpreted as a different graph. No `go env -w` is used. Disabling saved Go
environment settings is intentional; no personal Go configuration is read.

## What is recorded

The separate envelope is `schema: 1`, **`kind: native-go-graph-evidence`**; it is
not notice Schema 1 and has no compatibility claim with it. It records:

- Fixed entrypoint, actual existing target descriptor and canonical descriptor
  digest, controlled invocation policy and fixed bounds.
- Distinct **declared contract** versus **observed** Node platform/architecture/
  version and Go host/version/effective GOOS/GOARCH/CGO/GOAMD64/GOEXPERIMENT and
  controlled default tag/GOFLAGS selection. Tag selection follows the fixed
  command/environment, not inspection of an executable.
- SHA-256 of `go.mod` and `go.sum`; both current runtime/frontend dist artifact
  maps (including maps/sidecars), not a stored bundler graph used as an oracle.
- Sorted selected modules: path, version, main flag, Sum and GoModSum from actual
  CLI metadata. The main module has null version/sums, not fabricated checksums.
- Sorted selected packages: import path, name, standard flag, module identity,
  sorted reported imports, and package-relative type/name/SHA-256 for `GoFiles`,
  `CgoFiles`, `CFiles`, `CXXFiles`, `HFiles`, `MFiles`, `FFiles`, `SFiles`,
  `SwigFiles`, `SwigCXXFiles`, `SysoFiles` and `EmbedFiles` only.
- Canonical graph digest over the selected module/package arrays. All JSON uses
  recursively sorted keys, two-space indentation and a terminal newline.

Collection runs offline `go mod verify`, then
`go list -mod=readonly -deps -json ./cmd/pi-local` and
`go list -mod=readonly -m -json <sorted selected module paths>`. It never uses
`-e`, `-test`, `./...`, downloads, auto-repairs or executes the production program.
Built embeds are required before listing. Module files are hashed before and
in a `finally` after **every** Go invocation and the whole operation, including
failures; independent guard budgets still run when graph budgets expire. They
are checked again before publishing. A mutation fails and is **not restored**.
Artifact maps are also checked before/after graph/source collection.

Concatenated JSON is parsed with bounded grammar scanning, not splitting braces;
duplicate keys are rejected even inside nested objects. Errors, dependency
errors, incomplete records, duplicate packages/modules, selected replacements,
conflicting module versions/checksums, malformed/missing references and ownership
mismatches fail. `C` is retained explicitly as a cgo pseudo-import (requires
selected CgoFiles), not demanded as a listed package. Standard sources are bound
to the observed toolchain and hashed under its SDK source tree. Compiler-provided
`unsafe` may validly have neither Dir nor selected files; no path/files are guessed.

For `assert`, the graph, source hashes, current artifacts, module hashes and
observations are **recollected**, independent of stored graph content. The entire
expected object and canonical writer bytes must match: stale/missing inputs,
unknown fields, extra claims, duplicates, noncanonical encodings and oversized
receipts fail. Snapshot failures precede replacement of a good output. Writes
stage in the same guarded parent and rename atomically; lexical symlink/junction
checks apply to source/artifact/evidence paths. Failures print one generic line,
not Go diagnostics, package IDs, filesystem paths or raw JSON. Success prints only
the requested target, module/package counts and incomplete-distribution status.

## Bounds, trust and exclusions

Fixed limits (also recorded in policy) are 64 MiB subprocess stdout/stderr
buffers, 64 MiB receipt reads, 4,096 package/JSON records, 256 modules, nesting
64, 2,000,000 JSON value tokens, 100,000 selected file reads/artifact entries,
64 MiB per input file and 512 MiB aggregate snapshot reads. Each command has at
most 120 seconds and the graph operation has a 300-second deadline. Separately
bounded module guards read at most 8 MiB per module file so a deadline/size failure
does not bypass the final guard. These ceilings refuse excess; none is a flag.

This trusts the Go executable selected by CI and its fixed SDK/cache. It is
**not** an arbitrary toolchain/token classifier, binary provenance signature or
proof against a hostile Go executable. Source ownership uses canonical physical
worktree/SDK/cache roots, exact module-cache escaped path/version ownership,
package/module import-path ownership and lexical lstat guards. Roots may be
resolved from trusted SDK/cache aliases; symlinks/junctions below those anchors
are refused. Trailing-dot/space path components (Win32 aliases), physical aliases
reported by realpath and metadata directories that disagree with the canonical
anchors are refused, not rewritten. Realpath is not a portable case-canonicalization
API; this does not promise refusal of every case alias on case-insensitive volumes.
It is **not TOCTOU-safe against a concurrently hostile filesystem**,
a signature, or complete source integrity.

Only selected production package files are hashed. Test and ignored-source lists
are not inventoried. Go-generated compiler/cgo intermediates, external C headers,
compiler paths, absolute cache/SDK/worktree paths, timestamps and raw Go output
are absent. This is not a complete SDK/module tree hash, cgo environment capture,
C-library linkage proof or native-library license claim. Library/compiler choices
are trusted runner prerequisites, not portable receipt observations. The existing
Ubuntu `file`, `go version -m`, `readelf` checks remain a **separate** compile/link
boundary; build info is not required to equal the source graph. No binary is
launched to inspect it.

## Local and native gates

```sh
node --test packaging/licenses/go-graph-evidence.test.mjs
make test-licenses  # retains the existing test command; adds the new suite separately
# Full existing installed-tree integration needs both frozen builds above and:
NOTICE_TEST_NODE_LICENSE=/path/to/verified/Node-22.23.0/LICENSE make test-licenses
```

Pure synthetic projection/relocation/staleness tests do not run Go. A separate unit
case uses the actual pinned Go tool in disposable module/cache/home directories to
check missing-cache routing. Go1.26.10 explicitly rejects the reserved example.net
fixture before dynamic lookup; GOVCS=*:off also forbids VCS execution. Old private
routing reaches that static refusal, while the controlled child environment must
stop at GOPROXY=off. This is not a production graph or OS network-isolation proof.
The unit command therefore requires the pinned Go tool as well as Node. Matching
native CLI refusal cases register only on Windows/Linux x64. Actual successful
write/assert/repeat is a separate post-assets step in the **existing** Windows and
Ubuntu compile workflows; both allow this feature branch for a future reviewed
push. Explicit guarded hydration precedes the offline collector. Existing compile,
`go test -c`, Ubuntu stock GTK4/WebKit6 and ELF/build-info checks remain. No global
NOTICE_TARGET, apt/sandbox-policy change, UI/test-binary execution, Node archive,
upload, packaging or release is added. The Node-only Phase 1 lane is unchanged.

Source grounding: Go **1.26.10** `go help list`, `go help env`, `go help build`,
`go help mod verify`, `go help mod download`; pinned SDK source
`src/cmd/go/internal/load/pkg.go` (PackagePublic, cgo pseudo-import/implicit deps),
`list/list.go` (relative file lists and deps/JSON processing),
`modload/build.go` (ModulePublic metadata and replacement/cache handling),
`modfetch/fetch.go` (RecordedSum), `modcmd/verify.go` and
`src/cmd/vendor/golang.org/x/mod/module/module.go` (cache escaping).
Actual local `go list -m -json` confirmed Main/Version and Sum/GoModSum semantics;
that Darwin metadata probe is **not** a Windows/Linux graph result. The list
Imports are the CLI's reported source imports; implicit linker/cgo dependencies
may additionally appear in the selected package/Deps set. No equality with linked
binary modules is derived. Native portability failures must remain failures,
not be hidden by a fallback or retroactive claim.

See [increment QA](../../docs/qa/v0.5-native-go-graph-evidence.md). Native execution,
independent review, target-specific notices/legal coverage, Node archive provenance,
installers, runtime/sandbox acceptance and any v0.5 release remain separate work.

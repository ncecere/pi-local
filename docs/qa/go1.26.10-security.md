# Go 1.26.10 security toolchain patch (v0.4.2)

Base: `main` at `4ecb7d42deccd4e719d0f8503d69a5a2bd8d4a3e` (v0.4.1 plus QA docs).
This patch raises the build minimum from Go **1.26.7 to 1.26.10**, not 1.27. It changes no production application
source, dependency versions, lockfiles or release version. A test-only synchronization backport is described below.
Existing release evidence remains unchanged.
Rebuilding is required: changing `go.mod` does not repair an already-built app.

## Official advisories and applicability

The following standard-library advisories cover 1.26.7 and are fixed in **1.26.9**; 1.26.10 includes those fixes.
Each link is the official Go vulnerability database record, not an assertion of exploitability here.

| Advisory | CVE | Scope |
| --- | --- | --- |
| [GO-2026-6599](https://vuln.go.dev/ID/GO-2026-6599.json) | CVE-2026-94448 | html/template consecutive-expression context tracking |
| [GO-2026-6600](https://vuln.go.dev/ID/GO-2026-6600.json) | CVE-2026-97030 | html/template yield/regexp context |
| [GO-2026-6603](https://vuln.go.dev/ID/GO-2026-6603.json) | CVE-2026-78659 | HTTP/2 server trailer memory exhaustion |
| [GO-2026-6604](https://vuln.go.dev/ID/GO-2026-6604.json) | CVE-2026-56857 | Windows os.Root junction escape |
| [GO-2026-6605](https://vuln.go.dev/ID/GO-2026-6605.json) | CVE-2026-56866 | HTTP/1 client rejected-CONNECT desynchronization |
| [GO-2026-6607](https://vuln.go.dev/ID/GO-2026-6607.json) | CVE-2026-97031 | malformed TLS ECH outer extension references |
| [GO-2026-6608](https://vuln.go.dev/ID/GO-2026-6608.json) | CVE-2026-94440 | MIME-header parsing memory-limit bypass |
| [GO-2026-6609](https://vuln.go.dev/ID/GO-2026-6609.json) | CVE-2026-78667 | ServeContent Range-header parsing limits |
| [GO-2026-6610](https://vuln.go.dev/ID/GO-2026-6610.json) | CVE-2026-78660 | HTTP/2 client framing headers |
| [GO-2026-6611](https://vuln.go.dev/ID/GO-2026-6611.json) | CVE-2026-78669 | HTTP/2 initial-window CPU exhaustion |
| [GO-2026-6612](https://vuln.go.dev/ID/GO-2026-6612.json) | CVE-2026-78663 | HTTP/2 server flow-control refund |
| [GO-2026-6613](https://vuln.go.dev/ID/GO-2026-6613.json) | CVE-2026-94439 | HTTP/1 server successful-CONNECT desynchronization |
| [GO-2026-6617](https://vuln.go.dev/ID/GO-2026-6617.json) | CVE-2026-97032 | HTTP/2 server HPACK encoder race |

[GO-2026-6809 / CVE-2026-111943](https://vuln.go.dev/ID/GO-2026-6809.json) additionally requires
**1.26.10** (or 1.27.3): `crypto/x509.Certificate.Verify` gains a denylist for compromised intermediate
certificates. The advisory explains that system trust updates cover most platforms, but narrower cases may
remain affected. This patch takes the fixed compiler rather than relying on a particular machine's trust store.

Concrete paths in this app:

- `internal/api/knowledge.go:knowledgeFile` calls `http.ServeContent` on an indexed file, reaching Range parsing
  (6609). File/index checks do not remove the Range-header parsing path. The headless SPA also uses
  `http.FileServer`/`http.ServeFile` in `cmd/pi-local-server/main.go`; that listener is loopback-only.
- HTTPS requests in `internal/web/fetch.go`, `internal/web/search.go`, `internal/update/update.go`,
  `internal/models/` and `internal/judge/judge.go` use Go HTTP clients and normal TLS verification (6809).
  Actual exposure depends on the remote certificate chain and trust configuration; no compromised server was contacted.
- HTTP/2 and CONNECT advisories depend on negotiated protocol, proxy/tunnel behavior, or server configuration.
  MIME, template and ECH issues require their specific parser/context/configuration. Merely importing `net/http`
  or a scanner reporting a broad affected symbol is not proof that those preconditions occur here.
- 6604 is Windows-only, not a claim about the Darwin package. No claim is made that all listed CVEs are reachable,
  that exploitation occurred, or that this is a complete audit of non-Go dependencies.
  The existing `golang.org/x/net v0.61.0` is already beyond the related advisories' v0.60.0 fixes; no upgrade is needed.

## Toolchain and notice provenance

Official release inventory: <https://go.dev/dl/?mode=json&include=all>.
The official Git tag was resolved with `git ls-remote https://go.googlesource.com/go refs/tags/go1.26.10`
and independently checked at <https://go.googlesource.com/go/+/refs/tags/go1.26.10?format=JSON>:
`4e8c85f5319d999bfd7617fdc191631e5634e3c5`.

Before updating the pin, LICENSE and PATENTS were fetched from that immutable commit on both
`go.googlesource.com` (`?format=TEXT`, decoded) and `raw.githubusercontent.com/golang/go` and compared byte-for-byte.
The complete texts are unchanged from the previous release; their SHA-256 hashes remain:

- LICENSE: `911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad`
- PATENTS: `96f408bfae65bf137fc2525d3ecb030271c50c1e90799f87abf8846d8dd505cc`

`packaging/licenses/go-toolchain.json` now points to those commit-specific URLs and `sources/go-toolchain/go1.26.10/`.
The strict version/hash checks, offline `GOPROXY=off`/`GOSUMDB=off` assembly, cold-cache hydration and frozen-lock
checks are unchanged. Both active GitHub workflows use `go-version-file: go.mod`; packaging and Make use `go`.
No independent active old-version pin was found. Historical spike build files/QA records are not release inputs
and were left alone. The README minimum now matches `go.mod`.

## Observed gates

- `GOTOOLCHAIN=go1.26.10 go version`: `go version go1.26.10 darwin/arm64` (downloaded into Go's cache only).
- Frozen pnpm installs, each invoked from its own `runtime`/`frontend` directory: passed.
- `make app server`: passed; `go version -m` identifies both resulting binaries as `go1.26.10`. Neither was launched.
- Direct pinned-file checks: both committed files match the downloaded Go 1.26.10 distribution byte-for-byte.
  A disposable stripped-GOROOT wrapper also verified offline 1.26.10 fallback assembly and rejection of a
  simulated 1.26.7 version; no generator checks were changed.
- `GOTOOLCHAIN=go1.26.10 .cache/security/bin/govulncheck -show verbose ./cmd/pi-local ./cmd/pi-local-server`:
  passed (exit 0), **No vulnerabilities found**, covering 22 modules and the 1.26.10 standard library on Darwin/arm64.
  Scanner `golang.org/x/vuln/cmd/govulncheck@v1.9.0` was installed only in this worktree's ignored cache;
  official database `https://vuln.go.dev`, updated `2026-10-21 00:27:29 UTC`. No suppressions were used.
- `make test-licenses` with the required `NOTICE_TEST_NODE_LICENSE`: passed **10/10, zero skipped**, including
  deterministic installed-tree integration and the cold-cache hydration regression. The downloaded Go 1.26.10
  `bin` directory was prepended to this process's PATH so even the cold-cache fixture's `GOTOOLCHAIN=local`
  compiler was 1.26.10. Offline/version/hash guards and packaging-script syntax checks passed.
- `make runtime frontend`: passed. The first full `make check` exited **2** after 306 seconds: vet and all other
  Go packages passed, but `TestSuggestionsAtTheEndOfAConversation` observed one of three asynchronous suggestions
  after polling for `len(got) > 0`, then asserted `len(got) == 3` (`internal/app/memory_suggest_test.go:76–82`).
  Runtime/frontend test targets were not reached in that attempt; the first failure is not counted as a pass.
  Subsequently `412c4b2` backported the reviewed test-only fix from v0.5: await all three individually persisted
  suggestions before asserting their properties. Production suggestion writes are unchanged. The parent rerun
  (`go12610-security-full-gate-rerun`) includes the full check, five targeted race repetitions and vulnerability scan;
  exited **0** after 379 seconds: all Go checks, **401 runtime tests, 915 frontend tests and ten notice tests**
  passed; all five targeted race repetitions passed; govulncheck again reported **No vulnerabilities found**.
  `go.sum` and both frozen pnpm lockfiles remained unchanged.
- Independent security review approved the patch and independently verified all fourteen advisory records, the
  official source commit and both legal-text hashes. Its chronology clarification is incorporated above.

No normal-profile app was launched, restarted or overwritten; no user data, Keychain, Application Support,
provider settings or real credentials were inspected. Tests use isolated fixtures. Native packaging, independent
review, browser gates and release publication are recorded separately in [v0.4.2 verification](v0.4.2.md).
This note records the implementation/toolchain gates, not native installation or permission evidence.

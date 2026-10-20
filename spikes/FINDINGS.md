# Phase 0 findings (2026-10-20)

All five spikes succeeded. No change to the architecture in PLAN.md. Details and numbers are below. The Wails spike
has its own write-up in [`wails-sse/FINDINGS.md`](wails-sse/FINDINGS.md).

| # | Question | Answer |
|---|---|---|
| 1 | Does SSE stream through the Wails v3 asset server on macOS? | **Yes.** It is incremental, with 0–3 ms latency, in dev and production builds, for both `EventSource` and `fetch` + reader. The writer implements `http.Flusher`, and a client close cancels `r.Context()`. |
| 2 | Does the runtime run on pi-durable's SQLite storage, single-writer, crash-safe? | **Yes.** All 185 runtime tests pass, including pi-durable's storage conformance suite, the HTTP contract suite against the real process, and SIGKILL mid-reply → restart → the reply completes. |
| 3 | Can the runtime ship as one file on a bundled Node? | **Yes.** `dist/runtime.mjs` is 1.2 MB (esbuild), with no `node_modules`. It starts in about 80 ms (70 ms with `NODE_COMPILE_CACHE`) and uses about 72 MB RSS per idle agent. The Node binary is 108 MB uncompressed. |
| 4 | Do stdio MCP, the probe and OAuth work through pi-mcp? | **Yes.** The probe works against `@modelcontextprotocol/server-everything` via npx from the bundle (13 tools). OAuth (DCR, PKCE, refresh rotation) was tested against a fixture server. |
| 5 | Does the workspace guard hold? | **Yes, for the file tools.** `..`, absolute paths, look-alike siblings, symlinks to files and directories, renames and writes through symlinked directories are all refused. A mutation check (guard disabled) fails three tests. `bash` is not confined by path, by design. |

## 2. Runtime on SQLite (`runtime/src/lib/storage/sqlite.ts`)

- **Opening.** `openSqliteAgentStorage({ path })` uses `node:sqlite` `DatabaseSync`. It sets
  `PRAGMA locking_mode=EXCLUSIVE` **before** `journal_mode=WAL`, so no `-shm` index is ever created, then runs
  `BEGIN IMMEDIATE; COMMIT` to take the lock at open.
- **Single writer.** It is wrapped in pi-durable's `NodeSqliteDatabase` and then `SqliteStorage.open`. A second
  opener, in the same process or another, gets `AgentOwnedElsewhereError` (the runtime exits 3) after 250 ms.
- **Crash recovery.** When the owner is killed, the OS drops the lock. The next open succeeds at once
  (test: < 1 s, no lease).
- **Concurrency.** Eight concurrent openers produce exactly one owner.
- **Process contract changes** (`process.ts`):
  - `AGENT_STORAGE` replaces `AGENT_SCHEMA`/`AGENT_DATABASE_URL`.
  - `PORT=0` is the default, and the runtime prints `PI_RUNTIME_READY {"port":N}`. Go reads the port from this line,
    so there is no `freePort` race.
  - With `RUNTIME_WATCH_STDIN=true` the runtime stops gracefully (exit 0) when stdin closes, so a crashed app never
    leaves an orphan writing to the storage.
- **Removed:**
  - `storage/postgres.ts`, `translate.ts`, `standby.ts`, `upgrade.ts` and the `pg` dependency.
  - The platform's upgrade check. Version pinning moves to the Go supervisor, which reads `piDurableVersion` at
    `/status`.

**UX finding.** After a kill mid-reply, the transcript holds the partial reply (`error: "Interrupted"`,
`stopReason: "aborted"`) and then the completed one. Phase 1 UI: fold an interrupted partial into the reply that
resumed it, within the same turn.

## 3. Bundling (`runtime/scripts/bundle.mjs`)

- esbuild settings: `platform: node`, `format: esm`, `target: node22.19`, minified, with a `createRequire` banner for
  CommonJS dependencies. Lazy pi-ai provider APIs are inlined.
- The probe runs from the same bundle: `node runtime.mjs mcp-probe`.
- **Cold start is not a problem.** The first measurement showed 1.8 s, but that was macOS scanning a *freshly copied
  unsigned* binary on its first run (bare `node -e 0` showed 1.4 s the same way). Signed inside the `.app`, the binary
  is scanned once at install.

## 4. MCP through pi-mcp (`runtime/src/lib/mcp.ts`, `probe.ts`)

`McpServerConfig` gains:
- `transport: "http" | "stdio"`
- `command`, `args`, `cwd`, `env`
- `oauth: { redirectUrl, clientName? }`

Go resolves secrets and paths before spawning, so the runtime never touches a secret store.

- **stdio.** pi-mcp's `StdioTransport`. Its stderr goes into the agent log at `[mcp <slug>]`, capped at 256 KiB.
- **OAuth store.** `appOAuthStore(MCP_OAUTH_URL, PLATFORM_KEY, slug)` does `GET`/`PUT` against the gateway. Go keeps
  the state in the keychain and must serialize saves per server.
- **The runtime never begins a sign-in.** `refreshOnlyStore` fails fast with `McpSignInRequiredError` when there are
  no tokens, and drops saves without tokens. The model gets "needs you to sign in … Open Pi Local, MCP servers".
  - **This bug was found by the tests.** Without the guard, an agent with no tokens registered a client with the
    authorization server and saved that registration, carrying its own redirect URI, which would have broken the
    later real sign-in.
- **Probe protocol** (`runtime.mjs mcp-probe`):
  - Input: one JSON request on stdin, `{server, signIn?, oauthUrl?, key?, timeoutMs?, callbackPort?}`.
  - Output: JSON lines on stdout, `authorize {url, redirectUrl}` → `signed-in` → `result {serverInfo, instructions, tools[{…, modelVisible}]}`,
    or `error {code: needs_sign_in|connect_failed|timeout|invalid_request, message, stderr?}`.
  - Exit codes: 0 for success, 1 for failure, 2 for a bad request.
- **Redirect URI stability.** Dynamic client registration records the probe's loopback redirect URI. Go must store it
  per server and pass it to agents (`oauth.redirectUrl`), and reuse the same `callbackPort` on re-sign-in. Otherwise a
  re-sign-in registers a new client, which works but is untidy.

## 5. Workspace guard (`runtime/src/lib/workspace.ts`)

- **Path checks.** `createWorkspaceEnv({ root, tempDir })` wraps `NodeExecutionEnv` in a Proxy. Every file operation
  resolves its path, follows symlinks through the deepest existing ancestor, and must land in `workspace/` or the
  agent's `tmp/`. Anything else returns `permission_denied`, and the model is told "outside the agent's workspace".
- **Temp files.** `AgentTempEnv` (a subclass) puts temp files in the agent's `tmp/`, including bash's own output
  spill files, which go through `this.createTempFile`. That way `read` can open them.
- **Agent wiring.** `WORKSPACE_DIR`, `WORKSPACE_TEMP_DIR` and `WORKSPACE_TOOLS=read,write,edit,bash` install exactly
  those tools as the `workspace` extension.
- **bash environment.** bash runs with cwd = workspace and an environment filtered to PATH, HOME, USER, LANG, TERM,
  TMPDIR, TZ and similar. Tested: `MODEL_API_KEY` and `*_TOKEN` don't reach it.
- **Residual risk.** `bash` can read and write anything the user can, and a symlink swapped between the check and the
  operation could escape. Only bash can create such a symlink, so both come down to bash. Policy for Phase 4:
  - bash is approval-gated by default
  - an optional macOS `sandbox-exec` profile later

## Notes for Phase 1

- **Wails:**
  - Mount `/api` with `AssetOptions.Middleware`.
  - Set `Content-Type` before the first write, and `Flush()` after every event.
  - Watch `r.Context().Done()`: writes after a disconnect are silently dropped.
  - Put shutdown work in `OnShutdown`: `app.Run()` doesn't return after Quit.
  - Pin `@wailsio/runtime`.
- **The Blob bug.** `Blob` request bodies arrive empty through the asset server (beta.22). The attachments upload
  (Phase 4) must send `await file.arrayBuffer()`.
- **No API in a plain browser during dev.** Under `wails3 dev` there is no TCP listener for `/api`, so a normal browser
  can't reach it. For Playwright e2e, run the same `http.Handler` on a loopback port in a headless test binary (already
  planned).

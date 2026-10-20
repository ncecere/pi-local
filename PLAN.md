# Pi Local: plan

A single-user desktop app (Go + Wails) that reuses the Pi Agent Interface chat UI. It creates, runs and manages Pi
Durable agents on the local machine, with one folder and one SQLite file per agent, and has first-class MCP support.

Sources reviewed:
- `~/projects/golang/pi-durable-platform` (v0.4.0): Go platform, TS runtime in `runtime/`
- `~/projects/pi-agent-interface` (v0.5.1): React chat UI and Hono server

## 0. Decisions made (2026-10-20)

| # | Question | Decision |
|---|---|---|
| 1 | Shell | **Wails v3** |
| 2 | Node | **Bundled** in the app (system Node in dev) |
| 3 | Workspace tools (files and bash) | **In v1**, guarded (Phase 4) |
| 4 | Window closed | **Keep running** in the tray; schedules fire; optional launch at login |
| 5 | Existing platform data | **Start fresh**, no import |
| 6 | Custom agent code | **Out of scope** for now; built-in kinds and `agent.yaml` only |
| 7 | MCP | **pi-mcp in the runtime.** The app owns the config and secrets and passes them to the runtime (§2, "MCP: why pi-mcp in the runtime") |

---

## 1. Key findings that shape the design

1. **pi-durable is already SQLite-native.** The platform's runtime wraps Postgres in a SQLite-shaped facade
   (`runtime/src/lib/storage/postgres.ts` → `SqliteStorage`). Locally we use `openNodeSqliteStorage(path)` from
   `@earendil-works/pi-durable/storage/sqlite/node`, which uses `node:sqlite` (Node ≥ 22.19). The whole Postgres
   layer goes away.
2. **pi-durable has no cross-process locking** ("one process owns a storage at a time", from its README). We must
   add our own single-writer guard. The platform's `pdp_ownership` table has a SQLite equivalent:
   `PRAGMA locking_mode=EXCLUSIVE` held from open, plus a per-agent lock file and an app single-instance lock.
3. **The runtime already has a seam for this.** `startAgent(config, definition, { storage, onFatal })` (`agent.ts`)
   takes an injected storage. A new entry point of about 30 lines (`local-main.ts`) replaces `process.ts`'s Postgres
   requirements.
4. **The agents must run in Node.** pi-durable, pi-ai and pi-mcp are TypeScript, so Go supervises Node processes,
   the same way the platform's `launcher.Local` does (`internal/agenthost/launcher/local.go`). Go owns everything
   else.
5. **pi-mcp 1.3.0 already supports stdio, Streamable HTTP and MCP OAuth.** The runtime uses only HTTP today
   (`runtime/src/lib/mcp.ts`), and the Go side is HTTP-only too (`internal/mcp/client.go`).
6. **The gateway callbacks are the part worth keeping.** These are `threads/sync`, `threads/report`,
   `approvals/report|sync` and `schedules`. They let the app list threads without waking an agent, show approvals of
   a hibernated agent, and run schedules. The upgrade check, standby/activate, model proxy, MCP identity and
   thread-MCP fetch can all be dropped.
7. **The chat UI ports cleanly.** Its only network choke points are `src/api/client.ts` (`request()`), `src/lib/sse.ts`
   and `use-platform-events.ts` (`EventSource`). Everything about auth, sessions and Connect is easy to separate.
   The renderers, inbox logic (`lib/inbox.ts`), windowing, scroll and markdown stack are reusable as-is.
8. **The UI's waiting list is now unblocked.** Platform v0.3–v0.4 added steer, approvals, paging, the delta stream,
   tool `details` and documents. The chat app never adopted them, so the local app gets them from day one. Message
   search becomes easy with FTS5 in a local DB. Attachments and edit/branch still need a design, but locally they're
   much simpler (see Phase 6 and Phase 7).

---

## 2. Architecture

```
┌──────────────────────────── Wails app (one Go process) ─────────────────────────────┐
│  Frontend (React 19, ported pi-agent-interface)                                      │
│     │  /api/*  (same-origin, via Wails AssetServer http.Handler)  + streams           │
│  ┌──▼───────────────────────────────────────────────────────────────────────────┐    │
│  │ internal/api       UI API (agents, threads, models, MCP, approvals, search…)  │    │
│  │ internal/supervisor spawn / health / wake / proxy / reap / restart  ◄─ launcher.Local │
│  │ internal/gateway   loopback callbacks from runtimes (threads, approvals,      │    │
│  │                    schedules, usage)                                          │    │
│  │ internal/mcp       MCP server catalog + secrets; builds each agent's MCP      │    │
│  │                    config; OAuth token store (served to runtimes); probes     │    │
│  │ internal/models    providers, discovery, keys in OS keychain                  │    │
│  │ internal/scheduler cron/one-shot triggers → POST message with requestId=fireId │    │
│  │ internal/appdb     app.db (SQLite, goose + sqlc): index, inbox, prefs, usage, FTS │
│  └──────────────┬───────────────────────────────┬──────────────────────────────┘    │
└─────────────────┼───────────────────────────────┼───────────────────────────────────┘
       spawn: env + MCP config, RUNTIME_TOKEN      │ gateway: reports, approvals, OAuth tokens
   ┌──────────────▼──────────┐  ┌─────────────────▼─────┐
   │ node runtime (agent A)  │  │ node runtime (agent B) │   … one process per *awake* agent
   │ local-main.ts           │  │                        │
   │ pi-mcp clients ─────────┼──┼──► stdio children /    │
   │                         │  │    remote MCP (HTTP)   │
   │ agents/A/state.sqlite   │  │ agents/B/state.sqlite  │
   └─────────────────────────┘  └────────────────────────┘
```

### Decisions (with reasons)

| Decision | Choice | Why / alternative |
|---|---|---|
| Desktop shell | **Wails v3** (beta.22 installed) | System tray and background running (schedules and long runs keep going when the window is closed), multi-window, `http.Handler` asset server. Fallback: v2 (stable, installed), losing the tray. Phase 0 spike decides. |
| Runtime process model | **One Node process per awake agent**, hibernated when idle | Proven contract, conformance tests and fault isolation, and `launcher.Local` ports almost as-is. A multi-agent host is possible later: nothing in `runtime/src` blocks it except `process.exit` calls. |
| Agent storage | `agents/<id>/state.sqlite` via `openNodeSqliteStorage`, `locking_mode=EXCLUSIVE` | Native pi-durable path. The OS drops the lock on crash, so there's no lease to wait for. |
| App storage | `app.db` (SQLite, `modernc.org/sqlite`, goose + sqlc like the platform) | Thread index, inbox state, prefs, providers/models metadata, MCP servers, approvals mirror, triggers, usage, FTS5. |
| Secrets | OS keychain (`zalando/go-keyring`), with optional `secrets.Box` sealing | Never in agent folders, never logged. Passed to runtimes only via env at spawn. |
| Model access | **Direct mode** (the runtime calls the provider) | The gateway proxy existed to hide keys from untrusted pods. Usage: the runtime's `countingUsage` posts to the local gateway `/usage`. |
| MCP | **pi-mcp inside each runtime.** Go owns the catalog and secrets and passes each agent a resolved config. | See "MCP: why pi-mcp in the runtime" below. |
| UI ↔ Go | Keep the `/api` HTTP shape, served by a Go `http.Handler` mounted in the Wails AssetServer | `client.ts` barely changes. The same handler runs headless for Playwright e2e and `httptest`. **Spike:** SSE streaming through the asset handler. If it buffers, streams go over Wails events behind a `subscribe()` adapter. |
| Stream format | Delta (`format=delta&v=1`) end to end | Already built and property-tested in `runtime/src/lib/delta.ts` (`applyDelta`). It replaces whole-view-per-token. |
| Runtime packaging | esbuild bundles `runtime/` into one `runtime.mjs`, embedded in the Go binary and extracted per version. **A pinned Node 22 binary ships inside the `.app`**; system Node in dev. | Nothing for the user to install. Bun's `node:sqlite` support is uncertain, so avoid it for storage. |

### MCP: why pi-mcp in the runtime

The Go hub I first proposed would mean a second MCP client in Go, its own OAuth implementation (where go-sdk is the
risky part), and an extra hop on every tool call. pi-mcp already has stdio, Streamable HTTP and OAuth, and it's
maintained alongside pi-durable.

What the Go hub would have given us, and how we get it without the hub:

| Hub benefit | How we get it with pi-mcp |
|---|---|
| Test a server and list its tools in the UI without an agent running | **Probe mode** in the same bundle: `node runtime.mjs mcp-probe` reads one server config on stdin and prints its `serverInfo`, tools and errors as JSON. Go runs it as a short-lived process (about 1 s). |
| OAuth tokens in the keychain, not in agent folders | The runtime's `McpOAuthStateStore` (`load`/`save`) calls the **gateway** (`GET/PUT /mcp/oauth/{server}`, agent token). Go keeps the state in the keychain. Saves are serialized per server, with compare-and-set, so two agents refreshing the same rotating refresh token can't clobber each other. |
| Interactive sign-in happens in the app, not mid-run | Signing in is a UI action: probe mode runs `McpOAuthProvider` with `OAuthCallbackServer` and prints the authorize URL, and Go opens the browser. A runtime that hits `McpOAuthAuthorizationRequiredError` gives the model a clear tool error and flags the server as "needs sign-in" through the gateway. It never opens a browser itself. |
| Share one stdio server process across agents | This is mostly not wanted locally. A per-agent process is the right default: per-agent `cwd` (e.g. a filesystem server rooted at `${workspace}`), isolation, and it dies with the agent when it hibernates. Heavy shared servers can run as HTTP servers instead. |
| Call log | The transcript already records every tool call. A small `mcp_calls` report through the gateway is optional. |

What the runtime needs (`runtime/src/lib/mcp.ts`):
- `StdioTransport` alongside `StreamableHttpTransport`
- `authProvider: adaptOAuthProvider(...)` for OAuth servers
- `${workspace}` / `${agentDir}` expansion in `command`, `args`, `cwd` and `env`
- stderr captured to the agent log, bounded

The existing rules stay: `mcp__<slug>__<tool>` naming, `modelVisible`, per-agent tool selection, `tool_search`
above 20 tools, and a 120 s call timeout.

Secrets reach the runtime only at spawn: header values and env values that reference `${secret:…}` are resolved by
Go into `MCP_SERVERS` in the child's environment. They are never written to disk or logged.

If many agents ever need to share a heavy server, a hub can be added later behind the same `MCP_SERVERS` contract,
since the runtime already speaks HTTP.

### On-disk layout

```
~/Library/Application Support/Pi Local/         (configurable data dir; single-instance flock here)
  app.db                                         index, inbox, prefs, providers, MCP, approvals, triggers, usage, FTS
  runtime/<version>/runtime.mjs                  extracted bundle
  agents/<agent-id>/
    agent.yaml                                   source of truth for the agent's config (portable, no secrets)
    state.sqlite(-wal)                           pi-durable storage (only its runtime ever opens it)
    workspace/                                   files the agent's tools may touch; attachments land here
    logs/runtime.log                             rotated
```

An agent folder is portable. You can copy it and "Import agent folder", and secrets are referenced by name
(`${secret:github_token}`). Importing a folder with stdio MCP commands means running someone else's code, so the UI
shows the commands and asks first.

### `agent.yaml` (template version and agent, merged)

```yaml
name: Research helper
kind: assistant                 # assistant | triage | researcher  (runtime/src/kinds)
kindSettings: {}
model: { provider: anthropic, id: claude-sonnet-4-5 }   # refs app-level providers
thinking: medium
instructions: |
  You are …
workspace: { tools: [read, edit, write, bash], shellEnv: minimal }
mcp:
  - server: github              # app-level MCP server slug → tools mcp__github__*
    tools: [search_issues, get_issue]   # omit = all
approvals: { tools: ["bash", "write", "mcp__github__create_*"], timeoutSeconds: 86400 }
schedules: { agentMade: true }
toolSearchAbove: 20
```

Platform template versions become **starter templates** (built-in YAML files). Version history can be a
`versions/` folder, or skipped at first.

---

## 3. What carries over, and from where

### From the platform (Go → `internal/*`)
| Platform | Local | Notes |
|---|---|---|
| `internal/agenthost/launcher/local.go` | `supervisor/launcher.go` | Clean env, `Setpgid`, `freePort`, `waitHealthy`, SIGTERM→20 s→SIGKILL. **Add** restart-on-exit-1 with backoff (the platform doesn't), treat 2 as a config error and retry 3. The child exits when its stdin closes, so a crashed app leaves no orphan writer. |
| `agenthost.Manager` wake/proxy/`ReapLoop`/`judge` | `supervisor/` | Per-agent wake mutex. Always re-resolve config at start (v0.3 fix). `/status` read through a 64 KiB cap. Idle 10 min, background ceiling 2 h, `POST /background/abort`. |
| Gateway handlers (`NewGatewayHandler`) | `gateway/` | Thread sync/report (a report never creates a thread: v0.2 fix), approvals report/sync, expiry loop, decision delivery with retries, cap of 100 pending, agent schedules with limits (20/agent, 5-min interval, 300 runs/day). |
| `internal/triggers` | `scheduler/` | robfig/cron v3, timezone, missed-fire `skip`/`run_once`, fire ID used as `requestId`, run finished from thread reports, auto-pause after 5 failures. Webhooks: later, maybe never. |
| `internal/llm` kinds and discovery | `models/` | Provider kinds table, `authenticate()`, `discover()`. Allow localhost (Ollama) and keep "no redirects". |
| `internal/mcp` header rules | `mcp/` (validation when saving a server) | ≤20 headers, reserved names, schema/size caps, `modelVisible`, slug regex, tool name `mcp__<slug>__<tool>` ≤64 chars. |
| `runtime/` | `runtime/` (vendored, trimmed) | Drop `storage/postgres.ts`, `translate.ts`, `standby.ts`, `pg`. Keep `define`, `agent`, `server`, `view`, `delta`, `approvals`, `schedule`, `subagent`, `background`, `kinds`, `testing/conformance`. |

### From the chat app (`src/` → `frontend/`)
- **Reuse as-is:**
  - `components/chat/*`, `agent/*`, `ui/*`, `command-palette/*`, `layout/sidebar*`
  - `lib/inbox.ts`, `chat-view.ts`, `paging.ts`, the markdown and streamdown patches
  - hooks: `use-windowed-rows`, `use-chat-scroll`, shortcuts
  - routes: `chat/home`, `chat/thread`, `settings/customization`, `settings/conversations`
- **Adapt:**
  - `api/client.ts`: no CSRF/session; a transport adapter
  - `lib/sse.ts` and `use-platform-events.ts`: one `subscribe()`
  - `use-agent-thread.ts`: delta format plus steer
  - `settings/agents.tsx` + `admin/agents.tsx` → the **Agents** manager
  - usage pages → local usage
  - `account.tsx` → "About and data location"
- **Drop:**
  - sign-in, `connect-gate`, `use-session` (replaced by a constant local user)
  - admin people, audit, overview and features, `use-admin`
  - `server/` entirely
- **Tests to keep:** all pure unit tests (`chat-view`, `inbox`, `inbox-store`, the markdown suites, `windowed-transcript`) and the e2e specs `chat`, `inbox`, `scale`, `a11y` and `search`. Rewrite `e2e/serve.mjs` to start the headless Go API with the runtime's demo model.

---

## 4. Lessons learned, as rules for the new code

**Carry over (proven right)**
1. Listing never wakes an agent: the app's thread index is updated from runtime reports.
2. Write the thread record before relaying the first message, and remove it if the runtime refuses.
3. `requestId` everywhere: chat sends, trigger fires (`fireId`), subagents. **New: store `requestId` on the user
   entry**, so the UI stops matching pending messages by the n-th occurrence of their text (`reconcile()` hack).
4. Committed before shown. Approval waits sit in `beforeTool`, so they survive hibernation.
5. Stable identity while streaming (`reuseUnchanged`, `reply-${turn}` IDs, pending rows keep their DOM identity).
6. Agent config changes **realign every thread** (`align`/`sameSelection` in `agent.ts`), or old threads fail
   with `no_model`.
7. Record the newest pi-durable version that wrote each `state.sqlite`, and refuse to open it with an older
   runtime. This matters more locally, since folders move across app updates.

**Pitfalls not to re-introduce**
- A late report resurrecting a deleted thread.
- A deleted, reserved thread that can't be removed.
- A stale config used by an in-flight wake.
- A hidden window's stream keeping an agent awake.
- A reply that finishes between two views, so "busy → false" is never seen.
- Unbounded `/status` reads.
- Approval redaction over-matching keys containing "key" or "auth".
- Unbounded agent-made schedule chains.
- Rendering 2,000 sidebar rows (keep the 40-per-shelf paging).
- Shiki and Mermaid loading eagerly (keep the lazy load plus preload).
- Stopping a thread doesn't stop its background subagents (known limit): handle it locally or document it.

**Delete (only existed for multi-tenancy)**
- OIDC, dev personas, Connect/OAuth server, teams, roles, service accounts, API keys, visibility.
- Audit for others, staff reads.
- Postgres schema/role per agent.
- k8s and Agent Sandbox launchers, warm pools, NetworkPolicies.
- Model and MCP proxies as security boundaries, MCP identity JWTs.
- Prometheus, rate limits, `doctor`, `rekey`.
- SSRF guard for team URLs.

**New risks that only exist locally**
- **Workspace tools are not a sandbox.** `NodeExecutionEnv({cwd})` happily resolves absolute paths, and `bash` runs as
  the user. Mitigations:
  - a `beforeTool` path guard (realpath inside `workspace/`)
  - `bash` and `write` approval-gated by default
  - a minimal `shellEnv`, so no keys leak
  - later, an optional macOS `sandbox-exec` / bubblewrap `ExecutionEnv`
- **Prompt injection is more dangerous** when MCP results can reach bash: approvals matter more here, not less.
- **stdio MCP servers run as the user.** Show the command on add and import.

---

## 5. Phases

Each phase ends with a demoable milestone and its checks: `go test`, runtime conformance, `vitest`, Playwright.

### Phase 0: Spikes ✅ done 2026-10-20, all passed (see `spikes/FINDINGS.md`)
1. **Wails v3 hello world:** an `http.Handler` asset server serving `/api`, and **SSE through it on macOS
   (WKWebView)**. Measure whether it streams or buffers. Fallback: Wails events. Also check the tray, and closing
   the window without quitting.
2. **Runtime on SQLite:** `local-main.ts` with `openNodeSqliteStorage` and `locking_mode=EXCLUSIVE`. Run
   `registerRuntimeConformance` against it. Kill -9 mid-reply and confirm it resumes. Confirm a second open gets exit 3.
3. **Packaging:** bundle the runtime with esbuild into one file and run it on a downloaded Node 22 binary. Check the
   size and cold start (target < 1.5 s).
4. **MCP through pi-mcp:**
   - Add `StdioTransport` to `AgentMcp` and run `@modelcontextprotocol/server-everything` from an agent.
   - Build `mcp-probe` mode.
   - Do one OAuth sign-in against a real remote server, with the token store going through a stub gateway.
5. **Workspace guard:** a `beforeTool` hook that resolves symlinks and refuses paths outside `workspace/` for
   `read`/`write`/`edit`. Try escaping it (`..`, absolute paths, symlinks).

### Phase 1: Skeleton ✅ done 2026-10-20 (chat with local agents)
- Repo scaffold (below), `app.db` migrations, data dir and single-instance lock.
- Supervisor: spawn, health, proxy, reap, restart. Gateway: threads sync/report.
- Port the frontend with auth stripped and the transport adapter. Demo model.
- **Milestone:** create an agent, chat, quit the app mid-reply, reopen, and the reply finishes. The sidebar lists
  threads without waking the agent.
- **Done.** `internal/app/app_test.go` proves the milestone against the real runtime, along with these:
  - hibernation; listing never wakes an agent
  - a crash (SIGKILL) restarts the agent and finishes the reply
  - a refused first message leaves no thread
  - rename/delete; a config change restarts an awake agent
  - live events; one app per data directory; prefs
- **Checked by hand.** In a browser (headless server) and in the desktop app started from a Finder-like environment
  (`PATH=/usr/bin:/bin`, so Node is found through the login shell): create an agent, chat, streaming, the inbox, and
  SIGTERM → a graceful stop of every runtime.
- **Carried forward:**
  - Node isn't bundled yet; the app uses the login shell's PATH (Phase 8).
  - The approvals gateway answers 404 (Phase 4); the runtime logs `approvals sync: status 404` at each start.
  - The UI still uses whole-view streams (Phase 6).
  - One runtime approvals test is load-sensitive (a 5 s timeout) and can fail when the machine is busy.

### Phase 2: Models ✅ done 2026-10-20
- Providers (OpenAI, Anthropic, OpenAI-compatible/Ollama/LiteLLM), keychain keys, discovery, per-agent model.
- Allow the model to be chosen per agent. Later, per thread: register several models in `createAgentModels`.
- Relax `MODEL_API_KEY` for keyless Ollama.
- Usage via `countingUsage` → gateway `/usage` → `app.db`, shown as a Settings → Usage page with prices.
- **Done:**
  - `internal/models` (catalog, presets, discovery, runtime env), `internal/secrets` (OS keychain), `internal/usage`
  - the Models and Usage pages, and a model picker per agent
  - keyless servers get a placeholder key (no runtime change)
  - the supervisor restarts an agent whenever its resolved environment changes (a fingerprint), so a rotated key or
    an edited model takes effect at once
  - a removed or disabled model stops its agents with a reason, until they get another
- **Tested:**
  - end to end against fake OpenAI chat-completions and Anthropic Messages servers (the real streamed wire formats):
    the key reaches the provider and never lands in `app.db` or the agent's folder; extra headers; discovery; usage
    and cost; key rotation; in-use protection; discovery error messages
  - checked by hand in the real UI: add a provider, find models, set the default, make an agent, chat, usage
  - the real macOS keychain (set/get/delete) checked once
- **Found and fixed:**
  - `app.db` has one connection, so a query nested inside an open row loop deadlocks. `usage.Report` did this.
    Rule: read the rows, close them, then query.
  - The agent store and the catalog called each other under a lock. Changes are now serialized outside the read lock.
- **Dev:** `pi-local-server -secrets memory` keeps keys out of the real keychain (`make run-server` uses it).
- **Carried forward:** a model per thread (chat-level picker) instead of per agent; prices for known models
  (manual for now).

### Phase 3: Agent manager
- Create (from starter templates), edit `agent.yaml` in a form, raw YAML view, duplicate, delete, import/export folder.
- Kinds: assistant, triage, researcher, with `kindSettings` forms (borrow `web/src/pages/templates/kind-fields`).
- A config save restarts the agent if it is awake, and realigns its threads.
- Agent status (asleep, awake, busy, error), log viewer, "wake / hibernate now".

### Phase 4: Workspace tools and files (v1)
- Per-agent `workspace/`.
- `createCodingTools` with `NodeExecutionEnv({cwd: workspace, shellEnv: minimal})`, plus the path guard hook.
- **Default approvals:** `bash`, `write` and `edit` need approval. Per-agent policy: "ask every time", "allow in
  workspace" or "allow all", with a visible warning on the last.
- Bounded bash output (already in pi-durable), and a process-group kill on stop and hibernate.
- **Attachments:** dropped files are copied into `workspace/attachments/…`, and the message references them. Images
  go to vision models via `createNodePhotonImages`.
- "Open workspace in Finder", and a simple file browser panel.
- Later: an optional macOS `sandbox-exec` profile as an `ExecutionEnv` wrapper.

### Phase 5: MCP (pi-mcp in the runtime)
- App-level MCP server catalog in `app.db`:
  - **stdio:** command, args, env, cwd, with `${workspace}` and `${secret:…}` expansion
  - **Streamable HTTP:** URL, header secrets, OAuth
- Per-agent selection of servers and tools in `agent.yaml`.
- "Test" and "List tools" via `mcp-probe`. "Sign in" for OAuth servers, with tokens in the keychain via the gateway
  store. A "needs sign-in" badge when a runtime reports it.
- `tool_search` above 20 tools; hide model-invisible tools.
- stdio stderr goes to the agent log. A failed server is reported as a degraded status, and the agent still runs.
- Import from Claude Desktop / Cursor / VS Code `mcp.json` (cheap and very handy).
- Show the full command before the first run of any stdio server added by import.

### Phase 6: Chat features the platform unlocked
- Delta stream in `use-agent-thread` (port `applyDelta`, keep the property test).
- **Steer** (`whenBusy: "steer"`) from the composer while busy.
- **Tool approvals:** inline card in the transcript, a global approvals inbox in the sidebar (pushed, not polled),
  OS notification, deny on timeout.
- Tool `details` rendering, exposed documents panel (triage queue, research plan and sources).
- Paging for long conversations (`limit`/`before`).

> Approvals are needed by Phase 4 (workspace tools), so the approval card and the gateway's approval handlers move
> forward into Phase 4. The rest of Phase 6 can run in parallel with Phase 5.

### Phase 7: Always-on and search
- **Tray app:** closing the window keeps the Go process, the scheduler and awake agents running. The tray shows busy
  agents and pending approvals, and has Open and Quit. Quit stops agents gracefully: SIGTERM, and work stays pending in
  storage.
- Optional launch at login (a `SMAppService` login item).
- Schedules: agent-made schedules (`PLATFORM_SCHEDULES`) plus user-made ones in the UI. Missed fires (machine asleep
  or app quit) follow `skip`/`run_once` on next launch.
- OS notifications for a finished scheduled run, an approval request, and an agent error.
- **Search:** FTS5 over message text in `app.db`, indexed when a reply finishes (Go reads the view while the agent is
  still awake). It covers every conversation, with no privacy trade-off locally.
- **Edit and branch:** edit-and-resend as a fork at the entry (`conversation.fork(entryId)`) into a new thread
  linked to its parent.

### Phase 8: Ship
- macOS signing and notarization, auto-update, the upgrade check across app versions, crash and log bundle export.
- Bundle Node per architecture (arm64 and x64, or universal) and check its license notice.
- Then Windows and Linux: pi-mcp uses `cross-spawn`, `node:sqlite` is cross-platform, and the keychain works on all three.

### v1 scope
Phases 0–7 (chat, models, agent manager, workspace tools, MCP, approvals, steer, delta, tray and schedules, search).
Edit/branch and the documents panel can slip to v1.1 without blocking anything.

---

## 6. Repo layout

```
pai-local/
  main.go                     Wails bootstrap, tray, windows
  internal/
    app/                      wiring, data dir, single-instance lock
    appdb/                    migrations/ (goose), queries/ (sqlc), dbgen/
    api/                      http.Handler for the UI (+ OpenAPI spec → TS types, as both repos do)
    supervisor/               launcher, wake, proxy, reap, restart, logs
    gateway/                  runtime callbacks (threads, approvals, schedules, usage)
    agents/                   agent.yaml load/validate/save, folders, starter templates, import/export
    models/                   providers, discovery, keychain
    mcp/                      server catalog, config builder, secret expansion, probe runner, OAuth token store
    scheduler/                cron and one-shot triggers
    search/                   FTS5 indexing
    secrets/                  keychain wrapper
  runtime/                    TS: vendored @pdp/runtime, local-main.ts, mcp-probe, esbuild bundle
  frontend/                   React: ported pi-agent-interface src/
  e2e/                        Playwright against headless Go API + demo model
```

---

## 7. Still open

1. **Name:** "Pi Local" is a placeholder.
2. **"Allow all" for bash:** should the app offer it at all, or always require an approval or a workspace-only policy?
3. **Shared heavy MCP servers:** if this comes up, add a hub behind `MCP_SERVERS` later (not planned).

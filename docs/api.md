# The UI API (`/api`)

The frontend calls the Go backend only through this API. The Wails app serves it same-origin through the asset
server, and the headless dev/test server (`cmd/pi-local-server`) serves it on a loopback port. The shapes follow the
Pi Agent Interface's server (`~/projects/pi-agent-interface/server/app.ts`) minus everything about sign-in, so the
ported frontend changes as little as possible.

**Conventions**
- Success: `{"data": …}`. Error: `{"error": {"code", "message", "details"?}}`.
- JSON bodies are at most 256 KiB.
- There is no CSRF token or cookie. The app has one local user. The headless server binds to loopback only.
- Thread IDs: 1–64 of `[A-Za-z0-9_-]`; otherwise `400 invalid_thread_id`. Agent IDs: `ag_` + 16 lowercase base32
  characters; an unknown one is `404 not_found`.
- Times: `Agent.*At` are ISO 8601 strings. `AgentThread.*At` are Unix ms (numbers), as in the platform's shapes.

## Session (compatibility)

| Route | Answer |
|---|---|
| `GET /api/me` | `{user: {id: "local", name, email: "", role: "admin"}, csrfToken: "", features: {}, platform: {mode: "local", account: null}}`. `name` is the OS user's full name. |
| `GET /api/auth/config` | `{oidcEnabled: false, devAuthEnabled: false, devAccounts: [], instance: {name: "Pi Local", logoUrl: null, colorTheme: "neutral", defaultTheme: "system", orgName: "", supportUrl: null}}` |
| `GET /api/me/prefs` | `Record<key, object>`: every saved preference. |
| `PUT /api/me/prefs/{key}` | Body `{value: object}`. Keys: `inbox` (≤ 512 KiB), `appearance` (≤ 16 KiB); any other key is `404 unknown_pref`. Answers `{ok: true}`. |

## Agents

```ts
type Agent = {
  id: string;                 // "ag_…"
  name: string;               // 1–60 chars, one line
  description: string;        // ≤ 500 chars
  instructions: string;       // ≤ 20,000 chars; empty: the kind's default prompt
  kind: "personal";           // the chat UI's grouping; every local agent is the person's own
  agentKind: "assistant" | "triage" | "researcher";   // what it is (runtime kind)
  status: "asleep" | "starting" | "awake" | "error";  // its runtime process
  running: boolean;           // status is "awake"
  lastError?: string | null;  // why it last failed to start (status "error")
  model: { id: string; name: string; provider: string } | null;  // Phase 1: the demo model
  enabled: boolean;           // always true in Phase 1
  lastUsedAt: string | null;
  revision: number;           // bumped on every config change
  createdAt: string;
  updatedAt: string;
};
```

| Route | Answer |
|---|---|
| `GET /api/agents` | `Agent[]`, newest first. Never starts a runtime. |
| `GET /api/agents/catalog` | `{templates: [{id, name, description}], models: [{id, name}], defaultModelId, allowModelChoice: true, limit: 1000, used}`. Templates are the kinds (`assistant`, `triage`, `researcher`). Models are `demo/demo-1` in Phase 1. |
| `POST /api/agents` | Body `{name, description?, templateId?, modelId?, instructions?}`. `201 Agent`. Errors: `400 invalid_name`, `invalid_template`, `invalid_model`. |
| `PATCH /api/agents/{id}` | Body `{name?, description?, modelId?, instructions?}`. Answers `Agent`; fields left out are unchanged (an empty body changes nothing but the revision). A change restarts the agent's runtime if it is awake. |
| `DELETE /api/agents/{id}` | Stops its runtime and moves its folder to the OS trash (or deletes it). Answers `{ok: true}`. |

## Threads

```ts
type AgentThread = {
  threadId: string;
  title: string;              // the first line of the first message (≤ 60 chars) unless renamed
  createdAt: number;          // Unix ms
  updatedAt: number;
  busy: boolean;
  lastReplyAt?: number | null;
  lastError?: string | null;
  visibility: "private";      // compatibility
  createdBy: null;
  participants: [];
};
```

| Route | Answer |
|---|---|
| `GET /api/agents/{a}/threads` | `AgentThread[]`, newest activity first. From the app's own index: **never starts the runtime.** |
| `GET /api/agents/{a}/threads/{t}` | The runtime's `ChatView` (`runtime/src/lib/view.ts`), passed through. Starts the runtime if it is asleep. `?limit=&before=` pages. |
| `GET /api/agents/{a}/threads/{t}/events` | SSE from the runtime, passed through: `view` events (the whole ChatView), or with `?format=delta&v=1` a `snapshot` then changes (`runtime/src/lib/delta.ts`). `Last-Event-ID` is forwarded. Starts the runtime. |
| `POST /api/agents/{a}/threads/{t}/messages` | Body `{text, requestId, whenBusy?: "followUp" \| "steer"}`, at most 32,000 characters. `202 {submissionId}`. Creates the thread on first use: the app records the thread *before* relaying, and removes the record if the runtime refuses. |
| `POST /api/agents/{a}/threads/{t}/stop` | `202 {ok: true}` |
| `PATCH /api/agents/{a}/threads/{t}` | Body `{title}` (1–200 chars, one line). Answers `AgentThread`. Stored by the app; doesn't start the runtime. |
| `DELETE /api/agents/{a}/threads/{t}` | Deletes it in the runtime (starting it if needed) and in the index. Answers `{ok: true}`. |

## Live events

`GET /api/events` is SSE for every agent's threads:
- `event: ready`, `data: {}` on connect
- `event: thread`, `data: {agentId, threadId, deleted: boolean, thread?: AgentThread}` on every change to an indexed
  thread (created, renamed, started, finished, failed, deleted). `busy` changes come from the message being sent and
  from the runtime's reports (end of a reply, and every thread at each runtime start).
- `event: agent`, `data: {agentId, deleted: boolean, agent?: Agent}` when an agent changes (created, renamed, status)
- `event: resync`, `data: {}` when events may have been missed; the lists should be read again
- `: keep-alive` every 15 s

## Models and providers (Phase 2)

A **provider** is an account at a model service: OpenAI, Anthropic, or anything speaking one of their APIs (Ollama,
LM Studio, LiteLLM, OpenRouter, vLLM …). Its key and header values live in the OS keychain; the API never returns them.
A **model** is one of a provider's models that agents may use. Its ID is `"<provider>/<modelId>"`, split at the first
`/` (`openrouter/anthropic/claude-sonnet-4` is model `anthropic/claude-sonnet-4` of provider `openrouter`). The demo
model `demo/demo-1` always exists and needs nothing.

```ts
type ProviderKind = { id: "openai" | "anthropic" | "openai-compatible" | "openai-responses" | "anthropic-compatible";
  name: string; api: string; defaultBaseUrl: string | null };
type ProviderPreset = { id: string; name: string; kind: string; baseUrl: string; needsKey: boolean; note: string };
type Provider = {
  id: string;                  // slug: 1–32 of [a-z0-9-], unique; what agent.yaml names
  name: string;                // 1–60 chars
  kind: ProviderKind["id"];
  baseUrl: string;             // http(s); http only for loopback/LAN servers
  hasKey: boolean;             // a key is stored
  headerNames: string[];       // extra request headers (their values are secret)
  enabled: boolean;
  models: Model[];             // the models agents may use, by name
  createdAt: string; updatedAt: string;
};
type Model = {
  id: string;                  // "<provider>/<modelId>"
  provider: string; modelId: string;
  name: string;                // 1–100 chars
  contextWindow: number;       // tokens, default 128000
  maxTokens: number;           // output tokens, default 16000
  reasoning: boolean; images: boolean;
  inputPrice: number | null;   // USD per million tokens; null: unpriced
  outputPrice: number | null;
  enabled: boolean;
  usedBy: number;              // agents on this model
};
```

| Route | Answer |
|---|---|
| `GET /api/providers` | `{kinds: ProviderKind[], presets: ProviderPreset[], providers: Provider[], defaultModelId}` |
| `POST /api/providers` | Body `{id?, name, kind, baseUrl?, apiKey?, headers?: Record<string,string>}` (`id` defaults to a slug of the name; `baseUrl` to the kind's default). `201 Provider`. Errors: `invalid_id`, `id_taken`, `invalid_name`, `invalid_kind`, `invalid_base_url`, `invalid_headers`. |
| `PATCH /api/providers/{p}` | Body `{name?, baseUrl?, apiKey?, headers?, enabled?}`. `apiKey: ""` removes the key; `headers` replaces them all. Answers `Provider`. Agents using it restart on the change. |
| `DELETE /api/providers/{p}` | `{ok: true}`. `409 in_use` with `details.agents: [{id, name}]` while agents use one of its models. |
| `POST /api/providers/{p}/discover` | Lists the provider's models from its API: `{models: [{modelId, name, contextWindow: number \| null, added: boolean}]}`. `502 discovery_failed` with a message for people. |
| `PUT /api/providers/{p}/models/{modelId...}` | Adds or changes a model. Body `{name?, contextWindow?, maxTokens?, reasoning?, images?, inputPrice?, outputPrice?, enabled?}`. Answers `Model`. |
| `DELETE /api/providers/{p}/models/{modelId...}` | `{ok: true}`, or `409 in_use` as above. |
| `PUT /api/settings/default-model` | Body `{modelId}`: the model new agents get. Answers `{defaultModelId}`. |

`GET /api/agents/catalog` lists every enabled model of every enabled provider (and the demo model), as
`{id, name, provider, providerName}`, with `defaultModelId`. An agent whose model was removed or turned off keeps it in
`agent.yaml`; it fails to start (`status: "error"`, `lastError` says which model) until it is given another.

### Usage

`GET /api/me/usage?days=7|30|90` (default 30):

```ts
type UsageTotals = { requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number;
  cacheWriteTokens: number; costUsd: number; unpricedRequests: number };   // unpricedRequests: not in costUsd
type UsageReport = { from: string; to: string; days: number;               // dates, YYYY-MM-DD, local time
  total: UsageTotals;
  agents: (UsageTotals & { agentId: string; name: string })[];             // deleted agents keep their last name
  models: (UsageTotals & { modelId: string; name: string })[];
  byDay: (UsageTotals & { day: string })[] };                              // every day of the range, zeros included
```

## Agent manager (Phase 3)

`Agent` gains:

```ts
  kindSettings: Record<string, unknown>;   // the kind's settings (triage: listTools, readTools, writeTools, approveWrites;
                                           // researcher: backgroundSubagents, maxPlanSteps); {} for none
  canCall: string[];                       // agent IDs this agent may ask (ask_agent), besides what its teams allow
  callable: { id: string; name: string; via: "direct" | "team" }[];   // everyone it may ask, all rules applied
  dir: string;                             // its folder on disk
  piDurableVersion: string | null;         // the newest runtime that wrote its storage
```

| Route | Answer |
|---|---|
| `PATCH /api/agents/{id}` | Also takes `kindSettings?` (object, ≤ 16 KiB of JSON) and `canCall?` (agent IDs; unknown IDs and the agent itself are refused with `400 invalid_can_call`). |
| `GET /api/agents/{id}/config` | `{yaml}`: its `agent.yaml` as text. |
| `PUT /api/agents/{id}/config` | Body `{yaml}`. Replaces the configuration. `400 invalid_yaml` (message says where), or the same validation codes as PATCH. Answers `Agent`. |
| `POST /api/agents/{id}/duplicate` | Body `{name?}` (default "<name> copy"). A new agent with the same configuration and no conversations. `201 Agent`. |
| `POST /api/agents/{id}/wake` | Starts its runtime now. Answers `Agent`, or `503 agent_unavailable`. |
| `POST /api/agents/{id}/sleep` | Hibernates it now (work in flight stays pending and resumes on its next start). Answers `Agent`. |
| `GET /api/agents/{id}/logs?lines=N` | `{path, lines: string[]}`: the last N lines of its runtime log (default 300, at most 2000). |
| `GET /api/agents/{id}/export?conversations=true\|false` | A zip of the agent's folder (`agent.yaml`, and with conversations `state.sqlite`; never logs or tmp). With conversations the agent is put to sleep first. `Content-Disposition: attachment`. |
| `POST /api/agents/import` | Body: the zip's bytes (`Content-Type: application/zip`, at most 1 GiB; send an ArrayBuffer, not a Blob: Wails drops Blob bodies). A new agent (a new ID) from it, with its conversations when the zip has them. `canCall` is cleared (IDs are local to one computer). `201 Agent`. `400 invalid_archive` with a message. |
| `GET /api/about` | `{version, dataDir, runtime: {node, nodeVersion, piDurableVersion, contractVersion}, agents: number}` |
| `POST /api/reveal` | Body `{target: "data"}` or `{target: "agent", agentId}` or `{target: "workspace", agentId}`: opens the folder in Finder. `{ok: true}`. |

## Teams and agents asking agents (Phase 3)

An agent may **ask** another agent: its model gets the tools `list_agents` (who it may ask) and
`ask_agent({agent, message, conversation?: "continue" | "new"})`, which sends the message to that agent and returns
its reply. Each asked agent answers in its own conversation, listed under it like any other (`AgentThread.calledBy`
says who asked), so what agents say to each other can always be read. Who may ask whom:

- the agents in an agent's `canCall`;
- a team's **lead** may ask every member; with `membersTalk`, members may ask each other (and the lead).

Asks are limited: never itself, no cycles (an agent already in the chain of asks can't be asked again), at most 3
agents deep, and at most 20 asks per reply.

```ts
type Team = {
  id: string;              // "tm_…"
  name: string;            // 1–60 chars
  description: string;     // ≤ 500 chars
  leadId: string;          // the agent people chat with for the team
  memberIds: string[];     // other agents (not the lead), 1–20
  membersTalk: boolean;    // members may ask each other and the lead
  createdAt: string; updatedAt: string;
};
```

| Route | Answer |
|---|---|
| `GET /api/teams` | `Team[]` |
| `POST /api/teams` | Body `{name, description?, leadId, memberIds, membersTalk?}`. `201 Team`. Errors: `invalid_name`, `invalid_lead`, `invalid_members`. |
| `PATCH /api/teams/{id}` | Any of those fields. Answers `Team`. |
| `DELETE /api/teams/{id}` | `{ok: true}`. Its agents stay. |

Deleting an agent removes it from teams (a team whose lead is deleted is deleted) and from every `canCall`.

`AgentThread` gains `calledBy: {agentId, name, threadId} | null`: the agent (and its conversation) that asked in this
thread. Live events: `event: team`, `data: {teamId, deleted, team?}`.

In a conversation, an `ask_agent` tool call's `details` (ChatMessage tool results / ChatTool) are
`{agentId, agentName, threadId}`, so the UI can link to the asked agent's conversation.

## Workspace tools, approvals and attachments (Phase 4)

Each agent has a **workspace** folder (`<agent>/workspace`). Its file tools (`read`, `write`, `edit`) can't reach
outside it; `bash` runs in it with a minimal environment, but a shell can reach anything you can, so it asks first by
default. **Approvals** make an agent ask before chosen tools run: the call waits (also while the agent sleeps, and
across restarts of the app) until you approve or deny it, or it times out (denied).

`Agent` gains:

```ts
  workspace: { tools: ("read" | "write" | "edit" | "bash")[] };   // none: no file tools
  approvals: { tools: string[]; timeoutSeconds: number };          // tool names or patterns with *; 60 s – 30 days
  pendingApprovals: number;                                        // waiting for you now
```

`PATCH /api/agents/{id}` takes `workspace?` and `approvals?` (the same shapes). Errors: `invalid_workspace_tools`,
`invalid_approval_tools` (at most 100 patterns of 1–200 of `[A-Za-z0-9_.*-]`), `invalid_approval_timeout`.

The UI offers three presets for an agent with tools (it may also edit the list):
- **Ask first**: approvals `["bash", "write", "edit"]` (the default when tools are turned on)
- **Ask for commands**: approvals `["bash"]`
- **Don't ask**: no approvals for its workspace tools (show a warning: the agent can then change files and run
  commands on its own)

```ts
type Approval = {
  id: string;                 // "ap_…", unique within its agent
  agentId: string; agentName: string;
  threadId: string | null;
  tool: string;
  arguments: unknown;         // a redacted, bounded view of the call's arguments
  summary: string | null;     // why it asks, when the agent's code says
  status: "pending" | "approved" | "denied" | "timed_out" | "cancelled";
  requestedAt: number;        // Unix ms
  expiresAt: number;
  decidedAt: number | null;
  reason: string | null;      // given with a decision; the model reads it on denial
};
```

| Route | Answer |
|---|---|
| `GET /api/approvals?status=pending\|all` | `Approval[]` across agents, newest first (default pending; `all`: the last 200). |
| `GET /api/agents/{a}/approvals?thread=` | One agent's, pending first. |
| `POST /api/agents/{a}/approvals/{id}` | Body `{decision: "approve" \| "deny", reason?}` (reason ≤ 1000 chars). Answers `Approval`. `409 approval_decided` when it no longer waits. The decision reaches the agent at once (waking it). |

Live events: `event: approval`, `data: {agentId, approval: Approval}` whenever one is asked or changes. In a
thread's view, `ChatView.approvals` lists its pending requests and a tool call carries `approval` (runtime view.ts).

### Attachments

| Route | Answer |
|---|---|
| `POST /api/agents/{a}/attachments?name=<file name>` | Body: the file's bytes (any Content-Type; at most 100 MiB; send an ArrayBuffer, never a Blob). Saved in the workspace under `attachments/<YYYY-MM-DD>/<name>` (a ` (2)` suffix when the name is taken). `201 {path, name, size, mediaType}` (`path` relative to the workspace). `409 no_read_tool` when the agent doesn't have the `read` tool (it couldn't open it). |

The composer sends the message with a line per file after the text:

```
Attached files (in your workspace):
- attachments/2026-10-20/report.pdf (120 KB)
```

## MCP servers (Phase 5)

The app keeps a catalog of MCP servers; each agent chooses which it uses (and, optionally, which of their tools).
Agents connect to them themselves (pi-mcp in the runtime): a **stdio** server is a program the agent's runtime starts
(it runs as you: only add commands you trust), an **http** server is a remote Streamable HTTP endpoint, with header
values or an OAuth sign-in. Env and header values and OAuth tokens are kept in the OS keychain and never returned.
An agent's tools from a server are named `mcp__<slug>__<tool>`.

```ts
type McpTool = { name: string; title: string | null; description: string | null; modelVisible: boolean };
type McpServer = {
  slug: string;                 // 1–32 of [a-z0-9_] (no leading/trailing _): the tool prefix
  name: string;                 // 1–60 chars
  description: string;
  transport: "stdio" | "http";
  command: string | null;       // stdio
  args: string[];               // stdio; may use ${workspace} (the agent's workspace) and ${agentDir}
  cwd: string | null;           // stdio; default ${workspace}
  envNames: string[];           // stdio; values are secret
  url: string | null;           // http
  headerNames: string[];        // http; values are secret
  oauth: boolean;               // http: sign in with OAuth
  signedIn: boolean;            // oauth: tokens are stored
  enabled: boolean;
  tools: McpTool[];             // from the last successful test; agents get these (model-visible ones)
  testedAt: number | null;      // Unix ms
  lastError: string | null;     // the last test's error (with stderr's tail for stdio)
  usedBy: { id: string; name: string }[];
  importedFrom: string | null;  // "claude", "cursor", "vscode"
  createdAt: string; updatedAt: string;
};
```

| Route | Answer |
|---|---|
| `GET /api/mcp/servers` | `McpServer[]` |
| `POST /api/mcp/servers` | Body `{slug?, name, description?, transport, command?, args?, cwd?, env?: Record<string,string>, url?, headers?: Record<string,string>, oauth?}` (slug defaults from the name). Tests it right away (`tools`/`lastError` filled in). `201 McpServer`. Errors: `invalid_slug`, `slug_taken`, `invalid_name`, `invalid_transport`, `invalid_command`, `invalid_url` (https, or http on this computer/network), `invalid_headers`, `invalid_env`. |
| `PATCH /api/mcp/servers/{slug}` | The same fields (not slug); `env`/`headers` replace all values. `enabled?`. Answers `McpServer`. Agents using it restart. |
| `DELETE /api/mcp/servers/{slug}` | `{ok: true}`; `409 in_use` with `details.agents` while agents use it. Its keychain items go too. |
| `POST /api/mcp/servers/{slug}/test` | Connects (stdio: starts it) and lists its tools, at most 60 s: `McpServer` with `tools`/`testedAt` or `lastError`. An OAuth server that needs a sign-in says so in `lastError` (`needs_sign_in`). |
| `POST /api/mcp/servers/{slug}/sign-in` | OAuth: starts a sign-in in the browser (the app opens it) and answers at once `{authorizeUrl}`; the outcome comes as an `mcp` live event (the server, `signedIn` and `tools` updated, or `lastError`). Up to 5 minutes. |
| `POST /api/mcp/servers/{slug}/sign-out` | Forgets its OAuth tokens. `McpServer`. |
| `GET /api/mcp/import` | Servers found in other apps' configs: `{sources: [{id: "claude" \| "cursor" \| "vscode", path, servers: [{name, transport, command?, args?, url?, envNames: string[], exists: boolean}]}]}` (`exists`: a server with that slug is already here; `unsupported`: why it can't be imported), and `searched`: every path looked at. |
| `POST /api/mcp/import` | Body `{source, names: string[]}`: adds those servers (with their env/header values), each tested. `{servers: McpServer[], skipped: [{name, reason}]}`. |

`Agent` gains `mcp: {server: string; tools: string[] | null}[]` (tools null: all its model-visible tools), set with
`PATCH /api/agents/{id}` `{mcp}` (`400 invalid_mcp`: an unknown server). An agent whose server is off or untested
starts without it (its log says so).

Live events: `event: mcp`, `data: {slug, deleted, server?: McpServer}`.

## Not yet (later phases)

Message search (Phase 7), the delta stream in the UI (Phase 6), 

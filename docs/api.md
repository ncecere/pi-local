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
| `GET /api/me` | `{user: {id: "local", name, email: "", role: "admin"}, csrfToken: "", features: {messageSearch, folderDialog, updates, agentRouting, modelPerConversation, secretsInKeychain}, platform: {mode: "local", account: null}}`. `name` is the OS user's full name. `features.folderDialog`: `POST /api/choose-folder` opens a native dialog (the desktop app only). `features.updates`: this copy can install updates itself (`canInstall`, see [Updates](#updates)). `features.secretsInKeychain`: keys and secret values go to the system keychain; false: they are kept in memory for the session (a development server started with `-secrets memory`), and the app says so. |
| `GET /api/auth/config` | `{oidcEnabled: false, devAuthEnabled: false, devAccounts: [], instance: {name: "Pi Local", logoUrl: null, colorTheme: "neutral", defaultTheme: "system", orgName: "", supportUrl: null}}` |
| `GET /api/me/prefs` | `Record<key, object>`: every saved preference. |
| `PUT /api/me/prefs/{key}` | Body `{value: object}`. Keys: `inbox` (≤ 512 KiB), `appearance` (≤ 16 KiB), `onboarding` (≤ 4 KiB); any other key is `404 unknown_pref`. Answers `{ok: true}`. |

The `onboarding` pref is the Get started card's state: `{skipModel?: boolean}` (the person chose to try the demo model
rather than connect one). Older versions kept `skipModel` in the browser (`localStorage["pai.onboarding.skipModel"]`);
the UI reads that once, saves it as the pref, and removes it.

## Agents

```ts
type Agent = {
  id: string;                 // "ag_…"
  name: string;               // 1–60 chars, one line
  description: string;        // ≤ 500 chars
  instructions: string;       // ≤ 20,000 chars; empty: the kind's default prompt
  kind: "personal";           // the chat UI's grouping; every local agent is the person's own
  agentKind: "assistant" | "triage" | "researcher" | "coding";   // what it is (runtime kind); triage is retired
  status: "asleep" | "starting" | "awake" | "error";  // its runtime process
  running: boolean;           // status is "awake"
  lastError?: string | null;  // why it last failed to start (status "error")
  model: { id: string; name: string; provider: string } | null;  // Phase 1: the demo model
  enabled: boolean;           // always true in Phase 1
  lastUsedAt: string | null;
  budget: { monthlyUsd: number; onExceed: "stop" | "warn" } | null;  // its monthly budget (see Budgets); null: none
  revision: number;           // bumped on every config change
  createdAt: string;
  updatedAt: string;
};
```

| Route | Answer |
|---|---|
| `GET /api/agents` | `Agent[]`, newest first. Never starts a runtime. |
| `GET /api/agents/catalog` | `{templates: Template[], models: [{id, name}], defaultModelId, allowModelChoice: true, limit: 1000, used}`. `templates` are the New agent gallery's starting points, the same list as `GET /api/templates` (see [Templates](#templates-and-web-tools-v02)): the built-ins Assistant, Researcher, Writer & editor, Daily briefing, Translator, Planner and Coding, then the person's own. `triage` is retired: no longer offered, but agents made with it keep running. Models are `demo/demo-1` in Phase 1. |
| `POST /api/agents` | Body `{name, description?, templateId?, modelId?, instructions?, workspace?, web?}` (`workspace`: see [Workspace tools](#workspace-tools-approvals-and-attachments-phase-4)). `templateId` is a template's ID: the agent starts from it (its kind, instructions, tools, approvals, web tools and first schedule), and the body's own fields win; an empty `instructions` keeps the template's. `201 Agent`. Errors: `400 invalid_name`, `invalid_template`, `invalid_model`, `invalid_workspace_folder`. A `coding` agent made without `workspace.tools` gets `["read", "write", "edit", "bash"]`. |
| `PATCH /api/agents/{id}` | Body `{name?, description?, modelId?, instructions?, web?, memory?, budget?}` (later phases add more; `memory`: see [Memory](#memory-v02); `budget`: see [Budgets](#budgets-v03), `null` removes it). Answers `Agent`; fields left out are unchanged (an empty body changes nothing but the revision). A change restarts the agent's runtime if it is awake. |
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
| `POST /api/agents/{a}/threads/{t}/messages` | Body `{text, requestId, whenBusy?: "followUp" \| "steer", modelId?, thinking?, attachments?}` (`attachments`: see [Attachments](#attachments)), at most 32,000 characters. `modelId`/`thinking`: see [Model per conversation](#model-per-conversation-v02). `202 {submissionId}`. Creates the thread on first use: the app records the thread *before* relaying, and removes the record if the runtime refuses. `402 over_budget` (nothing is recorded or sent) when the agent's budget, or the app's, says stop and is used up: see [Budgets](#budgets-v03). |
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
- `event: elicitation`, `data: McpElicitation` when an MCP server asks something and on each change of its state (see
  [MCP elicitation](#mcp-elicitation))
- `event: update`, `data: UpdateStatus` when the update status changes: a check, or an install's stage (see
  [Updates](#updates))
- `event: memory`, `data: {agentId}` when memory changes: `agentId` `""` is the person's (the About me card, facts,
  suggestions), otherwise that agent's notes. Nothing else is sent: read `/api/you…` or `/api/agents/{id}/memory` again
  (see [Memory](#memory-v02))
- `event: backup`, `data: {}` when backups change: one made or deleted, the daily setting, a restore recorded or taken
  back, a backup starting or ending. Read `GET /api/backups` again (see
  [Backups and diagnostics](#backups-and-diagnostics-v03))
- `event: budget`, `data: {level: 0 | 80 | 100, message, status: BudgetStatus}` when a budget reaches 80% or 100% of
  its limit for the month, once each (see [Budgets](#budgets-v03)); `level: 0` when a budget was changed (set, raised,
  removed), with `status` naming only the `scope` (and `agentId`): nothing to announce, read `GET /api/budgets` again.
  The desktop app shows levels 80 and 100 as system notifications, the UI as a toast.
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
type ProviderPreset = { id: string; name: string; kind: string; baseUrl: string; needsKey: boolean; note: string;
  signupUrl?: string;          // where to get a key, or the software for a local server
  local?: boolean };           // runs on this computer (Ollama, LM Studio); detection looks for it
type Detected = {              // a model server running on this computer
  preset: string;              // the local preset it matches ("ollama", "lm-studio")
  name: string; baseUrl: string;
  models: { modelId: string; name: string }[];  // chat models only (no embedding models)
  provider: string | null;     // the provider already using this server, if any
};
type Discovered = { modelId: string; name: string; contextWindow: number | null; added: boolean };
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
  cacheReadPrice: number | null;   // USD per million cached tokens read; null: counted at the input price
  cacheWritePrice: number | null;  // USD per million tokens written to the cache; null: the input price
  priceSource: "list" | "you" | null;  // where the prices came from: the app's price list, or typed in; null: unpriced
  hasListPrice: boolean;       // the price list has a price for this model ("Use list prices" works)
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
| `GET /api/providers/detect` | `Detected[]`: the local presets' servers that answer (each looked for for up to about 1 s; nothing is configured). A server that isn't running is left out. Not cached. |
| `POST /api/providers/setup` | One-step setup from a preset, for the first run. Body `{preset, apiKey?, models?: string[]}`. Creates the provider from the preset, or reuses the one already set up for it (a new `apiKey` replaces its key), lists its models, and adds `models`. Without `models`, a local preset gets every chat model (at most 20) and a remote one none (pick from `available`, then call again with `models`; the key isn't needed again). The first model added becomes the default model while the default is still `demo/demo-1`. Answers `{provider: Provider, available: Discovered[], defaultModelId}` (`available` marks `added`). Errors: `400 invalid_preset`, `400 invalid_key` (a keyed preset with no key stored or given: "Paste the API key from OpenAI."), `400 invalid_model` (not offered), `502 discovery_failed` with a message for people (wrong key, nothing answering). |
| `POST /api/providers/{p}/discover` | Lists the provider's models from its API: `{models: [{modelId, name, contextWindow: number \| null, added: boolean}]}`. `502 discovery_failed` with a message for people. |
| `PUT /api/providers/{p}/models/{modelId...}` | Adds or changes a model. Body `{name?, contextWindow?, maxTokens?, reasoning?, images?, inputPrice?, outputPrice?, cacheReadPrice?, cacheWritePrice?, priceFromList?, enabled?}`. Answers `Model`. Prices: see [Known prices](#known-prices). |
| `DELETE /api/providers/{p}/models/{modelId...}` | `{ok: true}`, or `409 in_use` as above. |
| `PUT /api/settings/default-model` | Body `{modelId}`: the model new agents get. Answers `{defaultModelId}`. |

`GET /api/agents/catalog` lists every enabled model of every enabled provider (and the demo model), as
`{id, name, provider, providerName}`, with `defaultModelId`. An agent whose model was removed or turned off keeps it in
`agent.yaml`; it fails to start (`status: "error"`, `lastError` says which model) until it is given another.

### Known prices

A model added without prices gets the **list prices** of well-known models (OpenAI, Anthropic, Google, Mistral,
DeepSeek) when the price list (`internal/models/prices.go`) knows it, and `priceSource` is `"list"`. Prices set by hand
are `"you"` (so are any set before v0.3); a model with no prices has `priceSource: null`. Details:

- The model ID is matched flexibly: a provider prefix (`anthropic/claude-sonnet-4.5`, `openrouter/openai/gpt-5`,
  `models/gemini-2.5-pro`), a dated suffix (`claude-sonnet-4-5-20250929`, `gpt-4.1-2025-04-14`), dots or dashes in the
  version (`gpt-5.4`, `gpt-5-4`), any case, and Bedrock's vendor and version
  (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`). Anything else that isn't in the list exactly is unpriced: no guessing
  that `gpt-5.4-turbo` is `gpt-5.4`. A dated model with a price of its own keeps it (`gpt-4o-2024-05-13`).
- Only flat, generally available prices are listed. Prices that are promotional, scheduled to change, or depend on the
  hour are left out. Where a service has a short-prompt and a long-prompt price (OpenAI over 272K tokens, Gemini Pro over
  200K) the short-prompt price is used. DeepSeek's are the peak-hour prices. `PriceListChecked` in `prices.go` says when
  the list was last checked against the services' pages.
- A model on a local server (the `ollama` and `lm-studio` providers) never gets list prices: it costs nothing.
- Creating a model with `inputPrice`, `outputPrice`, `cacheReadPrice` and `cacheWritePrice` all absent or `null` gets the
  list prices when there are some. Setting any price on an existing model makes the source `"you"`, unless the values sent
  are the ones it has (the edit form sends them all); setting both `inputPrice` and `outputPrice` to `null` clears all
  prices (`priceSource: null`). `priceFromList: true` sets all four prices from the list: `400 no_list_price` when the
  model isn't in it (and for local providers).
- `cacheReadPrice` and `cacheWritePrice` (≥ 0, optional): tokens a model read from, or wrote to, its cache cost these;
  without them, cached tokens are counted at the input price (an estimate that errs high).

### Usage

`GET /api/me/usage?days=7|30|90` (default 30) or `?month=YYYY-MM`, with optional `&agent={agentId}` and
`&model={provider/modelId}`:

```ts
type UsageTotals = { requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number;
  cacheWriteTokens: number; costUsd: number; unpricedRequests: number };   // unpricedRequests: not in costUsd
type UsageReport = { from: string; to: string; days: number;               // dates, YYYY-MM-DD, local time
  month?: string;                                                          // "2026-10", for a month report
  total: UsageTotals;
  agents: (UsageTotals & { agentId: string; name: string })[];             // deleted agents keep their last name
  models: (UsageTotals & { modelId: string; name: string })[];
  byDay: (UsageTotals & { day: string })[];                                // every day of the range, zeros included
  options: { agents: { agentId: string; name: string }[];                  // everything with usage in the period,
             models: { modelId: string; name: string }[] };                // whatever is filtered: for the filters
  budget: { app: BudgetStatus | null; agent: BudgetStatus | null } | null };  // null: no budget applies
```

- `month` is a whole calendar month: `from` its first day, `to` its last (also when it is this month, so later days are
  zeros), `days` its length. It wins over `days`. A malformed month is `400 invalid_month`.
- `agent` and `model` narrow `total`, `agents`, `models` and `byDay` (both: only where they met). An unknown ID gives an
  empty report. `options` is never narrowed.
- `budget` is for the month shown (this month unless `month` is given): `app` is the app-wide budget, `agent` the
  filtered agent's, when each has one. It is the whole month's spending, whatever else is filtered.
- Cost: input and output at their prices, cache reads and writes at their prices (or the input price when a model has
  none). Requests to models without input and output prices are in `unpricedRequests`, not in `costUsd`.

### Budgets (v0.3)

A monthly limit in US dollars on what an agent may spend on its model, and another for every agent together. A budget
counts this **calendar month** (this computer's time zone) of usage, at the models' prices, **priced models only**:
requests to unpriced models are counted apart (`unpricedRequests`) and never add to the spending, so the real cost may be
more. Usage is recorded as each model request ends, so a reply already running can overshoot the limit.

```ts
type Budget = { monthlyUsd: number;                    // $0.01 to $1,000,000, whole cents
                onExceed: "stop" | "warn" };           // default "stop"
type BudgetStatus = { scope: "app" | "agent"; agentId?: string; name: string;   // the agent's name, or "Pi Local"
  month: string; monthName: string;                    // "2026-10", "October"
  monthlyUsd: number; onExceed: "stop" | "warn";
  spentUsd: number; unpricedRequests: number;
  percent: number;                                     // spentUsd / monthlyUsd × 100
  state: "ok" | "near" | "over";                       // near: 80% or more; over: 100% or more
  blocked: boolean };                                  // over, and onExceed is "stop": new work is refused
```

| Route | Answer |
|---|---|
| `PATCH /api/agents/{id}` `{budget}` | `{monthlyUsd, onExceed?}` sets the agent's budget (it is `budget` in `agent.yaml`: `budget: {monthlyUsd: 20, onExceed: stop}`); `null` removes it. `POST /api/agents` takes it too. `400 invalid_budget`. Changing it restarts the agent if it is awake, like any other change. |
| `GET /api/budgets` | `{app: BudgetStatus \| null, agents: BudgetStatus[]}`: this month's budgets, the agents' being those that have one. |
| `GET /api/settings/budget` | `{budget: Budget \| null}`: the app-wide budget. |
| `PUT /api/settings/budget` | Body `{budget: Budget \| null}` (`null` removes it; leaving `budget` out is `400 invalid_budget`). Answers as GET. `400 invalid_budget`. |

- **80% and 100%.** The first time a budget's spending reaches 80% and 100% in a month, the app sends a `budget` event
  (see [Live events](#live-events)) and the desktop app a system notification: "Hardac used 80% of its $20 budget for
  October." and "Hardac reached its $20 budget for October. It is stopped until you raise it." (`warn`: "…It keeps
  running."; the app-wide one: "Pi Local reached its $50 budget for October. Agents are stopped until you raise it.").
  Each level is told once per month and limit: changing the limit starts again. A single request that jumps past both
  levels sends only the 100% one.
- **`stop`.** At 100% an agent whose budget says stop (or any agent, when the app's does) refuses new work with
  **`402 over_budget`** (for a message, with `details.budget: BudgetStatus`) and a message naming the budget:
  "Hardac reached its $20 budget for October. Raise it in its settings." (the app's: "Pi Local reached its $50 budget
  for October. Raise it in Settings → Usage."). It covers:
  - `POST …/threads/{t}/messages` (nothing is recorded: a refused first message leaves no conversation);
  - `POST /api/schedules/{id}/run` ("Run now"). A schedule that comes due is not run: its run is recorded as `failed`
    with that message (and the usual `schedule_run` event), no conversation is made, and it does **not** count toward
    pausing the schedule: it runs again once the budget allows;
  - an `ask_agent` to the agent (the gateway's `POST /a2a/asks` answers `402 over_budget` with the message, which the
    asking agent's model is told). An ask already started goes on.
  Work already running, approvals decided and questions answered are not stopped.
- **`warn`.** Nothing is refused. The UI shows a banner above the conversation (80%, and over the limit), and the Usage
  page the meter.
- The next month, or a higher limit, or removing the budget, lifts the stop at once.

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
| `POST /api/reveal` | Body `{target: "data"}` or `{target: "agent", agentId}` or `{target: "workspace", agentId}`: opens the folder in Finder (`workspace`: the effective one, `workspace.dir`). `{ok: true}`. |
| `POST /api/choose-folder` | Opens the native folder dialog (a coding agent's project folder). `{path}` (absolute), or `{cancelled: true}`. `501 not_supported` without a dialog (the headless server): ask for the path instead. `GET /api/me` says `features.folderDialog`. |

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

Each agent has a **workspace** folder: its own private `<agent>/workspace`, or a **project folder** on this computer
(`workspace.folder`, as a coding agent has; a coding agent also follows that folder's AGENTS.md or CLAUDE.md). Its
file tools (`read`, `write`, `edit`) can't reach outside it; `bash` runs in it, and unless its **sandbox** is on (v0.3,
[below](#sandboxed-shell-v03)) a shell can reach anything you can, so it asks first by default. **Approvals** make an agent ask before chosen tools run: the call waits (also while the agent sleeps, and
across restarts of the app) until you approve or deny it, or it times out (denied).

`Agent` gains:

```ts
  workspace: {
    tools: ("read" | "write" | "edit" | "bash")[];   // none: no file tools
    folder: string;   // a project folder (absolute); "": its own private workspace
    dir: string;      // read-only: the folder it works in (the project folder, or …/agents/<id>/workspace)
    sandbox: boolean;           // v0.3: `bash` runs in the OS sandbox (agents made before it: false)
    network: boolean;           // v0.3: sandboxed commands may use the network (default true)
    sandboxAvailable: boolean;  // v0.3, read-only: this computer has a sandbox (macOS for now)
  };
  approvals: {
    profile: "careful" | "balanced" | "trusting" | "custom";       // v0.3; an agent without one is "custom"
    tools: string[];                                               // custom only: tool names or patterns with *
    rules: ApprovalRule[];                                         // v0.3: see "Approval rules and profiles"
    builtinRules: ApprovalRule[];                                  // v0.3, read-only: ask under every profile
    timeoutSeconds: number;                                        // 60 s – 30 days
  };
  pendingApprovals: number;                                        // waiting for you now
```

`PATCH /api/agents/{id}` takes `workspace?` (`{tools, folder?, sandbox?, network?}`; `dir` is ignored) and `approvals?`
(`{profile?, tools?, rules?, timeoutSeconds?}`: `tools` and `timeoutSeconds` replace what is there, so send both;
`profile` and `rules` left out keep what the agent has, so a client that doesn't know them doesn't lose them).
Send the whole workspace: `tools` left out is no tools, `folder` left out is its own folder (`sandbox` and `network` are
the exception: left out they keep what the agent has). `folder` must be an absolute path (a
leading `~/` is expanded) to an existing folder, and not `/`, `/Users`, `/System` or the home folder itself; otherwise
`400 invalid_workspace_folder` with a message to show. Errors: `invalid_workspace_tools`,
`invalid_approval_tools` (at most 100 patterns of 1–200 of `[A-Za-z0-9_.*-]`), `invalid_approval_timeout`,
`invalid_approval_profile`, `invalid_approval_rules`.

Before v0.3 `approvals.tools` was all there was; that is now the **custom** profile (below), and the UI offers these
presets for the list under it (it may also edit the list):
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
  summary: string | null;     // why it asks: a built-in rule, one of your rules, fast judgments, or the agent's code
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
A view's `ChatApproval` has `source`: what made the call ask, one of `builtin`, `rule` (an ask rule), `profile`,
`tools` (the custom list), `judge` (fast judgments) or `author` (an agent's own code). Its `summary` says why for
`builtin`, `rule` and `judge`.

### Approval rules and profiles (v0.3)

Which calls ask, run or are refused is the agent's **approval policy**: a profile, the person's rules, and rules built
into the app. Nothing here changes how a decision is made or delivered (above).

```ts
type ApprovalRule = {
  id: string;                          // "r_…" (built-in: "builtin-…"); stable, used to remove it
  tool: string;                        // a tool name, or a pattern with * (1–200 of [A-Za-z0-9_.*-])
  args?: Record<string, string>;       // each argument's glob; all must match (≤ 10, 1–500 characters each)
  action: "allow" | "ask" | "deny";
};
```

`args` globs match the argument's string value (a number or boolean as written, anything else as its JSON); `*` is any
characters, everything else is literal and case-sensitive: `{command: "git status *"}`. For bash's `command` only,
trailing ` *` also includes the bare command (`git status` and `git status --short`, not `git status-other`). Argument
patterns cannot contain control characters. An argument the call doesn't have doesn't match. Two guards keep a glob from being walked around:
- For `bash`'s `command`, an **allow** rule only matches a *simple* command: one with no `;`, `&`, `|`, backticks,
  `$(…)`, line breaks or redirects (`2>&1` and `>/dev/null` don't count). `git status && rm -rf ~` is not `git
  status*`. An **ask** or **deny** rule matches the whole command or any part of a compound one.
- An allow rule doesn't match an argument with a `..` path segment.

**Order, for each call:**
1. `rules`, in order: the first that matches decides. `deny` refuses the call without asking: the model reads *"Tool
   call blocked: Not allowed by your approval rules"*.
2. The built-in rules: a match asks, whatever the rule above says (an allow rule can't loosen them; a deny stands).
3. That first rule's `ask` or `allow`.
4. The profile.
5. Otherwise the call runs.

**Profiles** (`approvals.profile`; new agents are `balanced`; an agent whose `agent.yaml` has only `approvals.tools`
has no `profile` key and is `custom`, behaving as before):

| Profile | Asks before |
|---|---|
| `careful` | every tool that can change something: `write`, `edit`, `bash`, `schedule`, `cancel_schedule`, and MCP tools not marked read-only (`notify_person`, memory, web and read tools don't) |
| `balanced` | `bash`, unless the agent's shell is sandboxed (below; the built-in rules still ask); MCP tools marked destructive, and MCP tools not marked read-only whose name has a word like `delete`, `remove`, `send`, `update`, `create`, `write` or `post` |
| `trusting` | nothing (but the built-in rules) |
| `custom` | the tools in `approvals.tools` (names or patterns), as before profiles |

MCP tools' `readOnlyHint` and `destructiveHint` annotations come from the last test of the server (Settings → MCP:
test it again to pick them up; `McpTool.annotations`); a tool without them is judged by its name. `tools` is only read
under `custom`; the other profiles keep it in `agent.yaml` but ignore it.

**Built-in rules** (`approvals.builtinRules`, same for every agent and profile, `ask`, can't be removed): `bash`
commands matching `rm -rf*`, `sudo *`, `git push --force*`, `* | sh`, `curl * | *sh`.

| Route | Answer |
|---|---|
| `GET /api/agents/{a}/approval-rules` | `{profile, rules: ApprovalRule[], builtinRules: ApprovalRule[]}`. |
| `POST /api/agents/{a}/approval-rules` | Body `{tool, args?, action?}` (`action` default `allow`): appends a rule (so earlier rules keep priority); this is the approval card's **Approve and always allow this**. `201 {rule, rules}`; `200` with the existing rule when the same one is there. `400 invalid_approval_rules` with a message. |
| `DELETE /api/agents/{a}/approval-rules/{id}` | Removes a rule: `{rules}`. `404 rule_not_found`. Built-in rules can't be removed (they're not in `rules`). |

The whole list can also be set with `PATCH /api/agents/{a}` `approvals.rules`. Rules and the profile reach a running
agent at once, **without restarting it** (the app tells its runtime, `POST /approvals/policy`); a change to anything
else about an agent still restarts it. Rules written by hand in `agent.yaml` get an ID (the same each time it is read).
Templates carry the profile and tools but never rules.

**Approve and always allow this.** The approval card offers it unless the request came from a `builtin` or `rule` ask
or an agent's own code (`source`). It adds the rule, then approves: for `bash` the command's first word and subcommand
(`git status --short` → `{tool: "bash", args: {command: "git status *"}}`; an option counts as the subcommand, so `git --version` → `git --version *`, not every `git` command; `cat notes.md` → `cat *`), for any other tool the
tool alone. It isn't offered for a compound command (an allow rule would never match it).

**Fast-judgment tightening.** With fast judgments on and the `approvals` use switched on (Settings → Models), a call
the rules and profile would let run is judged — "could this cause harm or be hard to undo?", a yes at or above the
confidence threshold — and then asks, with the summary *"Asked because fast judgments thought it could be risky."*
(`source: "judge"`). It only ever tightens: an `ask` or `deny` stays, a failed or slow judgment (more than 5 s) changes
nothing, and a call the person's own **allow rule** let through is not judged. Only calls that can change something are
judged (`write`, `edit`, `bash`, the schedule tools, MCP tools not marked read-only). The service sees the tool's name
and the redacted view of its arguments.

Runtime → app: `POST /judge/approval` on the gateway, body `{tool, arguments}` (redacted), answers `{risky: boolean}`
(`false` when the use is off or the judgment fails).

### Sandboxed shell (v0.3)

With `workspace.sandbox` on, every command `bash` runs is confined by the operating system. macOS first: the runtime
runs it as `sandbox-exec -p <profile> /bin/bash -c <command>` with a profile generated for the agent
(`runtime/src/lib/sandbox/darwin.ts`). Linux (bubblewrap) and Windows (AppContainer) are stubs behind the same
interface (`SandboxPlatform`): there the sandbox reports it is not available yet.

**What a sandboxed command may do:**

| | |
|---|---|
| Run | any program, fork, signal its own children, use the system's services: nothing is taken away from processes. |
| Read | anywhere, except `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/Library/Keychains`, and the app's data folder outside this agent's own folder (`agents/<id>/`, which it may read, with its `agent.yaml`, `state.sqlite` and logs). The folders leading to its own can be looked at but not listed (tools that look for a project root walk up through them). The keychain's system service is closed too, or `security find-generic-password` would read it around the closed file. |
| Write | its **workspace**; its **temp folder** (`agents/<id>/tmp`, its `$TMPDIR`); `/dev/null`, `/dev/tty`, the pseudo-terminals, `/dev/fd/*` and the other harmless devices; `/private/tmp` (many tools hard-code `/tmp`, and `mktemp` and test runners use it; it is shared with the person's other processes); and this user's own folder under `/private/var/folders/<xx>/<yyyy>/` (macOS's `$TMPDIR`, cache and data folders that compilers and system tools write to without being asked; not the rest of `/private/var/folders`). Never the credential folders, nor the app's data folder outside the workspace and temp folder (so a command can't edit its own `agent.yaml`), even when the data folder is under a writable path. |
| Network | on by default; `workspace.network` off denies every connection to or from an IP address (including `localhost`) and listening sockets. Unix sockets (local services, `ssh-agent`) still work. |

Tools that cache under the home folder fail to write there, so the shell sets `XDG_CACHE_HOME`, `GOCACHE`,
`npm_config_cache` and `PIP_CACHE_DIR` into `agents/<id>/tmp/cache`. Other tools' home caches (cargo, a Gradle home)
are blocked: the model is told, and the person can turn the sandbox off.

**The agent's settings** (`agent.yaml`, and the Tools tab's **Sandbox** panel; the coding agent's Settings tab shows it too):

```yaml
workspace:
  tools: [read, write, edit, bash]
  sandbox: "on"      # on | off. Booleans (true, yes) are read too. Empty/missing: off
  network: "off"     # on | off. Empty/missing: on. No effect without the sandbox
```

- A **new** agent whose tools include `bash` gets `sandbox: on` (on a Mac; the coding template too), unless the request
  or its template says otherwise. An agent from before the sandbox has no setting and stays **off**: nothing changes
  behind anyone's back. Where the OS has no sandbox yet (`sandboxAvailable: false`), new agents get no setting.
- API: `workspace.sandbox` and `workspace.network` are booleans in a create or update; left out they keep the agent's
  (or its template's). A different value: `400 invalid_workspace_sandbox` / `invalid_workspace_network` (agent.yaml
  strings other than on/off).
- Changing either restarts a running agent. The runtime gets `WORKSPACE_SANDBOX=on`, `WORKSPACE_SANDBOX_NETWORK=on|off`,
  `WORKSPACE_SANDBOX_DATA_DIR` and `WORKSPACE_SANDBOX_AGENT_DIR` (absent when off).
- **Approvals.** The policy sent to the runtime (`TOOL_APPROVALS`) has `sandboxed: true` when the sandbox is on and the
  agent has `bash`. Under the **balanced** profile `bash` then runs without asking; the built-in rules (`rm -rf*`,
  `sudo *`, …), the person's rules, and **careful** still ask. The runtime honours `sandboxed` only when it is itself
  running the shell sandboxed, whatever a policy says.
- **Never silently unsandboxed.** With the sandbox on, `bash` first starts a harmless program in the sandbox; if
  `sandbox-exec` is missing, the OS has none yet, or it fails to start (for example inside another sandbox), the
  command is refused with that reason and a hint to turn the sandbox off for the agent, and nothing runs.

**What the model sees.** The sandbox's refusal is the plain `Operation not permitted`. The runtime reads the command's
output and adds a line after it, for example:
- `The sandbox blocked writing outside the workspace: /Users/ada/notes.txt. Commands can write in the workspace, its temp folder and /tmp.`
- `The sandbox blocked access to /Users/ada/.ssh: it keeps credentials and other agents' data private.`
- With the network off and a connection error: `The network is off for this agent, so commands can't connect to anything (that may be why this failed).`
- An `Operation not permitted` with no path it can classify: `This may be the sandbox: commands can only write in the workspace, its temp folder and /tmp.`

### Attachments

| Route | Answer |
|---|---|
| `POST /api/agents/{a}/attachments?name=<file name>` | Body: the file's bytes (any Content-Type; at most 100 MiB; send an ArrayBuffer, never a Blob). Saved in the workspace under `attachments/<YYYY-MM-DD>/<name>` (a ` (2)` suffix when the name is taken). `201 {path, name, size, mediaType}` (`path` relative to the workspace). `409 no_read_tool` when the agent doesn't have the `read` tool (it couldn't open it). |

A message carries its files (v0.2): upload each, then send `attachments: [{path, name, size, mediaType}]` (the upload's
answers) with the message, at most 20. The text may then be empty (`""`); a conversation begun that way is named
after the files. `400 invalid_attachments` for more files or a path outside the workspace.

- The transcript's user message has `attachments` (the same objects) and the person's `text` alone.
- The model reads the text, then a line per file:

  ```
  Attached files (in your workspace):
  - attachments/2026-10-20/report.pdf (120 KB)
  ```

  Messages sent before v0.2 have this block in their `text` (the app shows it as attachments too).
- Images (PNG, JPEG, GIF, WebP, BMP; up to 5 a message) go in the message itself when the model answering takes images,
  resized to fit its limits. A model without image input is told it can't see them.
- The `read` tool opens PDF, Word (`.docx`), Excel (`.xlsx`) and PowerPoint (`.pptx`) files as Markdown: pages,
  headings, lists and tables, sheets as tables, slides with their notes. A scanned PDF has no text; `read` says so.
  Images too large for the model are resized rather than refused.

## MCP servers (Phase 5)

The app keeps a catalog of MCP servers; each agent chooses which it uses (and, optionally, which of their tools).
Agents connect to them themselves (pi-mcp in the runtime): a **stdio** server is a program the agent's runtime starts
(it runs as you: only add commands you trust), an **http** server is a remote Streamable HTTP endpoint, with header
values or an OAuth sign-in. Env and header values and OAuth tokens are kept in the OS keychain and never returned.
An agent's tools from a server are named `mcp__<slug>__<tool>`.

```ts
type McpTool = { name: string; title: string | null; description: string | null; modelVisible: boolean; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } };
type McpServer = {
  slug: string;                 // 1–32 of [a-z0-9_] (no leading/trailing _): the tool prefix
  name: string;                 // 1–60 chars
  description: string;
  transport: "stdio" | "http";
  command: string | null;       // stdio
  args: string[];               // stdio; may use ${workspace} (the agent's workspace) and ${agentDir}
  cwd: string | null;           // stdio; default ${workspace}
  loginArgs: string[];          // stdio: its own sign-in command's arguments (run with `command`); [] = none
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
| `POST /api/mcp/servers` | Body `{slug?, name, description?, transport, command?, args?, loginArgs?, cwd?, env?: Record<string,string>, url?, headers?: Record<string,string>, oauth?}` (slug defaults from the name). Tests it right away (`tools`/`lastError` filled in). `201 McpServer`. Errors: `invalid_slug`, `slug_taken`, `invalid_name`, `invalid_transport`, `invalid_command`, `invalid_url` (https, or http on this computer/network), `invalid_headers`, `invalid_env`. |
| `PATCH /api/mcp/servers/{slug}` | The same fields (not slug); `env`/`headers` replace all values. `envSet?`/`headersSet?` (`{name: value}`) change or add some and `envRemove?`/`headersRemove?` (names) drop some, keeping the rest (after `env`/`headers`: remove, then set). `enabled?`. `loginArgs?: []` clears the sign-in command. Answers `McpServer`. Agents using it restart. |
| `DELETE /api/mcp/servers/{slug}` | `{ok: true}`; `409 in_use` with `details.agents` while agents use it. Its keychain items go too. |
| `POST /api/mcp/servers/{slug}/test` | Connects (stdio: starts it) and lists its tools, at most 60 s: `McpServer` with `tools`/`testedAt` or `lastError`. An OAuth server that needs a sign-in says so in `lastError` (`needs_sign_in`). |
| `POST /api/mcp/servers/{slug}/sign-in` | OAuth: starts a sign-in in the browser (the app opens it) and answers at once `{authorizeUrl}`; the outcome comes as an `mcp` live event (the server, `signedIn` and `tools` updated, or `lastError`). Up to 5 minutes. |
| `POST /api/mcp/servers/{slug}/sign-out` | Forgets its OAuth tokens. `McpServer`. |
| `POST /api/mcp/servers/{slug}/login` | stdio: runs its own sign-in command (`command` with `loginArgs`, its env and cwd), which may open a browser or print a code or link, and exits 0 once signed in. Answers at once `202 McpLoginStatus`; output and the outcome come as `mcp-login` live events. After it succeeds the server is tested again (an `mcp` event). `409 login_running` while one runs; `400 no_login` without `loginArgs`. |
| `GET /api/mcp/servers/{slug}/login` | `McpLoginStatus`: the one running, or the last one (`state: "idle"`: none). |
| `DELETE /api/mcp/servers/{slug}/login` | Cancels the one running. `McpLoginStatus`. |
| `POST /api/mcp/servers/{slug}/reveal` | `{kind: "env" \| "header", name}` → `{value}`: one stored value, for the edit dialog's Show. JSON only (415 otherwise), `Cache-Control: no-store`; 404 for a name that isn't set. |
| `GET /api/mcp/import` | Servers found in other apps' configs: `{sources: [{id: "claude" \| "cursor" \| "vscode", path, servers: [{name, transport, command?, args?, url?, envNames: string[], exists: boolean}]}]}` (`exists`: a server with that slug is already here; `unsupported`: why it can't be imported), and `searched`: every path looked at. |
| `POST /api/mcp/import` | Body `{source, names: string[]}`: adds those servers (with their env/header values), each tested. `{servers: McpServer[], skipped: [{name, reason}]}`. |

`Agent` gains `mcp: {server: string; tools: string[] | null}[]` (tools null: all its model-visible tools), set with
`PATCH /api/agents/{id}` `{mcp}` (`400 invalid_mcp`: an unknown server). An agent whose server is off or untested
starts without it (its log says so).

`loginArgs` can't use `${workspace}` or `${agentDir}` (`400 invalid_command`): the sign-in runs once, not per agent.

```ts
type McpLoginStatus = {
  slug: string;
  state: "idle" | "running" | "succeeded" | "failed" | "cancelled";
  output: string;               // stdout and stderr together, ANSI codes stripped: the last 16 KiB
  exitCode: number | null;
  startedAt: number | null;     // Unix ms
  finishedAt: number | null;    // Unix ms
};
```

Live events: `event: mcp`, `data: {slug, deleted, server?: McpServer}`; `event: mcp-login`, `data: McpLoginStatus`
on each burst of output (throttled) and each change of state.

### MCP elicitation

An MCP server can ask the person something in the middle of a tool call (`elicitation/create`): a message and a small
form. The runtime declares the `elicitation` capability (form mode) to the servers it connects to and relays each
`elicitation/create` to the app; the tool call waits until the person answers, or the question expires after 15
minutes. A typical case is a server confirming before it acts: `m365` asks before it sends an email, with a message
that spells out the recipients, subject and body, and a form with one boolean field
(`{send: {type: "boolean", title: "Yes, go ahead"}}`, required); `tdx` does the same with `approve`.

```ts
type McpElicitation = {
  id: string;                 // "el_…"
  agentId: string; agentName: string;
  threadId: string | null;    // the conversation whose tool call asks; null if not known
  server: string;             // MCP server slug, e.g. "m365"
  serverName: string;         // e.g. "Microsoft 365"
  tool: string | null;        // the MCP tool being called (not prefixed), e.g. "send_draft"
  message: string;            // the server's own words, plain text: untrusted, shown as text (never HTML or markdown)
  requestedSchema: {
    type: "object";
    properties: Record<string, {
      type: "string" | "number" | "integer" | "boolean";
      title?: string; description?: string; default?: string | number | boolean;
      enum?: string[]; enumNames?: string[];        // a string chosen from a list
      minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
      format?: "email" | "uri" | "date" | "date-time";
    }>;
    required?: string[];
  };
  state: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  createdAt: number;          // Unix ms
  expiresAt: number;          // Unix ms
};
```

| Route | Answer |
|---|---|
| `GET /api/elicitations` | `McpElicitation[]`: the pending ones, across agents. |
| `POST /api/elicitations/{id}` | Body `{action: "accept" \| "decline" \| "cancel", content?: Record<string, string \| number \| boolean>}` (`content` with `accept` only; it must match `requestedSchema`). Answers `McpElicitation`. Errors: `400 invalid_content` (the message names the field), `404 not_found`, `409 not_pending` (already answered or expired). The answer reaches the server at once and the tool call goes on. |

Live events: `event: elicitation`, `data: McpElicitation` when one is asked and on every change of its state; one
whose `state` isn't `pending` leaves the pending list. The UI shows a pending one as a card in its conversation (one
without a thread on the agent's home page), counts its conversation as "Needs you" like a pending approval, and
shows a toast for a new one that isn't on screen.
## Chat features (Phase 6)

All of these are the runtime's, passed through (`runtime/src/lib/server.ts`, `view.ts`, `delta.ts`):

- **Delta stream.** `GET …/threads/{t}/events?format=delta&v=1[&limit=N]`: first a `snapshot` event (a whole ChatView,
  with `earlierCursor` when `limit` cut it), then changes: `message.added`, `message.updated`, `partial.set`,
  `partial.appended`, `partial.cleared`, `tools.set`, `tool.started`, `tool.updated`, `tool.removed`, `run` (`busy`),
  `approvals.set`, `document.updated` (the exact shapes: `DeltaEvent` in `delta.ts`). Each has an `id` (its sequence); reconnect with `Last-Event-ID` to continue; a gap is answered
  with a new `snapshot`. `applyDelta(view, event)` in `runtime/src/lib/delta.ts` is the reference for applying them.
- **Paging.** `GET …/threads/{t}?limit=N&before=<earlierCursor>` returns the messages before the cursor (and its own
  `earlierCursor` while there are more).
- **Steer.** `POST …/messages` with `whenBusy: "steer"` joins the reply in progress after its current tool round
  (default `followUp`: answered after the reply ends).
- **Request IDs.** A user message in a view carries the `requestId` it was sent with, so a client matches what it sent
  by ID (never by text).
- **Documents.** `ChatView.documents` is `{kind: {revision}}` for the documents the agent exposes for the thread (the
  triage kind: `triage.queue`; the researcher: `research.plan`, `research.sources`). `GET
  /api/agents/{a}/threads/{t}/documents/{kind}` answers `{kind, version, revision, value}`; `document.updated` (delta)
  or a new revision says it changed.
- **Tool details.** A tool result message and a live tool carry `details` (any JSON, at most 16 KiB) or
  `detailsOmitted: true`: what the tool reports for UIs beyond its text.

## Always on: schedules, search, editing, the desktop (Phase 7)

### Schedules

A schedule sends an agent a message at set times: once (`at`) or recurring (`cron`, five fields or `@daily`/`@weekly`,
in `timezone`). Each run is a conversation of its own (`threadMode: "new"`) or goes to one conversation
(`threadMode: "this"` with `threadId`). The message comes from the schedule (the agent reads
`[Message from trigger <name>]`). The app keeps running in the menu bar when its window is closed, so schedules fire;
a fire missed while the app was quit is run once at the next start (`missedPolicy: "run_once"`, the default) or
skipped (`"skip"`). After 5 failed runs in a row a schedule pauses (`pausedReason`). An agent with
`schedules.agentMade` may also set its own (its `schedule`, `list_schedules`, `cancel_schedule` tools; at most 20,
at most every 5 minutes, 300 runs a day): those are `madeBy: "agent"`.

```ts
type Schedule = {
  id: string; agentId: string; agentName: string;
  name: string;
  once: boolean; at: number | null;         // Unix ms (once)
  cron: string | null; timezone: string;    // IANA
  message: string;
  threadMode: "new" | "this"; threadId: string | null;
  originThreadId: string | null;            // where an agent made it
  madeBy: "user" | "agent";
  missedPolicy: "skip" | "run_once";
  paused: boolean; pausedReason: string | null;
  nextFireAt: number | null;                // null: a reminder that fired
  lastFireAt: number | null;
  lastRun: Run | null;
  createdAt: number;
};
type Run = { id: string; scheduleId: string; threadId: string; firedAt: number;
  status: "running" | "done" | "failed"; error: string | null; finishedAt: number | null };
```

| Route | Answer |
|---|---|
| `GET /api/schedules` | `Schedule[]` of every agent, next to fire first. |
| `GET /api/agents/{a}/schedules` | One agent's. |
| `POST /api/agents/{a}/schedules` | Body `{name?, at? (ISO 8601; without an offset it is in timezone), cron?, timezone?, message, threadMode?, threadId?, missedPolicy?}`. `201 Schedule`. Errors: `invalid_when`, `invalid_time`, `invalid_cron`, `invalid_timezone`, `invalid_message`, `invalid_thread_mode`. |
| `PATCH /api/schedules/{id}` | The same fields and `paused`. Resuming resets the failure count. `agentId` moves the schedule to another agent (`invalid_agent` for one that doesn't exist): its runs then start new conversations there, so `threadMode` becomes `new` (a `this` is ignored). |
| `DELETE /api/schedules/{id}` | `{ok: true}` |
| `POST /api/schedules/{id}/run` | Runs it now (its next time doesn't change): `Run`. `402 over_budget` when the agent's budget, or the app's, is used up and says stop (see [Budgets](#budgets-v03)). |
| `GET /api/schedules/{id}/runs?limit=` | `Run[]`, newest first. |

`Agent` gains `schedules: {agentMade: boolean}` (`PATCH` it). Live events: `event: schedule`
(`{scheduleId, deleted, schedule?}`) and `event: schedule_run` (`{scheduleId, agentId, name, run}`, when a run ends).

### Search

`GET /api/search?q=` (at most 200 characters; words of 2+ letters, each matching the start of a word, accents
ignored): `{results: [{agentId, threadId, snippet, indexedAt}]}`, best first, at most 30. In `snippet` the matches are
between `\u0001` and `\u0002`. Conversations are indexed when a reply ends and when they are opened (text of people's
and agents' messages only). `GET /api/me` says `features.messageSearch: true`.

### Editing and branching

`POST /api/agents/{a}/threads/{t}/fork` with `{beforeMessageId}` (edit: the new conversation keeps everything before
that user message; send the edited text to it next) or `{afterMessageId}` (branch: it keeps everything up to and with
that message). `201 AgentThread` (a new thread, idle, titled like the source). The source is untouched. `400
invalid_message_id`.

### The desktop app

| Route | Answer |
|---|---|
| `GET /api/settings/desktop` | `{available, launchAtLogin}` (`available`: false in a browser) |
| `PUT /api/settings/desktop` | Body `{launchAtLogin}`: opens Pi Local (in the menu bar, window closed) when you log in. |

### Updates

Pi Local updates itself from its GitHub releases (signed archives; the signature is checked before installing). Every
route answers `501 not_supported` where there are no updates at all: hide the UI then.

```ts
type UpdateStatus = {
  current: string;            // this version: "0.1.0", or a development build like "6dc49f2-dirty"
  latest: { version: string; notes: string /* Markdown */; url: string /* release page */; published: string } | null;
  available: boolean;         // latest is newer than current
  checkedAt: number | null;   // Unix ms of the last check
  error: string | null;       // the last check's or install's error ("no releases have been published yet")
  canInstall: boolean;        // false in a development build, the headless server, or with installBlocked:
                              // link to latest.url ("Download from GitHub") instead
  installBlocked: string | null;   // why this copy can't update itself where it is (run from the disk image, or a
                                   // quarantined copy), a message to show; null when it can, or isn't an installed app
  autoCheck: boolean;         // checks 30 s after start and every 12 hours
  stage: null | "downloading" | "verifying" | "backing-up" | "installing" | "restarting" | "failed";
};
```

| Route | Answer |
|---|---|
| `GET /api/update` | `UpdateStatus` |
| `POST /api/update/check` | Checks GitHub now. `UpdateStatus`. |
| `POST /api/update/install` | `202 UpdateStatus`: downloads, verifies, [backs up the data](#backups-and-diagnostics-v03) (stage `backing-up`; if the backup fails the update stops, `failed`, nothing replaced), installs and restarts in the background; the stages arrive as `update` events (`failed` with `error`; it may be tried again). `409 cannot_install` with a message when it can't (no newer version, already installing, not an installed app, no archive for this Mac). |
| `PUT /api/update/settings` | Body `{autoCheck: boolean}`. `UpdateStatus`. |

Live events: `event: update`, `data: UpdateStatus`.

The desktop app shows a notification (while its window isn't in front) when an agent asks for approval, a scheduled
run ends, or an agent fails; the menu bar menu says how many agents are working and how many requests need you.

## Templates and web tools (v0.2)

### Templates

A **template** is a starting point for a new agent. The built-ins ship with the app; the person's own (category
`yours`) are YAML files in the data folder's `templates/` folder, so they can be shared.

```ts
type Template = {
  id: string;                     // 1–48 of [a-z0-9-]
  name: string; description: string;
  category: "everyday" | "work" | "life" | "meta" | "yours";
  icon: string;                   // a lucide icon name: "sunrise", "pen-line", "languages", "list-checks", "search", …
  kind: "assistant" | "researcher" | "coding" | string;   // the runtime kind its agents get
  instructions: string;
  workspace?: { tools: string[]; sandbox?: "on" | "off"; network?: "on" | "off" };
  approvals?: { profile?: string; tools: string[]; timeoutSeconds: number };
  web?: { search: boolean; fetch: boolean };              // left out: both on
  schedules?: { agentMade: boolean };                     // may set its own schedules
  schedule?: { name: string; cron: string; message: string; threadMode?: "new" | "this" };  // made with the agent
  mcp?: string[];                 // MCP server IDs it works with, used when this computer has them
  needs?: string[];               // what makes it work well: "web-search"
  builtin: boolean;               // shipped with the app: can't be deleted
};
```

| Route | Answer |
|---|---|
| `GET /api/templates` | `{templates: Template[], categories: string[]}` (categories in the gallery's order). |
| `POST /api/templates` | Body: the template file's raw YAML (send text or an ArrayBuffer, not a Blob: Wails drops Blob bodies). Imports it; an ID already taken gets a fresh one. `201 Template`. `400 invalid_template` with a message for people; `400 empty_file`. |
| `GET /api/templates/{id}/export` | The YAML file, `Content-Disposition: attachment; filename="<id>.pi-template.yaml"`. |
| `POST /api/templates/{id}/export-save` | Desktop app: asks where to save it (the system Save dialog) and writes the YAML there. `{path}`, or `{cancelled: true}`; `501` in a browser (use `/export`). |
| `DELETE /api/templates/{id}` | `{ok: true}`. `409 builtin` for a built-in. Agents made from it keep working. |
| `POST /api/agents/{id}/save-template` | Body `{name?, description?}` (default: the agent's). A template of the agent's kind, instructions, workspace tools, approvals, web tools, `schedules.agentMade` and MCP server IDs (never its project folder, memory or conversations). `201 Template` (category `yours`). |

`POST /api/agents` with `templateId` makes an agent from one (see [Agents](#agents)). A template with a `schedule` also
gets that schedule. The `coding` template's project folder is sent as `workspace` as before.

### Web tools

`Agent` gains `web: {search: boolean, fetch: boolean}` (`PATCH` it): its `web_search` tool (through the search service
below) and `web_fetch`, which reads a web page as text. Both only read. New agents get both on unless their template says
otherwise.

The search service is the app's, shared by every agent. Its key lives in the OS keychain and is never returned.

```ts
type WebSearchProvider = { id: "brave" | "tavily" | "serpapi" | "searxng"; name: string;
  needsKey: boolean; needsUrl: boolean; signupUrl: string; note: string };
type WebSettings = {
  provider: "" | WebSearchProvider["id"];   // "": web search is off
  url: string;                              // a custom address (self-hosted or a proxy); required for SearXNG
  hasKey: boolean;                          // a key is stored
  providers: WebSearchProvider[];           // Brave first (the suggested one)
};
```

| Route | Answer |
|---|---|
| `GET /api/settings/web` | `WebSettings` |
| `PUT /api/settings/web` | Body `{provider, url?, apiKey?}`. `apiKey` left out keeps the stored key; `""` removes it. `url` left out keeps the stored one; `""` clears it. `provider: ""` turns search off (and removes the key and address). Answers `WebSettings`. Errors: `400 invalid_provider`, `400 invalid_key` ("Paste the API key from Brave Search."), `400 invalid_url`. |
| `POST /api/settings/web/test` | Body `{query?}` (default "Pi Local test search"). One search with the saved settings: `{results: [{title, url, snippet}]}` (at most 3). `409 not_set_up`; `502 search_failed` with a message for people. |

## Memory (v0.2)

What agents know about the person, and what each agent learned about its own work. Everything stays on this computer
(`app.db`, and `memory.json` in each agent's folder); each turn, an agent's model provider gets what that agent may see.

- **About me** (`Basics`): a card every agent with memory on sees. Until it is saved, it holds defaults from this
  computer (`saved: false`).
- **Facts** about the person, by category. Every agent sees the `preferences` category; the others (`shareable`) only
  when its `agent.yaml` shares them (`memory.share`).
  - A fact the person said, in a conversation they started, is saved as known (`status: "active"`).
  - What an agent concluded (`trust: "inferred"`), outside text (`trust: "external"`: a web page, mail, a file, a tool's
    result), or anything saved during a schedule's or another agent's run, is a **suggestion** (`status: "suggested"`)
    until the person accepts it. External facts never join the profile agents always see.
- **Notes**: an agent's own, about its job. Saved directly.

```ts
type Basics = { name: string; role: string; organization: string; timezone: string; language: string;
  addressAs: string; answerStyle: string; signOff: string };       // all strings, "" when unset
type Fact = {
  id: string;                          // "um_"
  category: string;                    // one of `categories`
  text: string;
  trust: "said" | "inferred" | "external";
  status: "active" | "suggested";
  pinned: boolean;
  sourceAgent: string | null;          // the agent that saved it; null: the person added it
  sourceThread: string | null;         // its conversation: /agents/{sourceAgent}/threads/{sourceThread}
  createdAt: number; updatedAt: number; // Unix ms
};
type Note = { id: string; text: string; thread?: string; createdAt: number; updatedAt: number }; // id "an_"
```

`Agent` gains `memory: {off: boolean, share: string[]}` (`PATCH /api/agents/{id}` with `{memory}`; both fields are
sent). Memory is on unless `off`; an agent with memory off sees nothing about the person, keeps no notes and has no
memory tools. `400 invalid_memory` for an unknown category.

| Route | Answer |
|---|---|
| `GET /api/you` | `{basics: Basics, saved: boolean, categories: string[], shareable: string[]}`. `categories`: preferences, people, projects, work, health, family, finances, home, interests; `shareable`: all but preferences. |
| `PUT /api/you/basics` | Body `Basics`. Answers `Basics`. `400 invalid_basics`. |
| `GET /api/you/memories` | `?status=active\|suggested` (left out: all). `Fact[]`. |
| `POST /api/you/memories` | Body `{category, text, pinned?}`: the person adds a fact (known, `trust: "said"`). `201 Fact`. |
| `PATCH /api/you/memories/{id}` | Body `{category?, text?, pinned?, accept?: true}`. `accept` makes a suggestion known. Answers `Fact`. |
| `DELETE /api/you/memories/{id}` | Deletes it for good (a suggestion too: dismissing it). `{ok: true}`. |
| `POST /api/you/erase` | Body `{confirm: "erase"}`: forgets every fact and suggestion and the About me card. `{ok: true}`; `400 confirm` without it. |
| `GET /api/you/export` | A JSON download (`pi-local-about-you.json`): `{basics, memories: Fact[]}`. |
| `GET /api/agents/{id}/memory` | Its notes, newest first: `Note[]`. |
| `POST /api/agents/{id}/memory` | Body `{text}`. `201 Note`. |
| `PATCH /api/agents/{id}/memory/{note}` | Body `{text}`. Answers `Note`. |
| `DELETE /api/agents/{id}/memory/{note}` | `{ok: true}`. |
| `DELETE /api/agents/{id}/memory` | Resets its memory: every note. `{ok: true}`. |

Every change sends a [`memory` event](#live-events).

In conversations, agents have three tools:
- `remember` `{about: "you" | "myself", text, category?, source?: "person" | "inferred" | "outside"}`. Its result's
  text says what happened, with the new ID in parentheses: `Saved (um_…, category).` (known), `Saved as a suggestion
  … (um_…); …` (a suggestion), or `Saved to your notes (an_…).` Its details say the same for apps:
  `{kind: "known" | "suggested" | "note", id, category?}` (older replies only have the text). The chat shows a "Remembered" or "Suggested" chip for
  it, whose Undo deletes the ID (`DELETE /api/you/memories/{id}`, or `DELETE /api/agents/{agent}/memory/{id}` for
  `an_`).
- `recall` `{query, limit?}` and `forget` `{id}` (something about the person only when they ask, in a conversation they
  started). Shown as ordinary tool steps.

## Fast judgments (v0.2)

Optional and off by default: quick, typed decisions by a System One model (TypeSafe's Jev, or a self-hosted service
speaking its API). The text being judged is sent to that service. Its key lives in the OS keychain and is never
returned. Each use has its own switch; `agentRouting`, `toolPreselection` and `approvals` (v0.3: see [Approval rules and profiles](#approval-rules-and-profiles-v03)) do something so far.

```ts
type JudgmentSettings = {
  enabled: boolean;
  url: string;                         // default `defaultUrl`
  model: string;                       // pinned; default `defaultModel` ("jev-1.14.0")
  hasKey: boolean;
  uses: Record<string, boolean>;       // one per `uses`
  threshold: number;                   // 0.5–0.99: below it, the app asks instead of deciding
};
```

| Route | Answer |
|---|---|
| `GET /api/settings/judgments` | `{settings: JudgmentSettings, uses: string[], defaultUrl, defaultModel}`. `uses`: agentRouting, toolPreselection, inbox, approvals, memory, knowledge, triggers. |
| `PUT /api/settings/judgments` | Body `{enabled?, url?, model?, apiKey?, uses?: {name: boolean}, threshold?}`. `apiKey` left out keeps the stored key; `""` removes it. Answers `JudgmentSettings`. Errors: `400 invalid_key` ("Paste a TypeSafe API key…", turning it on at TypeSafe's address without a key), `invalid_url`, `invalid_model`, `invalid_threshold`, `invalid_use`. |
| `GET /api/settings/judgments/models` | The service's models: `string[]`. `502 judge_failed` with a message. |
| `POST /api/settings/judgments/models` | Body `{url?, apiKey?}`: the same list with values not saved yet (the settings form's); an empty address uses the saved one, and an empty key uses the saved key only at the saved origin (never a different typed server). Nothing is saved. |
| `POST /api/settings/judgments/test` | One yes/no question with the saved settings: `{model, answer}`. `502 judge_failed` with a message for people. |
| `POST /api/route` | Body `{text}`: which agent should take a message sent without one. `{agentId, decided: boolean, confidence, alternatives: [{agentId, probability}], model}`; `decided` only above the threshold. `409 off` when agent routing is off; `400 invalid_text`. |

`GET /api/me`'s `features.agentRouting` is true while agent routing is on: the new-chat picker then offers **Auto**
(the default until the person picks an agent). With Auto, sending first asks `POST /api/route`: decided, the message
goes to that agent (the conversation says "Sent to {agent} (auto)"); not decided, a `409`, or an error, the person picks
from the likeliest agents.

Tool preselection happens in the runtime, before a model with many deferred tools (MCP) answers; it needs nothing from
the UI.

## Ask, notify and checklist tools (v0.2)

Every agent has three tools for working with the person (subagents don't):

- `ask_person` `{question, choices?: string[], yes_no?: boolean}` asks and waits up to 15 minutes. Its result's
  `details`: `{question, outcome: "answered" | "declined" | "expired" | "withdrawn", answer?: string | boolean}` (a yes/no
  answered No is `answered` with `answer: false`). The question is an
  elicitation (`server: "agent"`, `serverName` the agent's name, `tool: "ask_person"`), answered like an MCP server's:
  the cards in the conversation, `POST /api/elicitations/{id}`. Choices are an `enum` field `answer`, yes/no a boolean
  `yes`, otherwise a text `answer`.
- `notify_person` `{title, message}`: a `notification` event `{agentId, agentName, threadId, title, message}` (title at
  most 80 characters, message 300). One every 20 seconds per agent; more are refused to the agent. The desktop app
  shows a system notification while its window isn't in front; the UI shows a toast.
- `todo` `{items: [{text, status: "pending" | "doing" | "done"}]}` writes the conversation's checklist: the exposed
  document `todo` (`GET …/threads/{t}/documents/todo`, `{items}`), listed in the thread's documents.

The desktop app's notifications have buttons: **Approve** / **Deny** on an approval, **Yes, go ahead** / **Decline** on
a question whose only field is a yes/no. Clicking a notification anywhere else opens the app.

## Model per conversation (v0.2)

The person may choose a conversation's model and thinking level in the composer, by hand: nothing picks a model for
them. On by default; Settings → Models turns it off (every conversation then uses its agent's model).

| Route | |
|---|---|
| `GET /api/settings/chat` | `{modelPerConversation: boolean, thinkingLevels: ["off", "low", "medium", "high"]}`. |
| `PUT /api/settings/chat` | Body `{modelPerConversation?}`. Answers as GET. `GET /api/me` says `features.modelPerConversation`. |

- A message may carry `modelId` (a catalog model `provider/modelId`; `""` or the agent's own: the agent's) and
  `thinking` (`off`, `low`, `medium`, `high`; `""`: the model's default, which is off). Left out, the conversation keeps
  what it had. `400 invalid_model` (unknown, turned off, or the demo model), `400 invalid_thinking`.
- Thinking is kept only for a model with `reasoning`; on another it is dropped.
- The thread (`GET …/threads/{t}` and the list) has `modelId` and `thinking`, `""` for none. A choice that can no
  longer be used (its model turned off) falls back to the agent's model at the next message, and is cleared.
- Usage is counted under the model that answered.

## Hiding secrets (v0.3)

What an agent's tools return is cleaned **in the runtime** before the model sees it and before it is stored, so a token a
command printed or a server returned never reaches the model, the transcript or the screen. Two kinds of value become
`[redacted secret]`:

- **What looks like a credential**, by the rules of the approvals view (`runtime/src/lib/redact.ts`, `redactText`; the Go
  side is `RedactText` in `internal/agents/redact.go`; both read the cases in `internal/agents/testdata/redact-text.json`):
  known token prefixes (`sk-`, `ghp_`, `xoxb-`, `AKIA`, `pdp…`), a JWT, a PEM private key, an Authorization, Cookie or
  bearer value, a password in a URL, the value of `password=`, `api_key:`, `"token": "…"` and the like (a flag, a number,
  empty or a placeholder such as `$KEY` is left), and a long random-looking word (32-512 base64 characters with upper and
  lower case and digits). Hashes, UUIDs, git SHAs, long paths, identifiers and prose are left alone. A word judged by its
  parts when it holds `=`, `?`, `&`, `@` or `:` (`SHA=<hash>`, a URL's query), and a path only for a known token shape.
- **The runtime's own secrets, found by value**: its model key (`MODEL_API_KEY`), the provider's extra headers
  (`MODEL_HEADERS`), its gateway key (`PLATFORM_KEY`, `MODEL_USAGE_KEY`, `MCP_KEY`), and its MCP servers' env and header
  values that are credentials, including the servers apps give a thread: named like one (`API_KEY`, `Authorization`,
  `…_TOKEN`), looking like one (a known token format, a JWT), or long and random-looking (20+ characters of letters and
  digits, no spaces), plus a URL's password. Plain settings (`MODE=production`, `X-Org: acme`) are not hidden: they
  would corrupt every output that says the word. At least 6 characters; also as JSON-escaped or URL-encoded. The values
  are never listed in a message, a log or a setting.

Where: the tool task's `afterTool` hook (every tool's final result: MCP results, `bash`, `read`, web fetch and search,
`ask_person` answers, subagents', a program's nested calls) and, for a tool still running, what it reports on the way
(a command's streamed output, details, diagnostics), so a secret never shows on screen while it runs. Text parts only;
images and other parts pass through. Output, details, structured output and diagnostic messages are all cleaned. A
secret split across two streamed chunks is caught when the result settles. The extension is `pdp-scrub`, selected last in
every conversation (after the approvals).

**The switch.** `agent.yaml` `security: {scrubSecrets: true}`; on unless `false`, and the default isn't written. `Agent`
gains `security: {scrubSecrets: boolean}` (`PATCH /api/agents/{id}` with `{security: {scrubSecrets}}`; left out, it
leaves the setting). The app passes it as `SCRUB_SECRETS=true|false` in the runtime's environment (a change restarts the
runtime, as any configuration change does; a runtime without the variable scrubs). Settings → Agents → an agent → Tools →
Secrets: "Hide secrets from the model". Off is for an agent that has to handle tokens; its transcript then keeps them.
It only covers what tools return: a message you type, or what the model writes in a tool call, is not changed.

**Logs** are cleaned whatever the switch says, twice: the runtime formats each `console.*` line and cleans it like a tool
result (`installLogScrubbing`), and the app cleans every line it writes to `agents/<id>/logs/runtime.log`, hiding the
runtime's secret values and applying `RedactText` (`agents.LogRedactor`, the supervisor's `RedactLog`). Marks in logs and
diagnostics read `[redacted, N characters]` or `[redacted secret]`.

**The approvals view agrees.** An approval's `arguments` redact a credential inside a longer string too (a command with
`Authorization: Bearer …` reads `Authorization: [redacted, N characters]`), with the same rules; its marks keep their
length.

## Backups and diagnostics (v0.3)

### Backups

A backup is one zip in `<data>/backups/` (`pi-local-<YYYY-MM-DD-HHMMSS>.zip`, with `-auto` or `-before-update` for
those):

```
manifest.json                      what it is, see below
app.db                             VACUUM INTO: whole and compact
templates/…
agents/<id>/agent.yaml, memory.json, state.sqlite, workspace/…, tmp/attachments/…
```

- **Never secrets.** Provider keys, MCP variable and header values and sign-ins are in the OS keychain, which isn't
  copied. The manifest lists, by name only, what will need entering again on another computer (`needsKeys`). On the
  same computer the keychain still has them.
- **Workspaces are included**: each agent's own `workspace/` can be large, so is the zip; the UI shows its size.
  Not included: logs, `tmp/` (except `tmp/attachments/`), symbolic links and special files (counted in `warnings`),
  and a project folder outside the data folder (`workspace.folder`; the manifest names it).
- **An awake agent's conversations** (`state.sqlite`) are held open exclusively by its runtime, so for the copy the
  agent is put to sleep (its work in flight stays pending, as when it hibernates), the file is copied with SQLite's
  `VACUUM INTO`, and the agent wakes again (only the copy happens while it sleeps; the zip is written afterwards from
  the copies). Anything that would wake the agent waits for that moment.
- **Daily.** On by default: a backup (reason `automatic`) when the newest backup is more than a day old, looked for
  every 15 minutes from 2 minutes after the app starts. While an agent is in the middle of a reply it waits for a quiet
  moment, for up to 12 hours. Kept: the newest 7 `automatic` and the newest 3 `before-update`; `manual` backups are
  never deleted by the app.
- **Before an update.** Installing an update makes a `before-update` backup after the archive is verified and before
  anything is replaced.
- **Restore** replaces `app.db`, `agents/` and `templates/`. The running app holds app.db open, so it happens at the
  next start: the request is written to `<data>/restore-pending.json` and the app restarts (the desktop app
  relaunches itself; a build that can't says `canRestart: false` and the person quits and opens it). As it starts,
  before app.db is opened, the backup is unpacked into `<data>/restore-staging` and checked (the zip's names, a SQLite
  integrity check); only then the current data is moved to `<data>/before-restore-<YYYY-MM-DD>` (`-2`, … if taken) and
  the unpacked data moved in. A backup that fails its checks changes nothing and is reported in `lastRestore`. The
  steps after the checks are repeatable: an interrupted restore carries on at the next start. The outcome is kept in
  `<data>/last-restore.json`. Everything in the backup folder, the runtime bundle and the keychain are left as they
  are.

```ts
type BackupReason = "manual" | "automatic" | "before-update";
type KeyNeed = { kind: "provider" | "mcp" | "web-search" | "judgments"; id: string; name: string;
  items: string[] };            // "API key", "Header X-Org", "Variable GITHUB_TOKEN", "Sign-in": names, never values
type Backup = {
  id: string;                   // the file's name without .zip
  file: string; path: string;   // absolute
  createdAt: number;            // Unix ms
  size: number;                 // the zip's size on disk
  bytes: number;                // before compression
  reason: BackupReason; version: string;    // the Pi Local that made it
  agents: number;
  workspaceBytes: number;       // what the agents' workspace folders add (before compression)
  needsKeys: KeyNeed[];
  warnings: string[];           // what couldn't be included
  readable: boolean;            // false: not a backup this version can open (can't be restored)
};
type BackupList = {
  backups: Backup[];            // in the backup folder, newest first
  folder: string;               // <data>/backups
  auto: boolean;                // the daily backup is on
  keep: number;                 // automatic backups kept: 7
  running: boolean;             // a backup is being made
  autoError: string;            // why the last automatic one failed, "" if it didn't
  pending: { id: string; requestedAt: number; phase: "pending" | "applying" } | null;   // a restore waiting for the restart
  canRestart: boolean;          // the app restarts itself to restore
  lastRestore: { ok: boolean; at: number; id: string; movedTo: string /* absolute */; error: string } | null;
};
```

| Route | Answer |
|---|---|
| `GET /api/backups` | `BackupList` |
| `POST /api/backups` | Body `{folder?}` (optional; an absolute path to an existing folder: the zip goes there instead, and isn't listed or pruned). Makes a backup now (reason `manual`), which can take a while, and finishes even if the request is dropped. `201 Backup`. Errors: `400 invalid_folder`, `409 backup_running` (a backup or restore is under way), `500 backup_failed` with a message for people (for example not enough free space). |
| `PUT /api/backups/settings` | Body `{auto?: boolean}`. Answers `BackupList`. |
| `DELETE /api/backups/{id}` | `{ok: true}`; `404 not_found`. |
| `POST /api/backups/{id}/reveal` | Shows the file selected in Finder (`open -R`). `{ok: true}`. |
| `POST /api/backups/{id}/restore` | Body `{confirm: "restore"}` (`400 confirm` without it). Checks the backup, records the restore, and, when `canRestart`, restarts the app about half a second later. `{pending, restarting: boolean}`. `404 not_found`, `409 backup_running`, `400 invalid_backup` (message for people: not a backup, made by a newer Pi Local, no app.db). With `restarting: false` the UI asks the person to quit and open Pi Local. |
| `DELETE /api/backups/pending-restore` | Takes back a restore that hasn't begun. `{ok: true}`; `409 cannot_cancel` once it has. |

Live events: `event: backup`, `data: {}`.

### Diagnostics

A zip to send when something goes wrong, `pi-local-diagnostics-<date-time>.zip`:

```
README.txt, about.json            Pi Local, Node, pi-durable and OS versions, the data folder's path (home folder as ~)
settings.json                     app.db's settings (not the About me card)
providers.json, mcp-servers.json  how it is set up; names of keys, headers and variables, never their values
agents.json                       each agent: kind, model, status, last error, storage size
agents/<id>/agent.yaml            its configuration, with the instructions left out
agents/<id>/runtime.log, app.log  the last 2,000 lines of each
recent-errors.txt                 the problem lines of those, and each failed agent's error
```

Everything free-form is redacted with the approvals rules (`internal/agents/redact.go`, the Go side of
`runtime/src/lib/redact.ts`): a value whose key names a credential, a token-looking word, an Authorization or Cookie
line, a bearer token, a password in a URL, a PEM private key become `[redacted, N characters]` (the rules also hide a credential inside a longer line, and the runtime's own secret values in logs, see Hiding secrets). Conversations, memory
and files are never included. The app's own log is its recent `slog` lines (kept in memory, 2,000 lines).

| Route | Answer |
|---|---|
| `POST /api/diagnostics` | Desktop app: asks where to save (the system Save dialog) and writes the zip. `{path}`, or `{cancelled: true}`; `501 not_supported` in a browser (use `GET`). |
| `GET /api/diagnostics` | The zip as a download (`Content-Disposition: attachment`). |

## Activity (v0.3)

The audit log: what agents did and what was done to them. Each entry is one line in table `activity` of app.db. Entries
are kept 90 days and pruned daily (at start, then every 24 hours); the log survives an agent that is deleted, under the
name the agent had. Nothing here is a conversation: the most a message leaves is its first 120 characters.

```ts
type ActivityKind = "tool" | "message" | "schedule" | "ask" | "approval" | "sign_in" | "budget" | "error";

interface ActivityEntry {
  id: number;                 // grows with each entry; unique
  at: number;                 // Unix ms: when it happened (a tool call: when it ended; a schedule run: when it fired)
  kind: ActivityKind;
  agentId: string | null;     // null for what belongs to no agent (an MCP sign-in)
  agentName: string;          // as it was then
  threadId: string | null;
  actor: string;              // who: the agent, the person (the OS user's name), "Schedule: <name>", "Pi Local"
  title: string;              // one line: the tool's name, "Message sent", "Approved bash", …
  outcome: string;            // ok | error | denied | declined | refused | cancelled ("" when there is none)
  durationMs: number | null;
  detail: object;             // bounded (16 KiB) and redacted; its fields depend on the kind, below
}
```

| Kind | Recorded when | `actor` | `outcome` | `detail` |
|---|---|---|---|---|
| `tool` | a tool call ended, reported by the agent's runtime | the agent | `ok`; `error` (it failed, or never ran: unavailable, invalid arguments, interrupted); `denied` (a rule, or a person, refused it); `declined` (it asked, and nobody decided: the request timed out or was cancelled) | `{callId, arguments, error?, approval?: {status: approved \| denied \| timed_out \| cancelled, by?, source?: builtin \| rule \| profile \| tools \| judge \| author, waitedMs?, reason?}}`. `error` is what the model was told when the call failed or was refused. `durationMs` is how long the tool ran, and absent when it never ran; the time waiting for a decision is `approval.waitedMs`. |
| `message` | the person sent a message (the API accepted it) | the person | `ok` | `{preview, chars, attachments?, model?}`: `preview` is the first 120 characters on one line, anything that looks like a credential removed; `chars` the message's length. Messages from a schedule or another agent are recorded as `schedule` and `ask`. |
| `schedule` | a schedule's run ended (its reply finished, or it failed to start) | `Schedule: <name>` | `ok`, `error` | `{scheduleId, runId, error?}`; `at` is when it fired, `durationMs` how long the run took; `threadId` is the run's conversation |
| `ask` | an agent's ask to another ended | the asking agent | `ok`, `error` | `{askId, targetAgentId, targetAgent, targetThread, preview, error?}`; the entry is the asking agent's, in its conversation (`threadId`); `targetThread` is the conversation that answered |
| `approval` | a request was decided: by the person, by running out of time, or cancelled because its call went away | the person, or `Pi Local` | `ok` (approved), `denied`, `declined` (timed out), `cancelled` | `{approvalId, tool, summary?, reason?}`; `durationMs` is how long it waited |
| `sign_in` | an MCP server's sign-in ended, or it was signed out | the person | `ok`, `error`, `cancelled` | `{server, action: sign_in \| sign_out, error?}`; no agent |
| `budget` | work was refused because a budget that says stop is used up | `Pi Local` | `refused` | `{via: message \| ask \| schedule, scope: app \| agent, monthlyUsd, spentUsd}`; `title` is the message the person or model was shown. `agentId` is the agent refused. |
| `error` | a reply ended in an error; a message could not be delivered; an agent could not run | the agent, the person, or `Pi Local` | `error` | `{error}` |

Everything free-form is redacted with the approvals rules (`internal/agents/redact.go`): a tool call's arguments by key
and by value (`[redacted, N characters]`) and then word by word, so a key pasted into a command or a note is hidden too;
errors and previews as text. The runtime redacts the arguments first, and the app does it again.

| Route | Answer |
|---|---|
| `GET /api/activity` | `{items: ActivityEntry[], nextBefore: string \| null}`, newest first (by `at`, then `id`). Filters, all optional: `agent` (ID), `thread`, `kind` (one or more, comma-separated), `outcome` (one or more), `q` (matches the title, the actor, the agent's name and the detail, ignoring case), `since` (Unix ms: entries at or after it), `before` (the `nextBefore` of the previous page; a bare Unix ms time also works: entries before it), `limit` (1 to 500, default 100). `nextBefore` is null when there is nothing older. `400 invalid_kind`, `invalid_limit`, `invalid_since`, `invalid_before`, `invalid_filter`. |
| `GET /api/activity/export` | The same filters (`before` and `limit` are ignored: every match, up to 200,000) as a CSV download, `pi-local-activity-<date-time>.csv`. Columns: `time` (ISO 8601, UTC, to the millisecond), `kind`, `agent`, `agent_id`, `thread_id`, `actor`, `title`, `outcome`, `duration_ms`, `detail` (the JSON). A cell that begins with `=`, `+`, `-`, `@`, a tab or a carriage return gets an apostrophe in front, so a spreadsheet never runs it as a formula. |
| `POST /api/activity/export` | The same, for the desktop app: asks where to save (the system Save dialog) and writes the file. `{path}`, or `{cancelled: true}`; `501 not_supported` in a browser (use `GET`). |

Entries are not pushed: there is no event for them. The UI reads again when a page is shown again, and now and then
while a conversation's "What happened" panel is open.

### Tool calls, from the runtime

A runtime reports each tool call when it ends, to the gateway (the loopback port each runtime is started with, keyed by
`PLATFORM_KEY`): `POST /activity`, batched (a batch is sent after a second, or when 200 are waiting; at most 200 per
request).

```ts
// body
{ items: [{
    entryId: string,        // the call's result entry in the agent's storage: names the call even where providers repeat call IDs
    callId: string,
    threadId?: string,      // the thread whose run made the call (a subagent's call: its owner's)
    tool: string,
    arguments: unknown,     // bounded and redacted by the runtime (runtime/src/lib/redact.ts)
    outcome: "ok" | "error" | "denied" | "declined",
    durationMs?: number,
    endedAt: number,        // Unix ms
    approval?: { status, by?, source?, waitedMs?, reason? },
    error?: string          // at most 300 characters
}] }
// answer
{ data: { recorded: number } }
```

An item with no tool name, an unknown outcome, or neither `entryId` nor `callId` is dropped. A call reported twice
(`entryId` is the key) is kept once. Where it is read: pi-durable's `afterTool` hook only runs for calls that ran, so
the runtime reads each round's result entries in the generation task's `afterTools` hook, which covers a call that was
blocked, refused or never run as well. Reporting is best effort: the runtime retries a failed batch five times (1 s, then
doubling), keeps at most 2,000 waiting calls, and a call still queued when its process dies is not in the log.

## Not yet (later phases)

Signing, notarizing and bundling Node into the app (Phase 8).

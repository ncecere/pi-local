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

## Not yet (later phases)

Message search (Phase 7), approvals (Phase 4), the delta stream in the UI (Phase 6), wake/hibernate controls and the
data folder's location for an About page (Phase 3), models and providers (Phase 2).

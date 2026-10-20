# Pi Local

A desktop app for your own [Pi Durable](https://github.com/earendil-works/pi) agents, running on this computer. It
uses the chat UI of Pi Agent Interface and hosts the agents itself: each agent is a folder with its config and a
SQLite file, run by a Node runtime that the app starts when needed and puts to sleep when idle. Quit mid-reply, and the
reply finishes the next time you open the app.

## What it does

- **Chat** with your agents:
  - an inbox (working, needs you, done), streaming replies
  - steer a reply in progress
  - edit a message or branch a conversation
  - search everything said
  - attach files
- **Models:**
  - OpenAI, Anthropic, Ollama, LM Studio, OpenRouter, LiteLLM or any compatible server
  - keys in the macOS keychain
  - usage and estimated cost
- **Agents:**
  - kinds: assistant, researcher, triage
  - instructions and a raw `agent.yaml`, logs, wake and sleep
  - duplicate, export and import
- **Teams, and agents asking agents.** An agent may ask the agents it is allowed to ask (its `canCall`, or its team);
  each answers in a conversation of its own that you can read.
- **Workspace tools.** `read`, `write`, `edit` and `bash` in the agent's own folder, with **approvals**: chosen tools
  wait for you to approve or deny, even while the agent sleeps or the app is closed.
- **MCP servers:**
  - local (stdio) or remote (Streamable HTTP, headers or OAuth sign-in)
  - each agent picks servers and tools
  - import from Claude Desktop, Cursor and VS Code
- **Always on:**
  - closing the window keeps Pi Local in the menu bar
  - schedules (one-time or cron) fire, and agents may set their own
  - notifications when something needs you
  - launch at login

Status: v1 feature-complete through Phase 7 of [PLAN.md](PLAN.md). Phase 8 (bundled Node, signing, notarization,
auto-update) is next.

## Layout

| Path | What |
|---|---|
| `cmd/pi-local` | The desktop app (Wails v3): window, menu bar, notifications, launch at login; `/api` through the asset server |
| `cmd/pi-local-server` | The same app headless on `127.0.0.1:5190`, for development in a browser and tests |
| `internal/app` | Wiring, the data directory and its lock, resuming unfinished work at start; the end-to-end tests |
| `internal/supervisor` | One runtime process per awake agent: start, proxy, idle hibernation, crash restart |
| `internal/gateway` | What runtimes call back into: thread reports, approvals, asks, schedules, MCP sign-in state, usage |
| `internal/agents`, `internal/threads` | The agents and their `agent.yaml`; the thread index (listing never wakes an agent) |
| `internal/models`, `internal/mcp`, `internal/secrets` | Providers and models, MCP servers, the OS keychain |
| `internal/approvals`, `internal/asks`, `internal/teams` | Tool approvals, agents asking agents, teams |
| `internal/schedules`, `internal/search`, `internal/usage` | Schedules, message search (FTS5), usage |
| `internal/api` | The UI's API ([docs/api.md](docs/api.md)) |
| `runtime/` | The agent runtime (TypeScript, from pi-durable-platform, on SQLite), bundled to `runtime.mjs` |
| `frontend/` | The UI (React, from Pi Agent Interface) |
| `spikes/` | Phase 0 prototypes and [findings](spikes/FINDINGS.md) |

## Data

The data directory is `~/Library/Application Support/Pi Local`, or `-data` / `PI_LOCAL_DATA`.

| Path | What |
|---|---|
| `app.db` | The index of agents and threads, settings, providers, MCP servers, approvals, asks, schedules, usage, search |
| `agents/<id>/agent.yaml` | The agent's config: model, instructions, tools, approvals, MCP servers, schedules |
| `agents/<id>/state.sqlite` | Its conversations; only its runtime opens it |
| `agents/<id>/workspace/` | Its files (attachments under `attachments/`) |
| `agents/<id>/tmp/`, `agents/<id>/logs/runtime.log` | Its temporary files and its log |
| `trash/` | Deleted agents' folders |
| `runtime/` | The runtime bundle, written out by the app |

Secrets (provider keys, MCP env and header values, OAuth tokens) are kept in the macOS keychain under "Pi Local".

## Development

You need Go 1.26+, Node 22.19+ and pnpm.

```sh
make deps            # runtime and frontend packages
make build           # bin/pi-local (desktop) and bin/pi-local-server
bin/pi-local         # the desktop app (PI_LOCAL_DATA=/tmp/x to keep your real data out of it)

make run-server      # headless on :5190: agents run from runtime/src, keys in memory
make dev-web         # UI with hot reload on :5191, talking to run-server
make check           # go vet, gofmt and every test (Go, runtime, frontend)
```

The Go tests run the real runtime against fake model providers (OpenAI and Anthropic wire formats), fake MCP servers
(stdio and OAuth) and a scripted model that calls tools, and they never touch the real keychain.

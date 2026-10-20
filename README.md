# Pi Local

A desktop app for your own [Pi Durable](https://github.com/earendil-works/pi) agents, running on this computer.
It combines the chat UI of Pi Agent Interface with local agent hosting: each agent is a folder with its config and a
SQLite file, run by a Node runtime the app starts when needed and puts to sleep when idle. Quit mid-reply, and the
reply finishes the next time you open the app.

Status: **Phase 1** of [PLAN.md](PLAN.md). That covers chat, agents (create, edit, delete), the inbox, and the tray
app. Every agent runs on the scripted demo model until Phase 2 adds providers.

## Layout

| Path | What |
|---|---|
| `cmd/pi-local` | The desktop app (Wails v3): window, menu-bar icon, `/api` through the asset server |
| `cmd/pi-local-server` | The same app headless on `127.0.0.1:5190`, for development in a browser and tests |
| `internal/app` | Wiring, the data directory and its single-instance lock, resuming unfinished work at start |
| `internal/supervisor` | One runtime process per awake agent: start, proxy, idle hibernation, crash restart |
| `internal/gateway` | What runtimes report back (thread status), on its own loopback port |
| `internal/threads`, `internal/agents` | The thread index (listing never wakes an agent), and the agents with their `agent.yaml` |
| `internal/api` | The UI's API ([docs/api.md](docs/api.md)) |
| `runtime/` | The agent runtime (TypeScript, from pi-durable-platform, on SQLite), bundled to `runtime.mjs` |
| `frontend/` | The UI (React, from Pi Agent Interface) |
| `spikes/` | Phase 0 prototypes and [findings](spikes/FINDINGS.md) |

## Data

The data directory is `~/Library/Application Support/Pi Local`, or `-data` / `PI_LOCAL_DATA`. It holds:
- `app.db`: the index of agents and threads, plus preferences
- `agents/<id>/`:
  - `agent.yaml`: the agent's config
  - `state.sqlite`: its conversations, opened only by its runtime
  - `workspace/`, `tmp/`, `logs/runtime.log`
- `trash/`: deleted agents' folders
- `runtime/`: the runtime bundle, written out by the app

## Development

You need Go 1.26+, Node 22.19+ and pnpm.

```sh
make deps            # runtime and frontend packages
make build           # bin/pi-local (desktop) and bin/pi-local-server
bin/pi-local         # the desktop app (PI_LOCAL_DATA=/tmp/x to keep your real data out of it)

make run-server      # headless on :5190, agents run from runtime/src
make dev-web         # UI with hot reload on :5191, talking to run-server
make check           # go vet, gofmt and every test (Go, runtime, frontend)
```

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
  - usage and estimated cost, with list prices for well-known models, a usage drill-down, and monthly budgets
    (per agent and for the whole app) that warn or stop
- **Agents:**
  - kinds: **assistant**, **researcher**, and **coding**, which works like the pi coding agent in a project folder you
    choose: pi's coding prompt, `read`/`write`/`edit`/`bash`, and the project's `AGENTS.md` or `CLAUDE.md`
  - instructions and a raw `agent.yaml`, logs, wake and sleep
  - duplicate, export and import
- **Teams, and agents asking agents.** An agent may ask the agents it is allowed to ask (its `canCall`, or its team);
  each answers in a conversation of its own that you can read.
- **Workspace tools.** `read`, `write`, `edit` and `bash` in the agent's own folder or a project folder, with
  **approvals**: a profile (careful, balanced, trusting) and your own rules decide which tool calls wait for you to approve or deny, even while the agent sleeps or the app is closed; "Approve and always allow this" adds a rule.
- **MCP servers:**
  - local (stdio) or remote (Streamable HTTP, headers or OAuth sign-in)
  - each agent picks servers and tools
  - import from Claude Desktop, Cursor and VS Code
- **Always on:**
  - closing the window keeps Pi Local in the menu bar
  - schedules (one-time or cron) fire, and agents may set their own
  - notifications when something needs you
  - launch at login

- **Backups:** a daily backup of your agents, conversations and settings (keeping 7), one before each update, and
  yours when you want; restore from Settings → Backups. **Diagnostics** to send when something goes wrong: logs and
  settings with keys and tokens removed.
- **Updates** itself from GitHub Releases, installing only archives signed with the project's release key.

Status: v1. See [PLAN.md](PLAN.md).

## Install

Pi Local is for Macs with Apple Silicon (macOS 11 or later). It bundles its own Node, so it needs nothing else.

1. Download `Pi-Local-<version>-macos-arm64.dmg` from the [latest release](https://github.com/ncecere/pi-local/releases/latest).
2. Open it and drag **Pi Local** to **Applications**.
3. Open Pi Local. Because it isn't signed by Apple, macOS says it "can't be opened" (or that Apple "could not verify"
   it). Choose **Done**, not Move to Trash, then:
   - open **System Settings → Privacy & Security**, scroll to *"Pi Local" was blocked…*, choose **Open Anyway**, and
     confirm with your password; **or**
   - in Terminal: `xattr -dr com.apple.quarantine "/Applications/Pi Local.app"`, then open it again.

   You do this once. Updates install themselves without asking again.

To check a download, compare it with the release's `SHA256SUMS` (`shasum -a 256 Pi-Local-*.dmg`).

### Updates

Pi Local checks GitHub for a new release shortly after it starts and every 12 hours (turn this off in **Settings →
About**), and shows **Update to …** in its menu bar menu. Installing downloads the release's zip and checks its
**ed25519 signature** against the public key built into the app. It installs the new app only if the signature is
good, the archive holds exactly one Pi Local.app with the right bundle ID and version, and `codesign --verify` passes.
Before it replaces anything it makes a backup of your data (kept in `backups/`). Then it swaps the app in place,
moves the old one to the Trash, and restarts. Your data (`~/Library/Application Support/Pi Local`) is not touched.

## Releasing

Push a version tag; [.github/workflows/release.yml](.github/workflows/release.yml) does the rest on an Apple Silicon
runner: tests, `Pi Local.app` with Node, the signed update zip, a DMG, `SHA256SUMS`, and the GitHub release.

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The workflow needs the `RELEASE_SIGNING_KEY` secret: the private half of the key whose public half is
`internal/update/key.go`. It is made once with `go run ./cmd/release-sign keygen <file>`, kept outside the
repository, and never committed. `gh secret set RELEASE_SIGNING_KEY < <file>` stores it. Losing it means
releases can't be signed for existing installs, which then need a manual download. Leaking it means someone could sign
updates: make a new key, ship it in a release signed with the old one, and set the new secret.

A local release build: `make release VERSION=0.2.0` (signs when `RELEASE_SIGNING_KEY` is set in the environment).

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
| `internal/backup`, `internal/diagnostics` | Backups, restoring them at the next start, the daily one; the diagnostics zip |
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
| `backups/` | Backups (zips): daily, before an update, and yours. Settings → Backups |
| `before-restore-<date>/` | The data a restore replaced, kept until you delete it |
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

## License

MIT: see [LICENSE](LICENSE), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for what it includes.

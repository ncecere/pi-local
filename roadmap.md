# Pi Local roadmap

A proposal to review, not a commitment. Each item is described in
[suggested-features.md](suggested-features.md) (section numbers in brackets).

## Release status

- v0.1.0 and v0.2.0 are published.
- v0.3 trust/control is published as [v0.3.2](https://github.com/ncecere/pi-local/releases/tag/v0.3.2), with public
  assets and immutable-source smoke verified. v0.3.0/v0.3.1 remain unchanged, unpublished packaging attempts.
- [v0.4.0](https://github.com/ncecere/pi-local/releases/tag/v0.4.0) is published; public assets and immutable-source
  smoke are verified. Optional embeddings and a dedicated Concierge judgment recommendation are deferred. See
  [v0.4 verification](docs/qa/v0.4.md) for scope and limits. The [v0.4.1 settings/chrome UX patch](docs/qa/v0.4.1.md)
  is published with verified assets and immutable-tag layout smoke.
- [v0.5 foundations](docs/plans/v0.5.md) are in isolated implementation: portable locking, runtime environment and
  process ownership first. Windows/Linux product support is not yet claimed.
- Only the user decides when to launch v1.0.

The tables below retain proposal scope; release notes and verification records identify what actually ships.

## Initial baseline (v0.1)

A desktop app (macOS first) where your own durable agents work for you:
- chat
- models from any provider
- workspace tools with approvals
- MCP: local and remote, OAuth, sign-in commands, and questions from servers
- schedules
- teams and agents asking agents
- a menu bar presence
- signed auto-updates

Assistant, Researcher and Coding kinds.

## The idea

**Your own agents, on your own computer, that keep working.** For people in general, not one profession.
Three strengths set it apart from hosted chat apps:

1. **Local:** next to your files, your apps, your OS's keychain and notifications. Private by default.
2. **Durable:** work survives quits, crashes and sleep, so agents can take on long jobs, wait days for an approval,
   run overnight.
3. **Yours:** agents are folders you can read, export and share. Templates are files; memory is visible and editable.

What held the initial baseline back:
- **A newcomer must assemble everything:** a provider, an agent, connections.
- **Agents can't reach the web.**
- **Approvals are all-or-nothing.**
- **There's little to help you trust an agent that runs unattended:** no audit log, no budget, no sandbox.
- **It's macOS only.**

## Principles for choosing

- **For most people.** Templates, wording and defaults fit anyone. Specialist agents are something people *build*
  (the Agent builder, their own templates), not something we ship.
- **Daily use first.** What makes you open it every day comes before what demos well.
- **Safe by default.** Anything that acts (sends, runs, deletes) asks first until you say otherwise, and the approval
  shows exactly what will happen.
- **Every OS.** New features are designed once and wired to each platform. Mac-only niceties come after the
  cross-platform version.
- **Files, not magic.** Templates, kinds, memory and workflows are readable files.
- **No servers.** Everything runs on the computer; anything remote is opt-in and encrypted.

---

## v0.2: works out of the box, every day

Goal: someone new gets value in five minutes, and comes back daily. Releases stay downloads from GitHub until v1.0.

| Item | Why | § |
|---|---|---|
| First run: local model auto-detect, provider presets with sign-up links, "Make an agent" from a template | From install to a useful answer in minutes. | 7, 3.1 |
| Web search + fetch tools (Brave by default; Tavily, SerpApi, SearXNG) | Most templates and the Researcher need the web. | 4 |
| Templates gallery with: Assistant, Researcher, Writer & editor, Daily briefing, Translator, Planner; template import and export | General starting points that show what the app is for. | 3.2 |
| Act from notifications (approve, answer) | Approvals and questions without switching apps. | 2 |
| Model per conversation; thinking controls | You pick the model and reasoning effort in the composer, by hand (no automatic routing); can be turned off. | 1, 7 |
| Fast judgments (optional): settings (service URL, key, pinned models; self-hosted works), the judge component, agent routing, tool preselection | Pick the right agent without asking; small models get the right tools from large MCP servers. Off by default, with fallbacks. | 10 |
| Attachments as chips; PDF and Office reading; paste images | Real documents in. | 1, 4 |
| `ask_person`, `notify_person`, `todo` tools | Agents ask instead of guessing, tell you when done, show progress. | 4 |
| Memory M1: About me card and profile (basics shared, other categories per agent); `remember`/`recall`/`forget`; agents' own notes; Settings → You; agent Memory tab | Every agent knows who you are from day one. | 3.3 |
| QA leftovers | Known small issues. | 12 |

## v0.3: trust and control

Goal: you can leave agents running unattended.

| Item | Why | § |
|---|---|---|
| Approval rules with argument patterns; permission profiles; fast-judgment approval tightening (only ever adds a question) | Fewer clicks for safe actions, an extra check on risky ones. | 5, 8, 10 |
| Audit log + "show what the agent did" timeline | See every action; explain surprises and slowness. | 1, 8 |
| Inbox: fast judgment "does this need you?" (auto-settle informational replies) | A calmer inbox when agents run unattended. | 6, 10 |
| Budgets per agent; usage drill-down; known model prices | No bill surprises. | 3.1, 7 |
| Secret scrubbing | Tokens never reach the model or the screen by accident. | 8 |
| Sandboxed shell (macOS first, designed for all three) | Makes "Don't ask" reasonable for coding and data agents. | 8 |
| Backups, backup before update, diagnostics bundle | Durable work deserves durable data, and bugs get reported. | 9 |

## v0.4: learning, knowledge and connections

Goal: agents know your world, and connecting things is easy.

| Item | Why | § |
|---|---|---|
| Memory M2 and M3: suggestions and review (system-wide switch), trust labels, history, `search_conversations` (own conversations only), before-compaction suggestions; optional embeddings; fast-judgment suggestions | Agents learn from conversations without silent profiling. | 3.3, 10 |
| Knowledge folders + the Document Q&A template; fast-judgment reranking | "Chat with my documents", locally. Also powers Customer reply helper and Home helper. | 3.1, 3.2, 10 |
| Connections gallery (mail, calendar, notes, drives, tasks) built on MCP | Most people shouldn't need to know what MCP is. | 5 |
| Calendar tool; Inbox helper and Meeting helper templates | The most common personal workflows, once connections exist. | 4, 3.2 |
| Skills; slash commands and a prompt library | Repeatable tasks in two keystrokes. | 3.1, 1 |
| Artifacts / canvas panel | Work products you edit and keep. | 1 |
| Agent builder + Concierge templates | People make their own specialist agents; one front door. The Concierge routes with fast judgments when they're on. | 3.2, 10 |

## v0.5: Windows and Linux

Goal: the same app on every desktop.

| Item | Why | § |
|---|---|---|
| Windows and Linux builds: keychain backends, tray, notifications, packaging, auto-update | Most people aren't on a Mac. The core (Go + Node) is already portable. | 2 |
| Platform interfaces for the desktop features (notifications, share targets, OS automation) | Every desktop feature after this works everywhere. | 2, 4 |
| "Send to Pi Local" share targets / context menus on each OS | Get files and text to an agent from anywhere. | 2 |
| Sandboxed shell on Windows and Linux | Same safety everywhere. | 8 |
| CI and release for all three | One tag, three platforms. | — |

## v0.6: automation and working together

Goal: agents start on their own when something happens, and cooperate.

| Item | Why | § |
|---|---|---|
| Triggers: folder watch, calendar event, mail rule, web page change; natural-language trigger rules with fast judgments | Event-driven agents, not just schedules. | 6, 10 |
| `tell_agent`, handoff; team view; background jobs view | Async multi-agent work you can see and stop. | 4, 6 |
| Code interpreter; browser tool | Data work, and pages that need clicking. | 4 |
| More templates: Data analyst, Learning tutor, Meeting helper (after-meeting), Travel planner, Job search helper | Each uses triggers, memory or code. | 3.2 |
| Tray mini-chat; voice | Quicker, hands-free use. | 2, 1 |

## v1.0: polish

- Code signing: Apple Developer ID and notarization, and a Windows certificate. Until then, releases are
  downloaded from GitHub.

- Accessibility pass on all three OSes; window state; multiple windows ([2]).
- Group conversations; workflows (YAML) with run history ([6]).
- Test cases per agent; model fallback ([3.1]).
- Profiles (Work / Home) ([9]).
- Version history for agents ([3.1]).
- Mac-only extras: Spotlight, Shortcuts actions, Services ([2]).

## After v1.0: Pi Durable Platform

Revisit PDP integration once the local app is at v1.0 ([13]):
- **Send an agent to the cloud** to keep working or finish a job while the computer is off, then bring it back.
- **Team agents:** remote agents on PDP shared with team members, used from Pi Local next to local ones.

Until then, keep it possible: agents stay portable folders (with their own memory inside), with versioned export and
runtime contracts. Once the local app is v1.0-ready, evaluate an evolved PDP or a new sibling Go project, including
celld for per-agent SQLite state and lifecycle. Preserve agent portability rather than requiring PDP's current
per-agent PostgreSQL storage. See [the remote-execution design notes](docs/plans/post-v1-remote-execution.md); no remote
implementation is part of the pre-v1.0 roadmap, and the person still chooses the v1.0 launch.

## Later

- Visual workflow editor ([6]).
- Phone access over a private network ([9]).
- Sync between computers ([9]).
- Kinds without code and a community template gallery ([3.1]).
- The developer and integration surface ([11], parked): CLI, local API, agents as an MCP server, launchers,
  SDK, other agent platforms.

---

## Decisions

1. **Web search:** several backends behind one tool: Brave Search (default), Tavily, SerpApi, SearXNG.
2. **Memory** ([3.3]): a shared "about you" (basics by default, categories per agent) plus each agent's own memory;
   automatic self-notes and "you told me" facts; suggestions behind one system-wide switch; agents search only their
   own conversations; existing agents get memory switched on; memory-mcp stays a separate server.
3. **Sandbox:** each OS's own sandbox (`sandbox-exec`, bubblewrap, AppContainer).
4. **Code signing:** at v1.0. Until then, downloads from GitHub Releases.
5. **Telemetry:** none until there are other users.
6. **Workflows:** deferred until triggers exist; format decided then.
7. **Templates:** import and export of template files from v0.2; a downloadable gallery later.
8. **Fast judgments:** optional; approved uses are agent routing, tool preselection, inbox, approval tightening,
   memory suggestions, knowledge reranking and trigger matching, each with its own switch. Model routing is out. The
   service URL, key and models are configurable (self-hosted works), and the model version is pinned.
9. **Not wanted:** a global quick-ask hotkey; model routing.
10. **Releases:** each version ships when it's ready (v0.2.0 …), with patch releases between. Build, test,
    review, end-to-end QA and fix, then tag; verify the released artifacts and run a post-release smoke test. The agent
    may cut pre-1.0 releases autonomously. The person chooses when to launch v1.0.
11. **Connections gallery, first set** (v0.4): sign-in-and-done remote MCP servers (Notion, GitHub, Linear, Atlassian,
    Asana); Microsoft 365 and Google for mail, calendar and files, marked Advanced until their servers don't need your own
    OAuth app; Apple Calendar, Reminders and Notes on this computer (macOS first).
12. **Implementation agents:** use `openai-codex/gpt-6.1-sol` for implementation, reviews and QA. No Anthropic models;
    interrupted Claude work is recovered from its files by fresh GPT agents, not resumed on its old provider.

## Still open

- Nothing right now.

## v0.2 order

1. First-run flow with local model auto-detect
2. Web search + fetch
3. Templates gallery with the six general templates, import and export
4. Memory M1 (About me, profile, `remember` / `recall` / `forget`, agent notes, You page)
5. Fast judgments: settings, agent routing, tool preselection
6. Actionable notifications
7. Model per conversation
8. Attachments and PDF reading
9. The QA leftovers

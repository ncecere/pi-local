# Suggested features

Everything that could go into Pi Local, so we can choose. [roadmap.md](roadmap.md) proposes an order. Nothing
here is decided.

**Effort:** **S** is up to a day, **M** a few days, **L** a week or more, **XL** a project of its own.

Pi Local is a desktop app where your own **durable agents** (each a folder with a SQLite file) work for you:
- models from any provider
- workspace tools and MCP servers
- approvals and questions back to you
- schedules
- teams, where one agent asks another

It's for **people in general**, not one job. Features and templates should make sense for anyone, with your own
use cases as examples you can build, not as defaults. The core stays the same on macOS, Windows and Linux, and
desktop integrations sit behind one interface per OS.

---

## 1. Chat and conversation

| Feature | What and why | Effort |
|---|---|---|
| **Model per conversation** | Pick the model in the composer, not only per agent: cheap and fast for quick questions, strong for hard ones, same agent. | M |
| **Artifacts / canvas panel** | Long outputs (a document, code file, table, email draft, diagram) open in a side panel you can edit, version, copy and save, instead of scrolling past them. It builds on the existing Documents panel. | L |
| **Attachments as chips** | Attached files as chips with icon, name and size, not injected text. Drag and drop and paste, including images. | S |
| **Images in and out** | Paste screenshots for vision models; show generated images inline. | M |
| **Read PDFs and Office files** | PDF, DOCX, XLSX and PPTX become clean text (and page images for vision models). | M |
| **Conversation tree** | Edit and branch exist, but each branch looks like a new conversation with the same title. Show branches as a tree, name them, switch in place. | M |
| **Pinned context** | Pin a message, file or snippet so it stays in context for the whole conversation, and survives compaction. | M |
| **Slash commands and a prompt library** | `/summarize`, `/translate`, `/reply`: saved prompts with variables, per agent or global. | M |
| **@-mentions** | `@Writer tighten this` in any conversation asks another agent inline. | M |
| **Quote and reply** | Select part of a reply and ask about just that. | S |
| **Better steering** | Keep the streaming reply in view when you steer mid-reply (QA finding); show steering as a small marker. | S |
| **Show what the agent did** | One click from a reply: a timeline of steps (model calls, tools, timings, tokens, cost). That's "why did it do that" and "why was it slow". | M |
| **Copy as Markdown / rich text** | Copy a reply formatted for email, docs or chat apps. | S |
| **Voice** | Dictation in the composer (the OS's, or Whisper through your provider) and replies read aloud. | M |
| **Asked agent shows who asked** | In an asked agent's conversation, show the asking agent as the speaker, not "you" (QA finding). | S |
| **Folders and tags for conversations** | Beyond pinned, settled and archived. | M |
| **Search everywhere** | Messages, tool outputs, documents and attachments, with filters. | M |

## 2. Desktop (every OS)

Each of these is designed once, then wired to each platform's equivalent.

**Not wanted:** a global quick-ask hotkey.

| Feature | What and why | Effort |
|---|---|---|
| **Act from notifications** | Approve or Deny, and answer an agent's yes/no question, right in the system notification. | M |
| **Tray mini-chat** | The tray / menu bar icon opens a compact chat, not just status. | M |
| **"Send to Pi Local"** | Share targets and context-menu entries: the system Share sheet on macOS, the Share target and Explorer menu on Windows, desktop portals on Linux. They send a file, page or selection to an agent. | L |
| **Windows and Linux** | The keychain becomes Credential Manager / Secret Service, and tray, notifications, packaging and auto-update differ per OS. The Go and Node core is already portable. | XL |
| **Signed and notarized builds** (at v1.0; until then, downloads from GitHub Releases) | No more "Open Anyway" on macOS (Apple Developer ID) or SmartScreen warnings on Windows (code-signing certificate). | S per OS, once there's an account |
| **Universal macOS build (Intel)** | A second Node binary, plus a universal Go binary. | M |
| **Window state and multiple windows** | Remember size and position; open a conversation in its own window. | M |
| **Restore drafts and scroll** | Per conversation: unsent text and scroll position. | S |
| **Accessibility pass** | Screen readers (VoiceOver, Narrator, Orca), reduced motion, keyboard-only use. | M |
| **Mac-only extras** | Spotlight entries, Apple Shortcuts actions, Services menu. Optional, after the cross-platform base. | M each |

## 3. Agents and templates

### 3.1 Agent features

| Feature | What and why | Effort |
|---|---|---|
| **Templates gallery** | "Start from" becomes a gallery: built-in templates (below) plus your own. A template is a ready agent.yaml (kind, instructions, tools, suggested connections, schedules), so it's a file: **import and export from the start**; a downloadable gallery later. | M |
| **Make your own kinds without code** | A kind defined in a folder: a prompt file, a tools list and optional skills. Today a new kind needs TypeScript. | L |
| **Memory** | About you (shared by all agents) and each agent's own memory. See §3.3. | L |
| **Knowledge folders** | Point an agent at folders of documents and notes. They're indexed locally (full-text, with optional embeddings), and the agent gets a `search_knowledge` tool. That's "chat with my documents" with no server. | L |
| **Skills** | Reusable playbooks in the open `SKILL.md` format, per agent or shared. | M |
| **Agent profile** | Avatar upload, color, and a short "who I am" that other agents read when choosing whom to ask. | S |
| **Version history** | Every agent.yaml change kept: diff and roll back. | M |
| **Clone with or without memory** | Duplicate as "fresh" or "with its memory and knowledge". | S |
| **Agent health** | Per agent: success rate, cost per conversation, slowest tools, error trends. | M |
| **Budgets** | Max cost per day, month or conversation; warn at 80%, stop at 100%, "allow once". | M |
| **Model fallback** | If the model errors or is overloaded, retry on a named fallback model. | M |
| **Instructions helper** | "Improve these instructions": rewrite an agent's prompt and show the diff. | S |
| **Test cases per agent** | Saved example questions with expected properties, run against instruction or model changes. | L |

### 3.2 Templates to ship

The templates are for most people. Each one works with **built-in tools** (web, files, memory, knowledge,
calendar) and gets more useful when you **connect** something, like a mail account or a notes app (via MCP). When
a connection is missing, the template says so and offers to set it up; it doesn't fail.

A template is a starting point: instructions, tools, approvals and an optional schedule, all editable after.

**Everyday:**

| Template | What it does | Needs |
|---|---|---|
| **Assistant** | General help (exists). | none |
| **Researcher** | Plans, searches the web, reads sources, writes a cited report (exists; gains web tools). | web tools |
| **Writer & editor** | Drafts, rewrites, shortens, changes tone; follows a style guide you give it; works on files in a folder. | files |
| **Daily briefing** | A morning summary on a schedule: today's calendar, weather, top news on topics you pick, and unread mail if connected. | web; calendar and mail optional |
| **Inbox helper** | Summarizes mail, flags what needs you, drafts replies; never sends without your yes. | a mail connection |
| **Meeting helper** | Before: who's coming and context. After: notes cleaned up into a summary and action items. | calendar; notes or files |
| **Document Q&A** | Answers questions from your own documents with citations to the file and page. | knowledge folder |
| **Translator** | Translates text or whole files, keeping formatting; remembers terms you correct. | memory, files |
| **Learning tutor** | Teaches a topic step by step, quizzes you on a schedule (spaced repetition), tracks progress. | memory, schedule |
| **Planner** | Turns a goal into a plan and a checklist; checks in on a schedule. | todo, schedule |

**Work and study:**

| Template | What it does | Needs |
|---|---|---|
| **Data analyst** | Opens CSV or spreadsheet files, cleans them, answers questions, makes charts. | code interpreter, files |
| **Coding** | Works in a project folder like the pi coding agent (exists; asks before commands). | workspace |
| **Code reviewer** | Reviews a diff or a folder for bugs, security and readability. | workspace, git |
| **Docs writer** | Writes and updates README and documentation from the code or notes in a folder. | workspace |
| **Presentation helper** | Turns notes into a slide outline and speaker notes; reviews a deck for clarity. | files, Office reading |
| **Job search helper** | Tailors a resume and cover letter to a posting; prepares interview questions. | files, web |
| **Customer reply helper** | For anyone answering customers (small business, support): drafts replies in your tone from a knowledge folder of policies; you approve before sending. | knowledge; a mail or helpdesk connection optional |

**Life:**

| Template | What it does | Needs |
|---|---|---|
| **Travel planner** | Researches and compares options, builds an itinerary, keeps a packing list. | web, todo |
| **Meal planner** | A week of meals from your preferences and what you have; makes the shopping list. | memory |
| **Personal finance helper** | Reads exported statements (CSV) you give it and summarizes spending. Read-only, no accounts connected; says clearly it isn't financial advice. | files, code interpreter |
| **Home helper** | Manuals and warranties in a knowledge folder; reminders for maintenance. | knowledge, schedule |

**Meta:**

| Template | What it does |
|---|---|
| **Concierge** | One front door: it knows your other agents and their descriptions, and routes your request or asks the right one. |
| **Agent builder** | Describe what you want; it drafts the agent (instructions, tools, connections, schedule) for you to approve. This is how people make their own specialist agents: the IT-ops, homelab or domain-specific ones. |
| **Second opinion** | Other agents ask it to check their work, using a different model, before answering you. |

**Not shipped as templates:** domain-specific agents (service desk triage, incident response, vulnerability
management, media servers, homelab) are great **examples** of what the Agent builder and the gallery's "your own
templates" can make. They're also candidates for an optional, shareable template pack, but not defaults for everyone.

### 3.3 Memory and personalization

Every agent should know who you are, and each agent should remember what it has learned about its own job. The
rules follow `memory-mcp`'s design (`~/projects/mcp-servers/MEMORY_DESIGN.md`): trust levels, suggestions you review,
newer facts replacing older ones, real deletion. They're simplified for one person on one computer: SQLite, no
separate worker.

**memory-mcp stays a separate server.** It's for use elsewhere later, and you can connect it like any MCP server.
Pi Local's memory is built in and doesn't depend on it.

**Three kinds:**

| | About you (shared) | Agent memory (each agent) | Past conversations |
|---|---|---|---|
| Holds | Name, role, time zone, how you like answers, people and projects, preferences | What the agent learned about itself and its job: what works, mistakes to avoid, your instructions to it, which agent to ask for what | Everything already said |
| Stored | The app's database, separate from every agent | **In the agent's folder**: export, duplicate and "clone with memory" carry it | The existing search index |
| Reaches the agent | A short "about you" section every turn, **filtered per agent** | A short "what I've learned" section every turn | `search_conversations`, **only its own conversations** |

**Decisions:**

1. **Visibility:** agents see **the basics** by default (name, role, time zone, language, answer style). Each
   other category (people, projects, health, family, finances, …) is turned on per agent.
2. **Saving:**
   - **Agents save notes about themselves automatically**, visibly ("Remembered: …"), with Undo.
   - **About you:** a clear "you told me" fact, said by you in a conversation you were in, saves directly, also with
     the chip and Undo.
   - Anything inferred, or from a scheduled run or another agent, is a **suggestion** you review.
3. **Learning from conversations:** agents suggest memories at the end of a conversation and before compaction.
   This is **one system-wide switch** in Settings → You, on or off. With fast judgments on, "is this worth
   remembering?" (§10) filters the suggestions.
4. **Past conversations:** an agent can search **only its own** conversations.
5. **Trust:**

   | Where it came from | Saved as | Can reach the always-on profile? |
   |---|---|---|
   | You said it | a fact | yes |
   | The agent concluded it | a suggestion until you accept it | yes, once accepted |
   | Outside text (web page, mail, ticket, tool result) | searchable, labeled | **never** |

   Outside text never reaching the profile blocks "an email told the agent to remember X".

**Tools:**
- `remember` (scope: about you, or about itself), `recall`, `update` (keeps history), `forget` (deleted means deleted)
- `search_conversations`

**Where you see it:**
- **Settings → You:**
  - an About me card, prefilled from the computer (name, time zone, language)
  - learned memories by category, each with the agent and conversation it came from; edit, pin, delete
  - suggestions waiting for review
  - the categories each agent may see
  - the learning switch
  - export, erase everything
- **Agent → Memory tab:** its notes; edit, delete, reset.
- **In chat:** "Remembered: …" with Undo; "3 suggested memories" after a conversation.

**Existing agents** get memory switched on when M1 ships (basics only, like new agents).

**The basics:** name, role, organization, time zone, language, how to address you, answer style, sign-off.
**Categories, per agent:** people, projects, work, health, family, finances, home, interests.
**Profile size:** the always-on "about you" section is capped at about 1,000 tokens; the rest is reachable with
`recall`.

**Privacy:** everything is stored locally. The profile goes only to the model provider the agent already uses, and
the You page says so.

**Phases:**
- **M1:** About me card + profile section; `remember` / `recall` / `forget`; the You page; the Memory tab;
  per-agent categories; FTS search.
- **M2:** suggestions and review; trust labels; replacement with history; `search_conversations`; suggestions
  before compaction.
- **M3:** optional embeddings (configured or local model); merging duplicates; summarizing old episodes; people and
  project entries.

## 4. Tools agents can use

Today: `read`, `write`, `edit`, `bash`, schedules, `ask_agent`/`list_agents`, the Researcher's subagents, plus MCP.

| Tool | What and why | Effort |
|---|---|---|
| **web_search + web_fetch** | The biggest gap: agents can't go online without an MCP server. Built in, with several backends behind one tool: **Brave Search (default)**, Tavily, SerpApi and SearXNG (self-hosted), each with its key or URL in Settings. Fetch returns readable Markdown with a size cap. | M |
| **ask_person** | The agent asks *you* a structured question mid-task (choice, form, yes/no), with the same card as MCP questions, instead of guessing. | S |
| **notify_person** | A system notification from the agent (rate-limited): "Your report is ready." | S |
| **todo / plan** | A visible checklist the agent keeps while it works. | S |
| **remember / recall** | Long-term memory (3.1). | with memory |
| **search_knowledge** | Knowledge folders (3.1). | with knowledge |
| **Code interpreter** | Python or JavaScript in a sandbox (temp folder, network off unless allowed) for data work, files and charts. | L |
| **Office and PDF reader** | Text, tables and images out of documents in the workspace. | M |
| **Browser** | Drive a real browser for pages that need clicking or logging in. Asks first. | L |
| **http_request** | Call a web API directly: allowed hosts per agent, secrets from the keychain. | M |
| **git** | Structured git tools instead of raw shell: safer to approve. | M |
| **Calendar and reminders** | The OS calendar where there is one, or CalDAV / ICS: read events, add reminders (asks first). | M |
| **Clipboard** | Read or write the clipboard (asks first). | S |
| **open / reveal** | Open a link or file for you, or show it in the file manager. | S |
| **Screenshot** | Capture a window or region for vision models (asks first). | S |
| **Image generation** | Through the provider's image models. | S |
| **wait / timer** | Durable "continue in N minutes"; survives restarts. | S |
| **tell_agent / handoff** | Fire-and-forget message to another agent; pass a conversation over. | M |
| **OS automation** | macOS Shortcuts and AppleScript, Windows PowerShell scripts, Linux scripts: one "run automation" tool with per-OS backends. Always asks, with the exact script shown. | M |

## 5. MCP and connections

| Feature | What and why | Effort |
|---|---|---|
| **Connections gallery** | Common connections (mail, calendar, notes, cloud drives, chat apps, task managers) as one-click entries: install the MCP server, sign in, done. Built on the MCP registry. Most people shouldn't need to know what MCP is. | L |
| **Resources and prompts** | MCP resources you can attach, and prompts as slash commands. Tools only today. | M |
| **Approval rules with argument patterns** | "Always allow reads", "ask for shell commands except `git status`". Fewer clicks, still safe. | M |
| **Shared server instances** | One instance of a heavy server for several agents. | L |
| **Per-agent settings for a server** | The same server, with different env values per agent. | M |
| **Server health and logs** | stderr log, restart count, last error on the server's row. | S |
| **URL-mode questions** | MCP elicitation's URL mode (open a consent or sign-in page), as well as forms. | S |
| **Import from other apps** | Already imports MCP servers from Claude Desktop, Cursor and VS Code. Add more apps, plus model providers (Ollama, LM Studio, pi's model list and others). | S each |
| **OAuth polish** | Token expiry shown, re-sign-in reminders, revoke. | S |

## 6. Automation and multi-agent work

| Feature | What and why | Effort |
|---|---|---|
| **Triggers beyond schedules** | Start an agent when something happens: a file lands in a folder, a calendar event is about to start, mail matching a rule arrives (via a mail connection), a web page changes. | L |
| **Workflows** | A saved pipeline ("every Monday: research X → write summary → send me"), with run history; YAML first, a visual editor later. | XL |
| **Group conversations** | Several agents in one conversation, answering when @-mentioned; you moderate. | L |
| **Team view** | See a team lead's fan-out to members live. | M |
| **Background jobs view** | Everything running across agents (asks, schedules, long tools), with stop buttons. | M |
| **Retry and resume** | Retry a failed step; resume from step N with another model. | M |
| **Inbox rules** | Auto-settle or pin by agent. | S |

## 7. Models and cost

| Feature | What and why | Effort |
|---|---|---|
| **Local model auto-detect** | Find Ollama and LM Studio and offer their models. Free, private models with no setup. | S |
| **Provider presets with sign-up links** | The first-run flow walks a newcomer to a working model (a key, or a local model). | S |
| **Prices for known models** | Filled in automatically from a bundled or fetched price table. | S |
| **Usage drill-down** | By agent, conversation and tool; cost per answer; CSV export. | M |
| **Thinking controls** | Reasoning effort per conversation, where supported. | S |
| **Prompt caching insight** | Cache hits per conversation. | S |

## 8. Security, privacy and trust

| Feature | What and why | Effort |
|---|---|---|
| **Sandboxed shell** | `bash` and code run confined to the workspace with network off by default, using each OS's own sandbox: macOS `sandbox-exec`, Linux bubblewrap, Windows AppContainer. It makes "Don't ask" safe for many agents. | L |
| **Permission profiles** | Named presets per agent ("Read-only", "Workspace", "Trusted"). | S |
| **Audit log** | Every tool call, approval, question, send and file change, searchable and exportable. | M |
| **Secret scrubbing** | Redact keys and tokens from tool outputs and file reads before they reach the model or the screen. | M |
| **Encrypted export and backup** | Passphrase-protected agent exports and backups. | S |
| **Where your data goes** | Per provider and connection: what leaves the computer. Warn when a sensitive agent (mail, documents) uses a remote model. | S |
| **App lock** | Optional OS authentication (Touch ID, Windows Hello) to open the app or approve risky actions. | M |
| **Review commands before first run** | Show a sign-in or connection command before it runs as you. | S |

## 9. Data and reliability

| Feature | What and why | Effort |
|---|---|---|
| **Backups** | Automatic snapshots of app.db and agent folders, kept N deep, restore from Settings. | M |
| **Backup before update** | Snapshot before an update installs; offer rollback. | S |
| **Diagnostics bundle** | "Report a problem": logs, versions, redacted config in one zip. | S |
| **App log viewer** | The app's own log in Settings. | S |
| **Beta update channel** | Opt in to pre-releases. | S |
| **Storage management** | Size per agent and conversation; clean up old conversations. | S |
| **Profiles** | Separate data folders (Work / Home) with a switcher. | M |
| **Sync between computers** | Encrypted folder sync with one owner at a time. Hard. | XL |
| **Phone access** | Reach your agents from a phone, over a private network. | L |

## 10. Fast judgments (optional): TypeSafe System One / Jev

An **optional** layer for quick, typed decisions the *app* makes, answered by a System One model such as Jev
(TypeSafe). Jev returns typed answers with calibrated probabilities: Choice (one of a set), Noul (yes/no), and
Score (a scale).

It is **off by default**, and every use has a fallback, so the app works exactly the same without it. It doesn't
replace the agent's main model, and it never decides tool use inside a run.

- **Settings → Models → Fast judgments:** the **service URL** (TypeSafe's, or a self-hosted System One
  deployment), the **key** (kept in the keychain), and the **models** it offers (listed from the service, or entered
  by hand). Each use has its own on/off. The screen says plainly that the text being judged is sent to that service.
- **Model version is pinned** (e.g. `jev-1.14.0`, not `jev-latest`), so behavior and thresholds stay stable; the
  app notes when a newer version is available, and you switch when ready.
- **One "judge" component in the app**, with these backends:
  - **TypeSafe**
  - **an LLM you've configured** (structured output, less well calibrated)
  - **none**: today's behavior
- **Confidence gating:** act when it's sure; otherwise fall back (you choose, or the LLM decides). Thresholds are
  settings, per pinned model version.
- **Limits to keep in mind:** a hosted API (data leaves the computer, unless self-hosted), text only, English is best, 64k context,
  and an extra network round trip for each judgment.

| Use | Status | What it does | Fallback |
|---|---|---|---|
| **Agent routing** | **Approved, first use** | Picks which agent handles a message: the Concierge, a new chat sent without choosing an agent, or an @-mention without a name: a Choice over your agents' names and descriptions. Low confidence: it asks you, offering the top two. | You pick, or the Concierge's LLM routes |

| Tool preselection | **Approved** | With large MCP servers (dozens of tools), a yes/no per tool on the message, so only likely tools are preloaded. This helps small models that skip `tool_search`. | `tool_search` |
| Inbox: does this need you? | **Approved** | Auto-settle replies that are informational. | Everything lands in the Inbox |
| Approval tightening | **Approved** | "Does this call affect other people?" Only ever *adds* a question; never skips one. | Approval rules alone |
| Memory candidates | **Approved** | "Is this worth remembering?" The result is suggested to you, never saved silently. | The agent decides |
| Knowledge reranking | **Approved** | Rerank search hits from knowledge folders. | Search order |
| Trigger matching | **Approved** | Natural-language rules on incoming items (e.g. mail about a deadline). | Keyword rules |

Every approved use has its own on/off switch, and all are off until a TypeSafe key is added.

**Not wanted:** model routing (choosing a cheap or strong model by how hard a message looks). The agent's model,
or the one picked per conversation, is always the one used.

## 11. Parked: developer and integration surface

Not now. Revisit when the app itself is mature:
- a command-line tool and a local API with tokens;
- an OpenAI-compatible endpoint where agents act as models;
- Pi Local as an MCP server, so other apps can call your agents;
- launcher extensions (Raycast, Alfred, PowerToys Run);
- a kinds SDK;
- importing or sharing sessions with other agent apps.

Pi Durable Platform integration is not parked: it's the planned direction **after v1.0** (see §13).

## 12. QA leftovers (small, known)

- An asked agent's conversation shows the asking agent's message as yours.
- Attachments shown as text rather than chips.
- Steering scrolls the streaming reply out of view.
- Edited and branched conversations have identical titles.
- A declined MCP question reads "A step failed" (should read "Declined"); denied tools read "A step was not run".
- Disabling a model silently changes the default model; say so.
- Schedule edit can't move a schedule to another agent; a finished one-time schedule still offers Pause.
- Inconsistent date formats (24 h vs 12 h; ISO dates on Usage).
- The sign-in dialog shows the command shell-escaped; show argument rows.
- Copy says "kept in the system keychain" even when secrets are in memory (dev server only).
- The ask tools' names aren't visible on the agent's page.
- A raw `<harness>` tag appears in copied text of denied tool results.

## 13. After v1.0: Pi Durable Platform (PDP)

Once the local app is at v1.0, revisit PDP integration. The goals:

- **Send an agent to the cloud:** hand a local agent (its folder: config, storage, memory) to a PDP server to keep
  working or finish a long job while the computer is off, then bring it back.
- **Team agents:** a team shares remote agents on PDP; members talk to them from Pi Local next to their own local
  agents.

Keep this possible until then, without building it:
- Agents stay **portable folders**. The export format and the runtime contract stay compatible with PDP's.
- The agent's own memory lives **in its folder**, so it travels with the agent. Your "about you" memory stays local
  unless you choose to share it.
- No local feature should assume an agent is always on this computer.

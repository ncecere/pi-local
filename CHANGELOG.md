# Changelog

Each version's section is its release notes on GitHub.

## 0.4.0

Learning, knowledge and connections.

- **Conversation learning:** optional idle and before-compaction suggestions, behind one global switch that starts
  off. Inferred facts stay suggestions until reviewed. Facts show their source/trust and edit history; agents can
  search only their own conversations. Optional fast judgments filter suggestions.
- **Knowledge folders:** index selected local text, Markdown, PDF and Office files; search passages with citations,
  see indexing errors and rescan. Document Q&A is a starting template. Knowledge files are read-only to file tools;
  optional fast judgments rerank results, respect stopped budgets and record unpriced auxiliary usage.
- **Skills and prompts:** per-agent/shared skills, ZIP import and supporting-file viewing; a prompt library with
  import/export, placeholders and keyboard slash commands.
- **Canvas:** keep Markdown, code, CSV and HTML artifacts beside a conversation; edit, review versions, copy,
  download or save to the workspace. Unsaved drafts survive panel/layout and conversation changes in memory; only
  explicit Save/Discard clears them, while reloading or closing the window loses them. HTML previews strip
  active/navigation content and use a no-script sandbox.
- **Agent builder:** propose agents and owned-agent updates with knowledge folders, installed skills and schedules.
  Every change requires human approval of the full normalized configuration, regardless of permission profile.
  Stale proposals are refused; committed updates recover their config files after interruption.
- **Concierge:** a front door that can ask only the agents explicitly allowed by your choices or team permissions.
  It does not select models automatically.
- **Connections:** a curated MCP gallery with agent selection and honest sign-in/error states. Some services require
  advanced custom OAuth/token setup; opening a browser is not treated as successful sign-in.
- **Personal helpers:** Apple Calendar, Reminders and Notes connections on macOS; Apple creations require native-host
  confirmation. Calendar reads are bounded and do not expand recurring instances. Meeting helper is capability-gated;
  Inbox helper appears only for a tested compatible mail connection and selects two read-only mail tools, with reply
  drafts kept in chat—not sent or saved to the mailbox.

Optional embeddings and a dedicated fast-judgment recommendation inside Concierge are not included. Native Automation
permission and real cloud sign-in round-trips are not claimed as tested; see the verification record in `docs/qa/v0.4.md`.

## 0.3.1

Trust and control. This is the first published v0.3 build: the v0.3.0 tag passed application checks, but its packaging
job stopped before publication because Corepack selected the wrong pnpm version. Packaging now enters each project's
directory before running its pinned package manager. The original tag is retained unchanged.

- **Approval profiles and rules:** choose Careful, Balanced, Trusting or Custom. Add rules for tools and arguments,
  approve once or remember a command, and always ask before built-in risky operations. Optional fast judgments can
  add an approval, never remove one.
- **Sandboxed commands on macOS:** new agents run commands with writes limited to their workspace and temporary
  folders, protected credential locations, and a network switch. Existing agents keep their previous setting.
- **Hide secrets:** credentials are removed from tool results before reaching the model or transcript, and from logs.
  Each agent has an on/off switch for result scrubbing; logs remain scrubbed.
- **Monthly budgets:** limits for an agent or the whole app, with warnings near the limit and a choice to stop or keep
  working. Usage filters, monthly views, and list prices for recognized models make spending easier to understand.
- **Backups and restore:** automatic daily backups, manual backups, a backup before an update installs, and restore
  with your current data moved aside. Secrets aren't included. Save a redacted diagnostics bundle when reporting a bug.
- **Activity:** see calls, approvals, messages and scheduled runs in Settings, on each agent, or in a conversation's
  “What happened” panel. Filter and export the log as CSV. Cancelled and expired approvals are recorded even when a
  reply is stopped.
- **Security:** fast-judgments requests cannot redirect credentials or judged text to another origin. Command rules
  remembered from an approval respect whole-word boundaries (`ls` never allows `lsof`). Workspace file tools refuse
  dangling symlinks and check normalized home/file-URL paths before permitting access. Document conversion uses
  the same guarded cache operations. Reused provider tool-call IDs no longer attach old decisions/results to new
  actions or hide their pending approval cards; presentation uses durable call-occurrence identities.
- **Distribution notices:** packaged dependency licenses, copyright notices and pinned provenance now ship inside
  the app, assembled and checked before signing.

## 0.3.0

Unpublished packaging attempt. The tag is retained for traceability; use v0.3.1 for the tested application features
and corrected distribution packaging.

## 0.2.0

Works out of the box, every day.

- **First run:** finds Ollama or LM Studio on this computer, offers the common providers with links to get a key, and
  makes your first agent from a template.
- **Templates:** Assistant, Researcher, Writer & editor, Daily briefing, Translator, Planner and Coding. Save any agent
  as a template; import and export template files. A new agent left unnamed gets a friendly name.
- **Web search and reading pages** (Brave, Tavily, SerpApi or SearXNG), set up in Settings → Models.
- **Memory:** an About me card every agent knows, facts agents learn about you (you review what they only guessed),
  each agent's own notes, and which agents see what (Settings → You, and each agent's Memory tab). "Remembered" in
  the conversation, with Undo.
- **Choose the model and thinking level per conversation**, in the message box (it can be turned off).
- **Files:** attachments show as files, not text; paste screenshots; agents read PDF, Word, Excel and PowerPoint files;
  images go to models that can see them, resized to fit.
- **Agents ask you** (with choices or yes/no), **notify you**, and **keep a checklist** beside the conversation.
- **Answer from the notification:** approve or deny a tool, or answer a yes/no question, from the macOS notification.
- **Fast judgments (optional):** a TypeSafe System One model picks the right agent when you don't ("Auto"), and
  loads the right tools for agents with large MCP servers. Off unless you set it up; self-hosted works.
- **Security:** `bash` commands no longer inherit the agent runtime's environment. Before, a command could read the
  agent's model key and the app's per-agent gateway key; now it gets only a minimal environment (PATH, HOME, locale).
- Many fixes: agents that asked another agent show as themselves; steps read "Declined" and "Denied"; dates follow
  your locale; edited and branched conversations are named apart and keep their model; schedules can move to another
  agent; clearer copy in many places.

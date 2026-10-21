# Changelog

Each version's section is its release notes on GitHub.

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

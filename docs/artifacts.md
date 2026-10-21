# Using the canvas

Ask your agent to make an artifact: “Draft the report as a Markdown artifact” or “Keep this table as a CSV artifact.”
The **Canvas & documents** panel appears beside the conversation (or opens as a drawer in a narrow window). Choose
an artifact to view it. Your checklist and other conversation documents still use the same panel.

- **Edit** changes the source text. **Save revision** keeps a new version; it doesn't change the chat transcript.
  The agent can read your changes. If someone changed the artifact while you were editing, your save is refused
  and your draft stays in the editor. Copy it before discarding the draft to review the latest version.
- **History** lets you read the last three saved versions. Choose **Current** to edit again.
- **Copy** copies the source (or your unsaved draft). **Download** saves the current source through the desktop Save
  dialog, or your browser's downloads. Historical versions can be copied, but aren't edited in place.
- **Save to workspace**, for an agent with the write tool enabled, copies current content to a relative file path
  such as `report.md`. It replaces that file. It cannot write outside the workspace, even through a symbolic link.

Code is highlighted, never run. HTML previews cannot run scripts, navigate, submit forms or use the network; only
passive formatting and inline styles are shown. Downloaded files contain the original source: review them before
opening them in another app, which may not have these protections. CSV previews display formulas as text.

A conversation can hold ten artifacts. Each revision is at most 64 KiB of text; the full document, including its
retained history, is at most 750 KiB of JSON. A write that exceeds a limit is refused without losing saved content.

Artifacts stay in the agent's conversation database. Include conversations when exporting the agent to carry them
to another computer. Branching a conversation copies the current artifacts; later changes stay on their own
branch. Editing before the first message starts fresh, with no artifacts.

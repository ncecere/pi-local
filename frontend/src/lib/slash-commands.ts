import type { Agent, LibraryPrompt } from '~/api/client';

/**
 * Slash commands in the composer: `/` at the start of the message opens a menu of built-in commands and the prompt
 * library. Choosing one runs it, or fills the box (asking first for a prompt's {{placeholders}}).
 */

export interface SlashCommand {
  /** Unique: `cmd:new`, `prompt:summarize`. */
  id: string;
  /** What is typed after the slash: `new`, `summarize-a-document`. */
  name: string;
  /** Shown beside it. */
  title: string;
  description?: string;
  group: 'command' | 'prompt';
  /** Runs when chosen (the box is cleared first). */
  run?: () => void;
  /** Fills the box with this text, the cursor at its end. */
  text?: string;
  /** A prompt's {{placeholders}}: asked for one by one before the text goes in the box. */
  fields?: string[];
}

/** What follows the `/` while the message is only a command being typed (no space yet); null when it is not. */
export function slashQuery(value: string): string | null {
  const match = /^\/(\S*)$/.exec(value);
  return match ? match[1]! : null;
}

/** Every `{{name}}`: the same reading as the API's (letters, digits, spaces, dashes and underscores). */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_ -]{0,39}?)\s*\}\}/g;

/** The `{{names}}` in a text, once each, in order. */
export function placeholdersOf(text: string): string[] {
  const seen: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER))
    if (!seen.includes(match[1]!)) seen.push(match[1]!);
  return seen;
}

/** The text with each `{{name}}` replaced by its value; a name left empty stays as written, to fill in the box. */
export function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name]?.trim() : undefined;
    return value ? value : whole;
  });
}

function score(command: SlashCommand, query: string): number {
  const name = command.name.toLowerCase();
  const title = command.title.toLowerCase();
  if (name.startsWith(query)) return 0;
  if (title.split(/[\s-]+/).some((word) => word.startsWith(query))) return 1;
  if (name.includes(query)) return 2;
  if (title.includes(query)) return 3;
  if ((command.description ?? '').toLowerCase().includes(query)) return 4;
  return -1;
}

/** The commands that match what was typed, best first (ties keep their order: commands, then prompts). */
export function filterCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...commands];
  return commands
    .map((command, index) => ({ command, index, rank: score(command, q) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.command);
}

/**
 * The commands for an agent and a page: the built-ins that make sense, then the prompt library. One is left out when
 * what it needs isn't there: `/model` without model choice (or a model picker to open), `/new` on the page that is
 * already a new conversation, `/stop` when nothing is running, `/remember` and `/forget` for an agent with memory off,
 * `/search` for one without web search, `/remind` for one that can't set schedules.
 */
export function buildSlashCommands({
  agent,
  working = false,
  modelChoice,
  prompts,
  onNew,
  onModel,
  onStop,
  onManagePrompts,
}: {
  agent: Agent | undefined;
  working?: boolean;
  modelChoice: boolean;
  prompts: readonly LibraryPrompt[];
  onNew?: (() => void) | undefined;
  onModel?: (() => void) | undefined;
  onStop?: (() => void) | undefined;
  onManagePrompts: () => void;
}): SlashCommand[] {
  const commands: SlashCommand[] = [];
  if (onNew)
    commands.push({
      id: 'cmd:new',
      name: 'new',
      title: 'New conversation',
      ...(agent ? { description: `with ${agent.name}` } : {}),
      group: 'command',
      run: onNew,
    });
  if (onModel && modelChoice)
    commands.push({
      id: 'cmd:model',
      name: 'model',
      title: 'Choose the model',
      description: 'for this conversation',
      group: 'command',
      run: onModel,
    });
  if (onStop && working)
    commands.push({
      id: 'cmd:stop',
      name: 'stop',
      title: 'Stop the reply',
      group: 'command',
      run: onStop,
    });
  if (agent && agent.memory?.off !== true) {
    commands.push({
      id: 'cmd:remember',
      name: 'remember',
      title: 'Remember something',
      description: 'saved to memory',
      group: 'command',
      text: 'Remember that ',
    });
    commands.push({
      id: 'cmd:forget',
      name: 'forget',
      title: 'Forget something',
      group: 'command',
      text: 'Forget that ',
    });
  }
  if (agent?.web?.search === true)
    commands.push({
      id: 'cmd:search',
      name: 'search',
      title: 'Search the web',
      group: 'command',
      text: 'Search the web for ',
    });
  if (agent?.schedules?.agentMade === true)
    commands.push({
      id: 'cmd:remind',
      name: 'remind',
      title: 'Set a reminder',
      group: 'command',
      text: 'Remind me ',
    });
  commands.push({
    id: 'cmd:prompts',
    name: 'prompts',
    title: 'Manage prompts',
    description: 'Settings → Prompts',
    group: 'command',
    run: onManagePrompts,
  });
  for (const prompt of prompts)
    commands.push({
      id: `prompt:${prompt.id}`,
      name: prompt.id,
      title: prompt.title,
      ...(prompt.description ? { description: prompt.description } : {}),
      group: 'prompt',
      text: prompt.body,
      fields: prompt.placeholders,
    });
  return commands;
}

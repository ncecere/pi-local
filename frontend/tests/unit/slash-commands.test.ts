import { describe, expect, it } from 'vitest';
import {
  buildSlashCommands,
  fillPlaceholders,
  filterCommands,
  placeholdersOf,
  type SlashCommand,
  slashQuery,
} from '../../src/lib/slash-commands';
import { agent as fixtureAgent } from './memory-fixtures';

const command = (name: string, title: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({
  id: `cmd:${name}`,
  name,
  title,
  group: 'command',
  ...extra,
});

describe('slashQuery', () => {
  it('is what follows a slash while only a command is being typed', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/rem')).toBe('rem');
    expect(slashQuery('/summarize-a-document')).toBe('summarize-a-document');
  });

  it('is null for anything else: text first, a space after the command, a new line', () => {
    expect(slashQuery('')).toBeNull();
    expect(slashQuery('hello /new')).toBeNull();
    expect(slashQuery('/remember that I like tea')).toBeNull();
    expect(slashQuery('/new\nmore')).toBeNull();
    expect(slashQuery(' /new')).toBeNull();
  });
});

describe('filterCommands', () => {
  const all = [
    command('new', 'New conversation'),
    command('model', 'Choose the model', { description: 'for this conversation' }),
    command('remember', 'Remember something'),
    command('search', 'Search the web'),
    command('release-notes', 'Write release notes', { group: 'prompt' }),
  ];

  it('lists everything for a bare slash, in order', () => {
    expect(filterCommands(all, '').map((c) => c.name)).toEqual([
      'new',
      'model',
      'remember',
      'search',
      'release-notes',
    ]);
  });

  it('puts names that start with the text first, then title words, then anywhere', () => {
    expect(filterCommands(all, 're').map((c) => c.name)).toEqual(['remember', 'release-notes']);
    // "notes" starts a word of a title; "mod" starts a name.
    expect(filterCommands(all, 'notes').map((c) => c.name)).toEqual(['release-notes']);
    // "web" is in a title only, "ember" inside a name only.
    expect(filterCommands(all, 'web').map((c) => c.name)).toEqual(['search']);
    expect(filterCommands(all, 'ember').map((c) => c.name)).toEqual(['remember']);
    // "conversation" starts a title word of /new and is in /model's description.
    expect(filterCommands(all, 'conversation').map((c) => c.name)).toEqual(['new', 'model']);
  });

  it('ignores case and surrounding spaces, and finds nothing for nonsense', () => {
    expect(filterCommands(all, ' NEW ').map((c) => c.name)).toEqual(['new']);
    expect(filterCommands(all, 'zzz')).toEqual([]);
  });
});

describe('placeholders', () => {
  it('lists each {{name}} once, in order, with the same reading as the API', () => {
    expect(
      placeholdersOf(
        'Summarize {{document}} for {{ audience }}. Again {{document}} and {{recipient name}} {{}} {{bad!}}',
      ),
    ).toEqual(['document', 'audience', 'recipient name']);
    expect(placeholdersOf('no blanks')).toEqual([]);
  });

  it('fills them, and keeps a blank that was left empty so it can be filled in the box', () => {
    const text = 'Summarize {{document}} for {{ audience }} ({{document}}).';
    expect(fillPlaceholders(text, { document: 'the report', audience: 'the board' })).toBe(
      'Summarize the report for the board (the report).',
    );
    expect(fillPlaceholders(text, { document: 'the report', audience: '   ' })).toBe(
      'Summarize the report for {{ audience }} (the report).',
    );
    expect(fillPlaceholders(text, {})).toBe(text);
    expect(fillPlaceholders('{{constructor}} {{__proto__}} {{toString}}', {})).toBe(
      '{{constructor}} {{__proto__}} {{toString}}',
    );
    expect(fillPlaceholders('{{constructor}}', { constructor: 'typed value' })).toBe('typed value');
  });
});

describe('buildSlashCommands', () => {
  const agent = fixtureAgent({
    web: { search: true, fetch: true },
    schedules: { agentMade: true },
  });
  const prompt = {
    id: 'brainstorm',
    title: 'Brainstorm',
    description: '',
    body: 'Ideas about {{topic}}',
    placeholders: ['topic'],
    updatedAt: '',
  };
  const base = { modelChoice: true, prompts: [], onManagePrompts: () => undefined };
  const namesOf = (commands: SlashCommand[]) => commands.map((c) => c.name);

  it('offers every command to an agent that can use them, then the prompts', () => {
    const commands = buildSlashCommands({
      ...base,
      agent,
      working: true,
      prompts: [prompt],
      onNew: () => undefined,
      onModel: () => undefined,
      onStop: () => undefined,
    });
    expect(namesOf(commands)).toEqual([
      'new',
      'model',
      'stop',
      'remember',
      'forget',
      'search',
      'remind',
      'prompts',
      'brainstorm',
    ]);
    expect(commands[0]?.description).toBe('with Rex');
    expect(commands.find((c) => c.name === 'remember')?.text).toBe('Remember that ');
    expect(commands.find((c) => c.name === 'forget')?.text).toBe('Forget that ');
    const last = commands.at(-1);
    expect(last).toMatchObject({
      id: 'prompt:brainstorm',
      group: 'prompt',
      text: 'Ideas about {{topic}}',
      fields: ['topic'],
    });
    expect(last).not.toHaveProperty('description');
  });

  it('leaves out what the page or the agent cannot do', () => {
    const quiet = fixtureAgent({
      memory: { off: true, share: [] },
      web: { search: false, fetch: true },
      schedules: { agentMade: false },
    });
    // Nothing to stop, no picker to open, no new conversation to start from here.
    expect(namesOf(buildSlashCommands({ ...base, agent: quiet, onStop: () => undefined }))).toEqual(
      ['prompts'],
    );
    // /model needs both the picker and the feature; /stop needs a reply running.
    expect(
      namesOf(
        buildSlashCommands({
          ...base,
          agent: undefined,
          onModel: () => undefined,
          modelChoice: false,
        }),
      ),
    ).toEqual(['prompts']);
    expect(
      namesOf(buildSlashCommands({ ...base, agent: undefined, onModel: () => undefined })),
    ).toEqual(['model', 'prompts']);
    // Without an agent (Auto) nothing depends on one.
    expect(namesOf(buildSlashCommands({ ...base, agent: undefined }))).toEqual(['prompts']);
  });

  it('runs the handlers it was given', () => {
    const calls: string[] = [];
    const commands = buildSlashCommands({
      ...base,
      agent,
      working: true,
      onNew: () => calls.push('new'),
      onModel: () => calls.push('model'),
      onStop: () => calls.push('stop'),
      onManagePrompts: () => calls.push('prompts'),
    });
    for (const name of ['new', 'model', 'stop', 'prompts'])
      commands.find((c) => c.name === name)?.run?.();
    expect(calls).toEqual(['new', 'model', 'stop', 'prompts']);
  });
});

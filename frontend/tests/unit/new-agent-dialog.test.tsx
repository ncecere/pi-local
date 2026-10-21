// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { act } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentTemplate, ApiError } from '../../src/api/client';
import type { AgentCatalog } from '../../src/hooks/use-agents';
import { AGENT_NAMES, randomAgentName } from '../../src/lib/agent-names';
import { shortSchedule, templateChipDetails, templateChips } from '../../src/lib/templates';
import { AgentDialog } from '../../src/routes/settings/agents';
import {
  buttonByText,
  click,
  fakeBackend,
  fieldByLabel,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
  typeInto,
} from './ui-test-utils';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

function template(overrides: Partial<AgentTemplate> & Pick<AgentTemplate, 'id' | 'name'>) {
  return {
    description: '',
    category: 'everyday',
    icon: 'sparkles',
    kind: 'assistant',
    instructions: '',
    builtin: true,
    ...overrides,
  } satisfies AgentTemplate;
}

const ASSISTANT = template({
  id: 'assistant',
  name: 'Assistant',
  description: 'A general helper.',
  instructions: 'You are a helpful, concise assistant.',
  web: { search: true, fetch: true },
  needs: ['web-search'],
});
const RESEARCHER = template({
  id: 'researcher',
  name: 'Researcher',
  description: 'Plans research.',
  icon: 'search',
  kind: 'researcher',
  instructions: 'You research questions thoroughly.',
  web: { search: true, fetch: true },
  needs: ['web-search'],
});
const BRIEFING = template({
  id: 'daily-briefing',
  name: 'Daily briefing',
  description: 'A short morning summary on a schedule.',
  icon: 'sunrise',
  instructions: "You write a short daily briefing.\n1. Today's date and the weather.",
  web: { search: true, fetch: true },
  schedule: {
    name: 'Morning briefing',
    cron: '30 7 * * 1-5',
    message: "Prepare today's briefing.",
    threadMode: 'this',
  },
  needs: ['web-search'],
});
const PLANNER = template({
  id: 'planner',
  name: 'Planner',
  description: 'Turns a goal into a plan.',
  icon: 'list-checks',
  instructions: 'You help people turn a goal into a plan.',
  schedules: { agentMade: true },
  web: { search: true, fetch: true },
});
const CODING = template({
  id: 'coding',
  name: 'Coding',
  description: 'Works in a project folder.',
  category: 'work',
  icon: 'code',
  kind: 'coding',
  workspace: { tools: ['read', 'write', 'edit', 'bash'] },
  approvals: { tools: ['bash'], timeoutSeconds: 0 },
  web: { search: true, fetch: true },
});
const MINE = template({
  id: 'code-reviewer',
  name: 'Code reviewer',
  description: 'Reviews my diffs.',
  category: 'yours',
  icon: 'code',
  instructions: 'Review the diff.',
  builtin: false,
});

const BUILTINS = [ASSISTANT, RESEARCHER, BRIEFING, PLANNER, CODING];

const CATALOG: AgentCatalog = {
  templates: BUILTINS,
  models: [{ id: 'demo/echo', name: 'Echo' }],
  defaultModelId: 'demo/echo',
  allowModelChoice: false,
  limit: 20,
  used: 0,
};

const WEB_OFF = { provider: '', url: '', hasKey: false, providers: [] };

const created = (body: unknown) => ({
  id: 'ag_new',
  name: (body as { name: string }).name,
  revision: 1,
});

let view: Rendered | undefined;
beforeEach(() => vi.mocked(toast).mockClear());
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

async function openDialog(features = {}) {
  view = await renderWithQuery(<AgentDialog agent={null} catalog={CATALOG} onClose={() => {}} />, {
    features,
  });
  await settle();
}

const radio = (name: string) =>
  [...document.querySelectorAll('label')]
    .find((label) => label.textContent?.startsWith(name))
    ?.querySelector('input[type="radio"]');

const text = () => document.body.textContent ?? '';
const chips = () =>
  [...document.querySelectorAll('ul[aria-label^="What "] li')].map((chip) => chip.textContent);

describe('new agent dialog: the templates gallery', () => {
  it('groups the templates by category, skipping empty groups, with no triage', async () => {
    fakeBackend({
      'GET /api/templates': () => ({
        templates: [...BUILTINS, MINE],
        categories: ['everyday', 'work', 'life', 'meta', 'yours'],
      }),
    });
    await openDialog();
    const groups = [...document.querySelectorAll('fieldset fieldset')].map((group) => ({
      label: group.querySelector('legend')?.textContent,
      names: [...group.querySelectorAll('label .font-medium')].map((name) => name.textContent),
    }));
    expect(groups).toEqual([
      {
        label: 'Everyday',
        names: ['Assistant', 'Researcher', 'Daily briefing', 'Planner'],
      },
      { label: 'Work', names: ['Coding'] },
      { label: 'Yours', names: ['Code reviewer'] },
    ]);
    expect(text()).not.toContain('Triage');
    expect(text()).not.toContain('MCP');
    // The first is chosen to begin with.
    expect((radio('Assistant') as HTMLInputElement).checked).toBe(true);
  });

  it('shows what Daily briefing brings, and makes the agent from it with its instructions', async () => {
    const backend = fakeBackend({
      'GET /api/settings/web': () => WEB_OFF,
      'POST /api/agents': created,
    });
    await openDialog();
    await click(radio('Daily briefing'));

    // The time is in the system's hour style: "7:30 AM" or "07:30".
    expect(chips()).toEqual(['Web', expect.stringMatching(/^Schedule: weekdays 0?7:30/)]);
    expect(text()).toContain('Works best with web search: set it up in Settings → Models.');
    // An unnamed agent gets a friendly random name, shown as the placeholder.
    const suggested = fieldByLabel('Name')?.getAttribute('placeholder') ?? '';
    expect(AGENT_NAMES).toContain(suggested);
    expect(text()).toContain(`Leave it empty and it's called ${suggested}.`);
    expect(fieldByLabel('Description')?.getAttribute('placeholder')).toBe(
      'A short morning summary on a schedule.',
    );
    const instructions = fieldByLabel('Instructions') as HTMLTextAreaElement;
    expect(instructions.value).toBe('');
    expect(instructions.placeholder).toBe("Leave empty to use the template's instructions");

    // The template's own text, read-only, behind a disclosure.
    const disclosure = buttonByText("Show the template's instructions");
    expect(disclosure?.getAttribute('aria-expanded')).toBe('false');
    await click(disclosure);
    expect(disclosure?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[aria-label="Daily briefing instructions"]')?.textContent).toBe(
      BRIEFING.instructions,
    );

    // An empty name is the suggested one.
    await click(buttonByText('Make agent'));
    const post = backend.calls.find((call) => call.method === 'POST');
    expect(post).toEqual({
      method: 'POST',
      path: '/api/agents',
      body: { name: suggested, templateId: 'daily-briefing' },
    });
    expect(toast).toHaveBeenCalledWith(`${suggested} is ready.`);
  });

  it('avoids names in use, and shuffles to another name', async () => {
    const taken = AGENT_NAMES.filter((name) => name !== 'Wren' && name !== 'Sage');
    const backend = fakeBackend({
      'GET /api/agents': () => taken.map((name, i) => ({ id: `ag_${i}`, name })),
      'GET /api/settings/web': () => WEB_OFF,
      'POST /api/agents': created,
    });
    await openDialog();
    await settle();
    const first = fieldByLabel('Name')?.getAttribute('placeholder');
    expect(['Wren', 'Sage']).toContain(first);
    await click(document.querySelector('[aria-label="Pick another name"]'));
    const field = fieldByLabel('Name') as HTMLInputElement;
    expect(field.value).toBe(first === 'Wren' ? 'Sage' : 'Wren');
    // A name of its own hides the hint.
    expect(text()).not.toContain('Leave it empty');
    await click(buttonByText('Make agent'));
    expect(backend.calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      name: field.value,
    });
  });

  it('sends a name and instructions of its own when given', async () => {
    const backend = fakeBackend({ 'POST /api/agents': created });
    await openDialog();
    await click(radio('Researcher'));
    await typeInto(fieldByLabel('Name'), 'Scout');
    await typeInto(fieldByLabel('Instructions'), '  Only peer-reviewed sources.  ');
    await click(buttonByText('Make agent'));
    expect(backend.calls.find((call) => call.method === 'POST')?.body).toEqual({
      name: 'Scout',
      templateId: 'researcher',
      instructions: 'Only peer-reviewed sources.',
    });
  });

  it('says nothing about web search once a service is set up', async () => {
    fakeBackend({ 'GET /api/settings/web': () => ({ ...WEB_OFF, provider: 'brave' }) });
    await openDialog();
    expect(chips()).toEqual(['Web']);
    expect(text()).not.toContain('Works best with web search');
  });

  it('explains each chip in a tooltip', () => {
    expect(templateChipDetails(PLANNER).map((chip) => chip.title)).toEqual([
      'Web: can search the web and read pages',
      'Sets its own reminders: can schedule itself to run later',
    ]);
    expect(templateChipDetails(CODING).map((chip) => chip.label)).toEqual(templateChips(CODING));
    expect(templateChipDetails(CODING)[2]?.title).toBe(
      'Runs commands: can run commands on this computer, and asks you before each one',
    );
    expect(templateChipDetails({ ...MINE, web: { search: true, fetch: false } })[0]?.title).toBe(
      'Web: can search the web',
    );
  });

  it("shows the explanation as each chip's title", async () => {
    fakeBackend({ 'GET /api/settings/web': () => ({ ...WEB_OFF, provider: 'brave' }) });
    await openDialog();
    const chip = document.querySelector('[aria-label^="What "] li');
    expect(chip?.textContent).toBe('Web');
    expect(chip?.getAttribute('title')).toBe('Web: can search the web and read pages');
  });

  it('describes each template in chips', () => {
    expect(templateChips(CODING)).toEqual(['Web', 'Files', 'Runs commands (asks first)']);
    expect(templateChips(PLANNER)).toEqual(['Web', 'Sets its own reminders']);
    expect(templateChips({ ...MINE, workspace: { tools: ['bash'] } })).toEqual([
      'Web',
      'Runs commands',
    ]);
    expect(templateChips({ ...MINE, web: { search: false, fetch: false } })).toEqual([]);
    expect(shortSchedule('0 8 * * *', 'en-US')).toBe('daily 8:00 AM');
    expect(shortSchedule('0 9 * * 1', 'en-US')).toBe('every Monday at 9:00 AM');
    expect(shortSchedule('0 8 * * *', 'en-GB')).toMatch(/^daily 0?8:00$/);
  });
});

describe('new agent dialog: importing and deleting templates', () => {
  const LIST = () => ({ templates: [...BUILTINS, MINE], categories: [] });

  async function pickFile(content: string, name = 'shared.pi-template.yaml') {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([content], name, { type: 'application/yaml' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
  }

  it('imports a template file, sending its text, and selects it', async () => {
    const yaml = 'id: translator-de\nname: German translator\nkind: assistant\n';
    const list = [...BUILTINS, MINE];
    const backend = fakeBackend({
      'GET /api/templates': () => ({ templates: list, categories: [] }),
      'POST /api/templates': () => {
        const imported = template({
          id: 'translator-de',
          name: 'German translator',
          category: 'yours',
          builtin: false,
        });
        list.push(imported);
        return imported;
      },
    });
    await openDialog();
    expect(buttonByText('Import template…')).toBeDefined();
    await pickFile(yaml);

    expect(backend.calls.find((call) => call.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/templates',
      body: yaml,
    });
    expect(toast).toHaveBeenCalledWith('German translator imported.');
    expect((radio('German translator') as HTMLInputElement | null)?.checked).toBe(true);
  });

  it("says why a file can't be imported", async () => {
    fakeBackend({
      'GET /api/templates': LIST,
      'POST /api/templates': () => {
        throw new ApiError(
          400,
          'invalid_template',
          "This isn't a Pi Local template: line 1: field color not found",
        );
      },
    });
    await openDialog();
    await pickFile('color: blue\n');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "That file can't be imported: This isn't a Pi Local template: line 1: field color not found",
    );
  });

  it('deletes one of yours from its menu; built-ins have no menu', async () => {
    let list = [...BUILTINS, MINE];
    const backend = fakeBackend({
      'GET /api/templates': () => ({ templates: list, categories: [] }),
      'DELETE /api/templates/code-reviewer': () => {
        list = BUILTINS;
        return { ok: true };
      },
    });
    await openDialog();
    expect(document.querySelectorAll('button[aria-label^="More for"]')).toHaveLength(1);
    await click(radio('Code reviewer'));

    const trigger = document.querySelector(
      'button[aria-label="More for Code reviewer"]',
    ) as HTMLElement;
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Export', 'Delete…']);
    await click(items.find((item) => item.textContent?.trim() === 'Delete…'));
    expect(text()).toContain('Delete Code reviewer?');
    await click(buttonByText('Delete'));
    await settle();

    expect(backend.calls.filter((call) => call.method === 'DELETE')).toEqual([
      { method: 'DELETE', path: '/api/templates/code-reviewer', body: undefined },
    ]);
    expect(toast).toHaveBeenCalledWith('Code reviewer deleted.');
    expect(radio('Code reviewer')).toBeUndefined();
    // The one chosen went: back to the first.
    expect((radio('Assistant') as HTMLInputElement).checked).toBe(true);
  });
});

describe('new agent dialog: coding', () => {
  it('shows the project folder only for coding, and sends it with the coding tools', async () => {
    const backend = fakeBackend({ 'POST /api/agents': created });
    await openDialog();
    expect(fieldByLabel('Project folder')).toBeNull();

    await click(radio('Coding'));
    expect(chips()).toEqual(['Web', 'Files', 'Runs commands (asks first)']);
    const folder = fieldByLabel('Project folder');
    expect(folder).not.toBeNull();
    expect(text()).toContain("It also follows the folder's AGENTS.md or CLAUDE.md.");
    expect(text()).toContain('Added to the coding prompt, like an AGENTS.md of its own.');
    // No dialog without the feature: the path is typed.
    expect(buttonByText('Choose…')).toBeUndefined();

    await typeInto(fieldByLabel('Name'), 'Coder');
    await typeInto(folder, '  /Users/ada/code/site ');
    await click(buttonByText('Make agent'));

    expect(backend.calls.filter((call) => call.method === 'POST')).toEqual([
      {
        method: 'POST',
        path: '/api/agents',
        body: {
          name: 'Coder',
          templateId: 'coding',
          workspace: { tools: ['read', 'write', 'edit', 'bash'], folder: '/Users/ada/code/site' },
        },
      },
    ]);
  });

  it('sends no workspace for coding without a folder', async () => {
    const backend = fakeBackend({ 'POST /api/agents': created });
    await openDialog();
    await click(radio('Coding'));
    await typeInto(fieldByLabel('Name'), 'Coder');
    await click(buttonByText('Make agent'));
    expect(backend.calls.find((call) => call.method === 'POST')?.body).toEqual({
      name: 'Coder',
      templateId: 'coding',
    });
  });

  it("shows the server's message for a folder it refuses", async () => {
    fakeBackend({
      'POST /api/agents': () => {
        throw new ApiError(
          400,
          'invalid_workspace_folder',
          "/nope isn't a folder on this computer.",
        );
      },
    });
    await openDialog();
    await click(radio('Coding'));
    await typeInto(fieldByLabel('Name'), 'Coder');
    await typeInto(fieldByLabel('Project folder'), '/nope');
    await click(buttonByText('Make agent'));
    const folder = fieldByLabel('Project folder');
    expect(folder?.getAttribute('aria-invalid')).toBe('true');
    const hint = document.getElementById(folder?.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe("/nope isn't a folder on this computer.");
  });

  it('fills the field from the folder dialog with Choose…', async () => {
    const backend = fakeBackend({
      'POST /api/choose-folder': () => ({ path: '/Users/ada/code/app' }),
      'POST /api/agents': created,
    });
    await openDialog({ folderDialog: true });
    await click(radio('Coding'));
    await click(buttonByText('Choose…'));

    expect(backend.calls.filter((call) => call.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/choose-folder', body: undefined },
    ]);
    expect((fieldByLabel('Project folder') as HTMLInputElement).value).toBe('/Users/ada/code/app');

    await typeInto(fieldByLabel('Name'), 'Coder');
    await click(buttonByText('Make agent'));
    expect(
      backend.calls.find((call) => call.method === 'POST' && call.path === '/api/agents')?.body,
    ).toMatchObject({
      workspace: { folder: '/Users/ada/code/app' },
    });
  });

  it('leaves the field alone when the folder dialog is cancelled', async () => {
    fakeBackend({ 'POST /api/choose-folder': () => ({ cancelled: true }) });
    await openDialog({ folderDialog: true });
    await click(radio('Coding'));
    await typeInto(fieldByLabel('Project folder'), '/Users/ada/code/old');
    await click(buttonByText('Choose…'));
    expect((fieldByLabel('Project folder') as HTMLInputElement).value).toBe('/Users/ada/code/old');
  });
});

describe('randomAgentName', () => {
  it('picks a free name, ignoring case, and never the current one', () => {
    expect(AGENT_NAMES).toContain(randomAgentName([]));
    const free = AGENT_NAMES.filter((name) => name !== 'Kit');
    expect(randomAgentName(free.map((name) => name.toUpperCase()))).toBe('Kit');
    expect(randomAgentName(free, 'Kit')).toMatch(/ 2$/);
  });
  it('numbers a name when every one is taken', () => {
    expect(randomAgentName(AGENT_NAMES, '', () => 0)).toBe(`${AGENT_NAMES[0]} 2`);
    expect(randomAgentName([...AGENT_NAMES, `${AGENT_NAMES[0]} 2`], '', () => 0)).toBe(
      `${AGENT_NAMES[0]} 3`,
    );
  });
});

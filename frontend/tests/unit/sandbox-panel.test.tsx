// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/api/client';
import { KindSettingsTab } from '../../src/components/agent-manager/kind-settings-tab';
import { ToolsTab } from '../../src/components/agent-manager/tools-tab';
import { useAgents } from '../../src/hooks/use-agents';
import {
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
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

const DIR = '/data/agents/ag_coder/workspace';

function agent(
  workspace: Partial<NonNullable<Agent['workspace']>> = {},
  overrides: Partial<Agent> = {},
): Agent {
  return {
    id: 'ag_coder',
    name: 'Coder',
    description: '',
    instructions: '',
    kind: 'personal',
    agentKind: 'coding',
    status: 'asleep',
    running: false,
    model: null,
    enabled: true,
    lastUsedAt: null,
    revision: 3,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    kindSettings: {},
    canCall: [],
    callable: [],
    dir: '/data/agents/ag_coder',
    piDurableVersion: null,
    workspace: {
      tools: ['read', 'write', 'edit', 'bash'],
      folder: '',
      dir: DIR,
      sandbox: true,
      network: true,
      sandboxAvailable: true,
      ...workspace,
    },
    approvals: { profile: 'balanced', tools: [], timeoutSeconds: 86400 },
    mcp: [],
    web: { search: false, fetch: false },
    ...overrides,
  };
}

let view: Rendered | undefined;
beforeEach(() => {
  vi.mocked(toast).mockClear();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const text = () => document.body.textContent ?? '';
const switchFor = (label: string) => {
  const id = [...document.querySelectorAll('p')].find((p) => p.textContent === label)?.id;
  return document.querySelector(`[role="switch"][aria-labelledby="${id}"]`) as HTMLElement | null;
};
const checked = (label: string) => switchFor(label)?.getAttribute('aria-checked');
const disabled = (label: string) => switchFor(label)?.hasAttribute('disabled');

/** The tab as the agent page draws it: from the agents list, so a save draws it again. */
function Harness({ tab }: { tab: 'tools' | 'kind' }) {
  const { data } = useAgents();
  const current = data?.[0];
  if (!current) return null;
  return tab === 'tools' ? <ToolsTab agent={current} /> : <KindSettingsTab agent={current} />;
}

function backendWith(initial: Agent) {
  let saved = initial;
  return fakeBackend({
    'GET /api/agents': () => [saved],
    'PATCH /api/agents/ag_coder': (body) => {
      const change = (body as { workspace?: Partial<NonNullable<Agent['workspace']>> }).workspace;
      saved = {
        ...saved,
        workspace: { ...saved.workspace!, ...change } as NonNullable<Agent['workspace']>,
        revision: saved.revision + 1,
      };
      return saved;
    },
  });
}

describe('Tools tab: the sandbox', () => {
  it('says what the sandbox allows, with the switches on', async () => {
    backendWith(agent());
    view = await renderWithQuery(<Harness tab="tools" />);
    await settle();
    expect(text()).toContain('Run commands in a sandbox');
    expect(text()).toContain('Read files anywhere, except your keys and credentials');
    expect(text()).toContain('Write only in its workspace, its temp folder and /tmp.');
    expect(text()).toContain('the Balanced profile stops asking before commands');
    expect(checked('Run commands in a sandbox')).toBe('true');
    expect(checked('Let commands use the network')).toBe('true');
    expect(text()).toContain('in the sandbox below');
    expect(text()).not.toContain('Without the sandbox, a command can reach anything you can');
  });

  it('turns the sandbox off, saving the workspace with it, and then offers no network choice', async () => {
    const backend = backendWith(agent());
    view = await renderWithQuery(<Harness tab="tools" />);
    await settle();
    await click(switchFor('Run commands in a sandbox'));
    await settle();
    const patches = backend.calls.filter((call) => call.method === 'PATCH');
    expect(patches.map((call) => call.body)).toEqual([
      { workspace: { tools: ['read', 'write', 'edit', 'bash'], folder: '', sandbox: false } },
    ]);
    expect(toast).toHaveBeenCalledWith('Coder saved.');
    expect(checked('Run commands in a sandbox')).toBe('false');
    expect(text()).toContain('Without the sandbox, a command can reach anything you can.');
    expect(text()).toContain('Not confined: a command can reach anything you can.');
    expect(disabled('Let commands use the network')).toBe(true);
    expect(text()).toContain('Turn the sandbox on to choose.');
  });

  it('turns the network off and on, leaving the sandbox as it is', async () => {
    const backend = backendWith(agent());
    view = await renderWithQuery(<Harness tab="tools" />);
    await settle();
    await click(switchFor('Let commands use the network'));
    await settle();
    expect(checked('Let commands use the network')).toBe('false');
    expect(checked('Run commands in a sandbox')).toBe('true');
    await click(switchFor('Let commands use the network'));
    await settle();
    expect(
      backend.calls.filter((call) => call.method === 'PATCH').map((call) => call.body),
    ).toEqual([
      { workspace: { tools: ['read', 'write', 'edit', 'bash'], folder: '', network: false } },
      { workspace: { tools: ['read', 'write', 'edit', 'bash'], folder: '', network: true } },
    ]);
  });

  it('is only there for an agent that can run commands', async () => {
    backendWith(agent({ tools: ['read', 'write'] }));
    view = await renderWithQuery(<Harness tab="tools" />);
    await settle();
    expect(text()).not.toContain('Run commands in a sandbox');
  });

  it('says so for an agent from before the sandbox (off), and keeps the project folder when switching on', async () => {
    const backend = backendWith(
      agent({ sandbox: false, folder: '/Users/ada/site', dir: '/Users/ada/site' }),
    );
    view = await renderWithQuery(<Harness tab="tools" />);
    await settle();
    expect(checked('Run commands in a sandbox')).toBe('false');
    expect(text()).toContain('Without the sandbox, a command can reach anything you can.');
    await click(switchFor('Run commands in a sandbox'));
    await settle();
    expect(backend.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      workspace: {
        tools: ['read', 'write', 'edit', 'bash'],
        folder: '/Users/ada/site',
        sandbox: true,
      },
    });
  });

  it('can not be turned on where there is no sandbox, and says so', async () => {
    backendWith(agent({ sandbox: false, sandboxAvailable: false }));
    view = await renderWithQuery(<Harness tab="tools" />);
    await settle();
    expect(disabled('Run commands in a sandbox')).toBe(true);
    expect(text()).toContain('The sandbox isn’t available on this computer yet');
  });

  it('can be turned off where there is no sandbox (an agent made elsewhere)', async () => {
    backendWith(agent({ sandbox: true, sandboxAvailable: false }));
    view = await renderWithQuery(<Harness tab="tools" />);
    await settle();
    expect(disabled('Run commands in a sandbox')).toBe(false);
  });

  it('waits for unsaved changes in the form, so a switch does not discard them', async () => {
    backendWith(agent());
    view = await renderWithQuery(<Harness tab="tools" />);
    await settle();
    const edit = [...document.querySelectorAll('input[type="checkbox"]')].find((input) =>
      input.id.endsWith('-tool-edit'),
    );
    await click(edit);
    expect(disabled('Run commands in a sandbox')).toBe(true);
    expect(disabled('Let commands use the network')).toBe(true);
  });
});

describe('a coding agent’s settings', () => {
  it('show the sandbox too', async () => {
    backendWith(agent());
    view = await renderWithQuery(<Harness tab="kind" />);
    await settle();
    expect(text()).toContain('A coding agent has no settings of its own.');
    expect(checked('Run commands in a sandbox')).toBe('true');
    expect(checked('Let commands use the network')).toBe('true');
  });
});

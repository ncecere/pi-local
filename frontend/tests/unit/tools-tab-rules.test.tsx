// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { act } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, ApprovalRule } from '../../src/api/client';
import { ToolsTab } from '../../src/components/agent-manager/tools-tab';
import { useAgents } from '../../src/hooks/use-agents';
import {
  buttonByText,
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
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const BUILTIN: ApprovalRule[] = [
  { id: 'builtin-rm-rf', tool: 'bash', args: { command: 'rm -rf*' }, action: 'ask' },
  { id: 'builtin-sudo', tool: 'bash', args: { command: 'sudo *' }, action: 'ask' },
];
const MINE: ApprovalRule[] = [
  { id: 'r_aaaaaa', tool: 'bash', args: { command: 'git status*' }, action: 'allow' },
  { id: 'r_bbbbbb', tool: 'mcp__github__delete_*', action: 'deny' },
];

function agent(approvals: Partial<NonNullable<Agent['approvals']>> = {}): Agent {
  return {
    id: 'ag_rex',
    name: 'Rex',
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
    dir: '/data/agents/ag_rex',
    piDurableVersion: null,
    workspace: {
      tools: ['read', 'write', 'bash'],
      folder: '',
      dir: '/data/agents/ag_rex/workspace',
    },
    approvals: {
      profile: 'balanced',
      tools: [],
      rules: MINE,
      builtinRules: BUILTIN,
      timeoutSeconds: 3600,
      ...approvals,
    },
    mcp: [],
  };
}

let view: Rendered | undefined;
beforeEach(() => vi.mocked(toast).mockClear());
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const radio = (label: string) =>
  [...document.querySelectorAll('label')]
    .find((candidate) => candidate.textContent?.startsWith(label))
    ?.querySelector('input[type="radio"]') as HTMLInputElement;

const row = (id: string) => document.querySelector(`[data-approval-rule="${id}"]`);

describe('Tools tab: approval rules', () => {
  it("lists the built-in rules (locked) and the agent's own (removable)", async () => {
    fakeBackend();
    view = await renderWithQuery(<ToolsTab agent={agent()} />);
    expect(row('r_aaaaaa')?.textContent).toContain('Allow');
    expect(row('r_aaaaaa')?.textContent).toContain('bash · command: git status*');
    expect(row('r_bbbbbb')?.textContent).toContain('Deny');
    expect(row('r_bbbbbb')?.textContent).toContain('mcp__github__delete_*');
    expect(row('r_aaaaaa')?.querySelector('button')?.textContent).toContain('Remove');
    for (const id of ['builtin-rm-rf', 'builtin-sudo']) {
      expect(row(id)?.textContent).toContain('Built in');
      expect(row(id)?.querySelector('button')).toBeNull();
    }
    expect(row('builtin-sudo')?.textContent).toContain('sudo *');
  });

  it('says how to add one when there are none', async () => {
    fakeBackend();
    view = await renderWithQuery(<ToolsTab agent={agent({ rules: [] })} />);
    expect(document.body.textContent).toContain('No rules yet.');
    expect(document.body.textContent).toContain('Approve and always allow this');
  });

  it('removes a rule at once', async () => {
    const backend = fakeBackend({
      'DELETE /api/agents/ag_rex/approval-rules/r_aaaaaa': () => ({ rules: [MINE[1]] }),
    });
    view = await renderWithQuery(<ToolsTab agent={agent()} />);
    const remove = row('r_aaaaaa')?.querySelector('button') as HTMLButtonElement;
    expect(remove.getAttribute('aria-label')).toBe(
      'Remove the rule: Allow bash · command: git status*',
    );
    await click(remove);
    expect(backend.calls.map((call) => `${call.method} ${call.path}`)).toContain(
      'DELETE /api/agents/ag_rex/approval-rules/r_aaaaaa',
    );
    expect(vi.mocked(toast)).toHaveBeenCalledWith('Rule removed.');
  });
});

describe('Tools tab: profiles', () => {
  it("shows the agent's profile; the tools list belongs to Custom", async () => {
    fakeBackend();
    view = await renderWithQuery(<ToolsTab agent={agent()} />);
    expect(radio('Balanced').checked).toBe(true);
    expect(document.body.textContent).toContain('(recommended)');
    expect(document.body.textContent).not.toContain('Advanced: every tool that asks first');
    expect(radio('Ask first')).toBeUndefined();
    expect(document.body.textContent).not.toContain('It can run commands without asking you');
  });

  it('an agent without a profile is Custom, and shows its list as before', async () => {
    fakeBackend();
    view = await renderWithQuery(
      <ToolsTab agent={agent({ profile: undefined, tools: ['bash'] })} />,
    );
    expect(radio('Custom').checked).toBe(true);
    expect(radio('Ask for commands').checked).toBe(true);
    expect(buttonByText('Advanced: every tool that asks first')).toBeDefined();
  });

  it('warns for Trusting, and saves the profile without the rules', async () => {
    let saved = agent();
    const backend = fakeBackend({
      'GET /api/agents': () => [saved],
      'PATCH /api/agents/ag_rex': (body) => {
        saved = {
          ...saved,
          approvals: { ...saved.approvals!, ...(body as { approvals: object }).approvals },
        };
        return { ...saved, revision: 4 };
      },
    });
    function Harness() {
      const { data } = useAgents();
      return data?.[0] ? <ToolsTab agent={data[0]} /> : null;
    }
    view = await renderWithQuery(<Harness />);
    await settle();
    await act(async () => {
      radio('Trusting').click();
    });
    expect(document.body.textContent).toContain('It can run commands without asking you');
    await click(buttonByText('Save'));
    const patch = backend.calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toEqual({
      approvals: { profile: 'trusting', tools: [], timeoutSeconds: 3600 },
      workspace: { tools: ['read', 'write', 'bash'], folder: '' },
    });
  });
});

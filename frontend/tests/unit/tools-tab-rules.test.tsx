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
    expect(row('r_aaaaaa')?.querySelector('button[aria-label^="Remove"]')?.textContent).toContain(
      'Remove',
    );
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
    expect(buttonByText('Add rule')).toBeDefined();
  });

  it('adds a rule, edits it in place, then removes and restores it at the same priority', async () => {
    let saved = agent({ profile: 'custom', tools: ['bash', 'write', 'edit'] });
    const backend = fakeBackend({
      'GET /api/agents': () => [saved],
      'POST /api/agents/ag_rex/approval-rules': (body) => {
        const rule = { ...(body as ApprovalRule), id: 'r_new' };
        saved = {
          ...saved,
          revision: saved.revision + 1,
          approvals: { ...saved.approvals!, rules: [...saved.approvals!.rules!, rule] },
        };
        return { rule, rules: saved.approvals!.rules };
      },
      'PATCH /api/agents/ag_rex': (body) => {
        saved = {
          ...saved,
          revision: saved.revision + 1,
          approvals: { ...saved.approvals!, ...(body as { approvals: object }).approvals },
        };
        return saved;
      },
      'DELETE /api/agents/ag_rex/approval-rules/r_new': () => {
        saved = {
          ...saved,
          revision: saved.revision + 1,
          approvals: {
            ...saved.approvals!,
            rules: saved.approvals!.rules!.filter((rule) => rule.id !== 'r_new'),
          },
        };
        return { rules: saved.approvals!.rules };
      },
    });
    function Harness() {
      const { data } = useAgents();
      return data?.[0] ? <ToolsTab agent={data[0]} /> : null;
    }
    view = await renderWithQuery(<Harness />);
    await settle();
    await click(buttonByText('Add rule'));
    await typeInto(fieldByLabel('Argument patterns'), 'command=ls *');
    await click(buttonByText('Save rule'));
    expect(backend.calls.find((call) => call.method === 'POST')?.body).toEqual({
      tool: 'bash',
      action: 'allow',
      args: { command: 'ls *' },
    });
    await click(row('r_new')?.querySelector('button[aria-label^="Edit"]'));
    await typeInto(fieldByLabel('Argument patterns'), 'command=git status *');
    await click(buttonByText('Save rule'));
    expect(saved.approvals!.rules!.at(-1)).toEqual({
      id: 'r_new',
      tool: 'bash',
      action: 'allow',
      args: { command: 'git status *' },
    });
    const before = saved.approvals!.rules;
    await click(row('r_new')?.querySelector('button[aria-label^="Remove"]'));
    expect(row('r_new')).toBeNull();
    const options = vi
      .mocked(toast)
      .mock.calls.find((call) => call[0] === 'Rule removed.')?.[1] as unknown as {
      action: { onClick: () => void };
    };
    await act(async () => options.action.onClick());
    await settle();
    expect(saved.approvals!.rules).toEqual(before);
    expect(
      backend.calls
        .filter((call) => call.method === 'PATCH')
        .map(
          (call) =>
            (call.body as { approvals: { tools: string[]; timeoutSeconds: number } }).approvals,
        ),
    ).toEqual([
      expect.objectContaining({ tools: ['bash', 'write', 'edit'], timeoutSeconds: 3600 }),
      expect.objectContaining({ tools: ['bash', 'write', 'edit'], timeoutSeconds: 3600 }),
    ]);
    expect(
      backend.calls
        .filter((call) => call.method === 'PATCH')
        .every((call) => Object.keys(call.body as object).join() === 'approvals'),
    ).toBe(true);
  });

  it('removes a rule at once', async () => {
    const backend = fakeBackend({
      'DELETE /api/agents/ag_rex/approval-rules/r_aaaaaa': () => ({ rules: [MINE[1]] }),
    });
    view = await renderWithQuery(<ToolsTab agent={agent()} />);
    const remove = row('r_aaaaaa')?.querySelector(
      'button[aria-label^="Remove"]',
    ) as HTMLButtonElement;
    expect(remove.getAttribute('aria-label')).toBe(
      'Remove the rule: Allow bash · command: git status*',
    );
    await click(remove);
    expect(backend.calls.map((call) => `${call.method} ${call.path}`)).toContain(
      'DELETE /api/agents/ag_rex/approval-rules/r_aaaaaa',
    );
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      'Rule removed.',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
    );
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

  it('choosing Custom starts with Ask first and saves only the live approval policy', async () => {
    const awake = { ...agent(), running: true };
    const backend = fakeBackend({
      'PATCH /api/agents/ag_rex': (body) => ({
        ...awake,
        approvals: { ...awake.approvals!, ...(body as { approvals: object }).approvals },
      }),
    });
    view = await renderWithQuery(<ToolsTab agent={awake} />);
    await click(radio('Custom'));
    expect(radio('Ask first').checked).toBe(true);
    expect(radio("Don't ask").checked).toBe(false);
    await click(buttonByText('Save'));
    expect(backend.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      approvals: { profile: 'custom', tools: ['bash', 'write', 'edit'], timeoutSeconds: 3600 },
    });
    expect(vi.mocked(toast)).toHaveBeenCalledWith('Rex saved.');
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
    });
  });
});

// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { act } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/api/client';
import { agentSavedMessage } from '../../src/components/agent-manager/panel';
import { preselectsAskFirst, ToolsTab } from '../../src/components/agent-manager/tools-tab';
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

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'ag_rex',
    name: 'Rex',
    description: '',
    instructions: '',
    kind: 'personal',
    agentKind: 'researcher',
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
    workspace: { tools: ['read'], folder: '', dir: '/data/agents/ag_rex/workspace' },
    approvals: { tools: [], timeoutSeconds: 3600 },
    mcp: [],
    ...overrides,
  };
}

/** The tab as the agent page draws it: from the agents list, so a save draws it again. */
function Harness() {
  const { data } = useAgents();
  const current = data?.[0];
  return current ? <ToolsTab agent={current} /> : null;
}

let view: Rendered | undefined;
beforeEach(() => vi.mocked(toast).mockClear());
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const checkbox = (label: string) =>
  [...document.querySelectorAll('label')]
    .find((candidate) => candidate.textContent?.startsWith(label))
    ?.closest('div')
    ?.parentElement?.querySelector('input[type="checkbox"]') as HTMLInputElement;
const radio = (label: string) =>
  [...document.querySelectorAll('label')]
    .find((candidate) => candidate.textContent?.startsWith(label))
    ?.querySelector('input[type="radio"]') as HTMLInputElement;

async function toggle(input: HTMLInputElement) {
  await act(async () => {
    input.click();
  });
}

describe('Tools tab: turning tools on', () => {
  it('chooses "Ask first" for an agent where nothing asks first', async () => {
    fakeBackend();
    view = await renderWithQuery(<ToolsTab agent={agent()} />);
    expect(radio("Don't ask").checked).toBe(true);
    await toggle(checkbox('Run commands'));
    expect(radio('Ask first').checked).toBe(true);
  });

  it('leaves an agent whose approvals were set as it is', async () => {
    fakeBackend();
    view = await renderWithQuery(
      <ToolsTab
        agent={agent({ approvals: { tools: ['mcp__github__*'], timeoutSeconds: 3600 } })}
      />,
    );
    await toggle(checkbox('Run commands'));
    expect(radio("Don't ask").checked).toBe(true);
  });

  it('respects "Don\'t ask" when the person chose it', async () => {
    fakeBackend();
    view = await renderWithQuery(<ToolsTab agent={agent()} />);
    await toggle(radio('Ask for commands'));
    await toggle(radio("Don't ask"));
    await toggle(checkbox('Run commands'));
    expect(radio("Don't ask").checked).toBe(true);
  });

  it('offers no approvals choice while the agent has no file or command tools', async () => {
    fakeBackend();
    view = await renderWithQuery(
      <ToolsTab
        agent={agent({
          workspace: { tools: [], folder: '', dir: '/data/agents/ag_rex/workspace' },
        })}
      />,
    );
    // Nothing is selected, and nothing can be: there is nothing to ask about yet.
    for (const label of ['Careful', 'Balanced', 'Trusting']) {
      expect(radio(label).checked).toBe(false);
      expect(radio(label).disabled).toBe(true);
    }
    expect(document.body.textContent).toContain('No file or command tools');

    // Turning one on brings the choice back.
    await toggle(checkbox('Run commands'));
    expect(radio('Balanced').disabled).toBe(false);
    expect(document.body.textContent).not.toContain('No file or command tools');
  });

  it('decides by the rule', () => {
    const base = { on: true, preset: 'none' as const, presetChosen: false, savedApprovals: [] };
    expect(preselectsAskFirst(base)).toBe(true);
    expect(preselectsAskFirst({ ...base, on: false })).toBe(false);
    expect(preselectsAskFirst({ ...base, preset: 'commands' })).toBe(false);
    expect(preselectsAskFirst({ ...base, presetChosen: true })).toBe(false);
    expect(preselectsAskFirst({ ...base, savedApprovals: ['bash'] })).toBe(false);
  });

  it('shows the example list as a placeholder, marked as one', async () => {
    fakeBackend();
    view = await renderWithQuery(<ToolsTab agent={agent()} />);
    await click(buttonByText('Advanced: every tool that asks first'));
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.placeholder.startsWith('e.g. bash')).toBe(true);
    expect(textarea.className).toContain('placeholder:text-[var(--text-muted)]');
  });
});

describe('Agent tabs: saving says so', () => {
  it('says "{name} saved." though the form is drawn again, and keeps Advanced open', async () => {
    let revision = 3;
    let saved = agent();
    fakeBackend({
      'GET /api/agents': () => [saved],
      'PATCH /api/agents/ag_rex': (body) => {
        revision += 1;
        saved = { ...saved, ...(body as Partial<Agent>), revision };
        return saved;
      },
    });
    view = await renderWithQuery(<Harness />);
    await settle();
    await click(buttonByText('Advanced: every tool that asks first'));
    await toggle(checkbox('Run commands'));
    await click(buttonByText('Save'));
    await settle();

    expect(saved.revision).toBe(4);
    expect(toast).toHaveBeenCalledWith('Rex saved.');
    // Drawn again from the saved agent, with Advanced still open.
    expect(
      buttonByText('Advanced: every tool that asks first')?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(document.querySelector('textarea')).not.toBeNull();
  });

  it('adds that an awake agent restarts', () => {
    expect(agentSavedMessage({ running: true }, { name: 'Rex' })).toBe(
      'Rex saved. It restarts with the change.',
    );
    expect(agentSavedMessage({ running: false }, { name: 'Rex' })).toBe('Rex saved.');
  });
});

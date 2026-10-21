// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/api/client';
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

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'ag_tok',
    name: 'Tokens',
    description: '',
    instructions: '',
    kind: 'personal',
    agentKind: 'assistant',
    status: 'asleep',
    running: false,
    model: null,
    enabled: true,
    lastUsedAt: null,
    revision: 1,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    kindSettings: {},
    canCall: [],
    callable: [],
    dir: '/data/agents/ag_tok',
    piDurableVersion: null,
    workspace: { tools: [], folder: '', dir: '/data/agents/ag_tok/workspace' },
    approvals: { tools: [], timeoutSeconds: 3600 },
    mcp: [],
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
const secretsSwitch = () => {
  const id = [...document.querySelectorAll('p')].find(
    (p) => p.textContent === 'Hide secrets from the model',
  )?.id;
  return document.querySelector(`[role="switch"][aria-labelledby="${id}"]`) as HTMLElement | null;
};

function ToolsHarness() {
  const { data } = useAgents();
  const current = data?.[0];
  return current ? <ToolsTab agent={current} /> : null;
}

describe('Tools tab: secrets', () => {
  it('is on for an agent that says nothing (an older backend), and explains itself', async () => {
    fakeBackend({ 'GET /api/agents': () => [agent()] });
    view = await renderWithQuery(<ToolsHarness />);
    await settle();
    expect(secretsSwitch()?.getAttribute('aria-checked')).toBe('true');
    expect(text()).toContain('replaced with [redacted secret] before the model sees them');
    expect(text()).toContain('Logs are always cleaned.');
    expect(text()).not.toContain('Turn this off only for an agent that has to handle tokens.');
  });

  it('saves the switch as security, warns when off, and turns back on', async () => {
    let saved = agent({ security: { scrubSecrets: true } });
    const backend = fakeBackend({
      'GET /api/agents': () => [saved],
      'PATCH /api/agents/ag_tok': (body) => {
        saved = { ...saved, ...(body as Partial<Agent>), revision: saved.revision + 1 };
        return saved;
      },
    });
    view = await renderWithQuery(<ToolsHarness />);
    await settle();
    expect(secretsSwitch()?.getAttribute('aria-checked')).toBe('true');

    await click(secretsSwitch());
    await settle();
    const patches = () => backend.calls.filter((call) => call.method === 'PATCH');
    expect(patches().map((call) => call.body)).toEqual([{ security: { scrubSecrets: false } }]);
    expect(toast).toHaveBeenCalledWith('Tokens saved.');
    expect(secretsSwitch()?.getAttribute('aria-checked')).toBe('false');
    expect(text()).toContain('Turn this off only for an agent that has to handle tokens.');

    await click(secretsSwitch());
    await settle();
    expect(patches().map((call) => call.body)[1]).toEqual({ security: { scrubSecrets: true } });
    expect(secretsSwitch()?.getAttribute('aria-checked')).toBe('true');
  });

  it('shows the saved choice of an agent that turned it off', async () => {
    fakeBackend({ 'GET /api/agents': () => [agent({ security: { scrubSecrets: false } })] });
    view = await renderWithQuery(<ToolsHarness />);
    await settle();
    expect(secretsSwitch()?.getAttribute('aria-checked')).toBe('false');
  });
});

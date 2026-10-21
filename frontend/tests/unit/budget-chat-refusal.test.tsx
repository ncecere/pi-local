// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { type AgentThread, ApiError, type BudgetStatus } from '../../src/api/client';
import { writeHandover } from '../../src/hooks/use-agent-thread';
import { noteNewThread, threadsKey } from '../../src/hooks/use-agents';
import { BUDGETS_KEY } from '../../src/hooks/use-budgets';
import { ChatHomePage } from '../../src/routes/chat/home';
import { ChatThreadPage } from '../../src/routes/chat/thread';
import { agent } from './memory-fixtures';
import {
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
const app: BudgetStatus = {
  scope: 'app',
  name: 'Pi Local',
  month: '2026-10',
  monthName: 'October',
  monthlyUsd: 10.5,
  onExceed: 'stop',
  spentUsd: 11,
  unpricedRequests: 0,
  percent: 105,
  state: 'over',
  blocked: true,
};
const own: BudgetStatus = {
  ...app,
  scope: 'agent',
  agentId: 'ag_rex',
  name: 'Rex',
  onExceed: 'warn',
  blocked: false,
};
const base = {
  'GET /api/agents': () => [agent()],
  'GET /api/teams': () => [],
  'GET /api/agents/ag_rex/threads': () => [],
  'GET /api/elicitations': () => [],
  'GET /api/approvals?status=pending': () => [],
  'GET /api/budgets': () => ({ app, agents: [own] }),
};
let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
  sessionStorage.clear();
  localStorage.clear();
});

it('shows app stop and agent warn budgets with links on the landing page', async () => {
  fakeBackend(base);
  view = await renderWithQuery(<ChatHomePage agentId="ag_rex" />);
  await settle();
  const banners = document.querySelectorAll('[data-budget-banner]');
  expect(banners.length).toBe(2);
  expect(banners[0]?.textContent).toContain('$10.50');
  expect(banners[1]?.textContent).toContain('It keeps working');
  expect(banners[0]?.querySelector('a')?.textContent).toContain('Raise app budget');
  expect(banners[1]?.querySelector('a')?.textContent).toContain('Raise agent budget');
});

it('rolls back a refused first thread, keeps the draft, and stops Working without opening a stream', async () => {
  let refuse: (error: unknown) => void = () => undefined;
  const response = new Promise((_resolve, reject) => {
    refuse = reject;
  });
  const stream = vi.fn(async () => undefined);
  const backend = fakeBackend(
    { ...base, 'POST /api/agents/ag_rex/threads/new/messages': () => response },
    stream,
  );
  writeHandover({
    agentId: 'ag_rex',
    threadId: 'new',
    text: 'Please keep my draft',
    requestId: 'req_one',
    focus: false,
  });
  view = await renderWithQuery(<ChatThreadPage agentId="ag_rex" threadId="new" />);
  await act(async () => {
    noteNewThread(view!.queryClient, 'ag_rex', 'new', 'Please keep my draft');
  });
  expect(view.queryClient.getQueryData<AgentThread[]>(threadsKey('ag_rex'))?.length).toBe(1);
  await act(async () => {
    refuse(new ApiError(402, 'over_budget', 'Budget reached', { budget: app }));
  });
  await settle();
  expect(view.queryClient.getQueryData<AgentThread[]>(threadsKey('ag_rex'))).toEqual([]);
  expect(
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message input"]')?.value,
  ).toBe('Please keep my draft');
  expect(
    document.querySelector('[aria-label="Working"], [aria-label="Waiting for the agent…"]'),
  ).toBeNull();
  expect(document.querySelectorAll('[data-budget-banner]').length).toBe(2);
  // The stop banner is the only error, not an additional generic send-error banner.
  expect(document.querySelectorAll('[role="alert"]').length).toBe(1);
  expect(stream).not.toHaveBeenCalled();
  expect(backend.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  expect(sessionStorage.getItem('pai.handover')).toBeNull();
  await act(async () => {
    view!.queryClient.setQueryData(BUDGETS_KEY, {
      app: { ...app, state: 'ok', blocked: false },
      agents: [],
    });
  });
  await settle();
  expect(document.querySelector('[data-budget-banner]')).toBeNull();
});

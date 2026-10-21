// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentThread } from '../../src/api/client';
import { CONFIRM_DELETE_MS, SidebarInbox } from '../../src/components/layout/sidebar-inbox';
import {
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="/" className={className}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const NOW = Date.now();

const agent: Agent = {
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
  revision: 1,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  kindSettings: {},
  canCall: [],
  callable: [],
  dir: '/data/agents/ag_rex',
  piDurableVersion: null,
  mcp: [],
};

const thread: AgentThread = {
  threadId: 't1',
  title: 'Trip to Lisbon',
  createdAt: NOW - 3_600_000,
  updatedAt: NOW - 3_600_000,
  busy: false,
  visibility: 'private',
  participants: [],
};

let view: Rendered | undefined;
beforeEach(() => vi.mocked(toast).mockClear());
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
  localStorage.clear();
});

const byLabel = (label: string) =>
  document.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;

describe('Sidebar: deleting a conversation', () => {
  it('moves focus to the confirm button, waits 10 s for it, and says when it is done', async () => {
    const backend = fakeBackend({
      'GET /api/agents': () => [agent],
      'GET /api/agents/ag_rex/threads': () => [thread],
      'GET /api/approvals?status=pending': () => [],
      'GET /api/elicitations': () => [],
      'DELETE /api/agents/ag_rex/threads/t1': () => ({ ok: true }),
    });
    view = await renderWithQuery(<SidebarInbox filter="" />);
    await settle();

    // Right-click opens the row's menu (as "…" does).
    const row = document.querySelector('[data-focus-row]') as HTMLElement;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await settle();
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (candidate) => candidate.textContent?.trim() === 'Delete…',
    );
    await click(item);
    await settle();

    const confirm = byLabel('Confirm delete conversation: Trip to Lisbon');
    expect(confirm).not.toBeNull();
    expect(document.activeElement).toBe(confirm);
    expect(CONFIRM_DELETE_MS).toBe(10_000);

    await click(confirm);
    await settle();
    expect(backend.calls.some((call) => call.method === 'DELETE')).toBe(true);
    expect(toast).toHaveBeenCalledWith('Conversation deleted.');
  });
});

// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentThread, SearchResult } from '../../src/api/client';
import { CommandPalette } from '../../src/components/command-palette/command-palette';
import { matchConversations } from '../../src/lib/conversation-search';
import type { InboxEntry } from '../../src/lib/inbox';
import { ThemeProvider } from '../../src/providers/theme-provider';
import {
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
  typeInto,
} from './ui-test-utils';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useParams: () => ({}),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const NOW = Date.now();

function entry(threadId: string, title: string, updatedAt: number): InboxEntry {
  return {
    key: `ag_rex/${threadId}`,
    agentId: 'ag_rex',
    threadId,
    title,
    updatedAt,
    meta: {},
    bucket: 'inbox',
    status: null,
  };
}

const hit = (threadId: string, snippet: string): SearchResult => ({
  agentId: 'ag_rex',
  threadId,
  snippet,
  indexedAt: '2026-10-20T00:00:00Z',
});

describe('matchConversations', () => {
  const entries = [
    entry('t1', 'Trip to Lisbon', NOW - 3_600_000),
    entry('t2', 'Lisbon hotels', NOW - 60_000),
    entry('t3', 'Tax return', NOW - 7_200_000),
  ];

  it('finds titles that hold the query, most recent first, then message matches', () => {
    const found = matchConversations(
      entries,
      [hit('t1', 'the \u0001lisbon\u0002 flight'), hit('t3', 'receipts from \u0001lisbon\u0002')],
      'LISBON',
    );
    expect(found.map(({ entry, hit }) => [entry.threadId, Boolean(hit)])).toEqual([
      ['t2', false],
      ['t1', false],
      ['t3', true],
    ]);
  });

  it('leaves out hits whose conversation is not listed, and finds nothing for nothing', () => {
    expect(matchConversations(entries, [hit('gone', 'x')], 'zzz')).toEqual([]);
    expect(matchConversations(entries, [], '  ')).toEqual([]);
  });

  it('keeps to the limit of each kind', () => {
    const many = Array.from({ length: 10 }, (_, i) => entry(`m${i}`, `Notes ${i}`, NOW - i));
    expect(matchConversations(many, [], 'notes', 3)).toHaveLength(3);
  });
});

// ── The palette ──────────────────────────────────────────────────────────────────────────

function agent(): Agent {
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
}

function thread(threadId: string, title: string): AgentThread {
  return {
    threadId,
    title,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 3_600_000,
    busy: false,
    visibility: 'private',
    participants: [],
  };
}

let view: Rendered | undefined;
beforeEach(() => {
  navigate.mockReset();
  navigate.mockResolvedValue(undefined);
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
  localStorage.clear();
});

const input = () => document.querySelector('input[role="combobox"]') as HTMLInputElement;
const options = () => [...document.querySelectorAll('[role="option"]')];

async function openPalette() {
  fakeBackend({
    'GET /api/agents': () => [agent()],
    'GET /api/agents/ag_rex/threads': () => [
      thread('t1', 'Trip to Lisbon'),
      thread('t2', 'Groceries'),
    ],
    'GET /api/approvals?status=pending': () => [],
    'GET /api/elicitations': () => [],
    'GET /api/search?q=receipt': () => ({
      results: [hit('t2', 'keep the \u0001receipt\u0002 for the milk')],
    }),
  });
  view = await renderWithQuery(
    <ThemeProvider>
      <CommandPalette open onOpenChange={() => {}} sidebarOpen onSidebarOpenChange={() => {}} />
    </ThemeProvider>,
    { features: { messageSearch: true } },
  );
  await settle();
}

describe('Command palette: conversations', () => {
  it('lists a conversation by part of its title and opens it on Enter', async () => {
    await openPalette();
    await typeInto(input(), 'lisb');
    const found = options().find((option) => option.textContent?.includes('Trip to Lisbon'));
    expect(found).toBeDefined();
    expect(found?.closest('fieldset')?.querySelector('legend')?.textContent).toBe('Conversations');

    // The first option: the conversation (no agent or command matches "lisb").
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(navigate).toHaveBeenCalledWith({
      to: '/agents/$agentId/threads/$threadId',
      params: { agentId: 'ag_rex', threadId: 't1' },
    });
  });

  it('lists a conversation by a word in its messages, opened at that message', async () => {
    await openPalette();
    await typeInto(input(), 'receipt');
    // The message search waits for typing to pause.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await settle();
    const found = options().find((option) => option.textContent?.includes('Groceries'));
    expect(found?.textContent).toContain('keep the receipt for the milk');
    await act(async () => {
      (found as HTMLElement).click();
    });
    await settle();
    expect(navigate).toHaveBeenCalledWith({
      to: '/agents/$agentId/threads/$threadId',
      params: { agentId: 'ag_rex', threadId: 't2' },
      search: { find: 'keep the \u0001receipt\u0002 for the milk' },
    });
  });
});

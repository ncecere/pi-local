// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, MemoryNote } from '../../src/api/client';
import { MemoryTab } from '../../src/components/agent-manager/memory-tab';
import { useAgents } from '../../src/hooks/use-agents';
import { agent, you } from './memory-fixtures';
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

let view: Rendered | undefined;
beforeEach(() => {
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const note = (id: string, text: string, updatedAt: number): MemoryNote => ({
  id,
  text,
  createdAt: updatedAt,
  updatedAt,
});

const noteTexts = () =>
  [...document.querySelectorAll('[data-note-id] p:first-child')].map((p) => p.textContent);
const byLabel = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[aria-label]')].find(
    (element) => element.getAttribute('aria-label') === label,
  ) ?? null;

/** The tab as the agent page draws it: from the agents list. */
function MemoryHarness() {
  const { data } = useAgents();
  const current = data?.[0];
  return current ? <MemoryTab agent={current} /> : null;
}

function backendWith(notes: MemoryNote[]) {
  const state = { notes, agent: agent() };
  const backend = fakeBackend({
    'GET /api/agents': () => [state.agent],
    'GET /api/you': () => you(),
    'GET /api/agents/ag_rex/memory': () => state.notes,
    'POST /api/agents/ag_rex/memory': (body) => {
      const added = note('an_new', (body as { text: string }).text, 3_000);
      state.notes = [...state.notes, added];
      return added;
    },
    'DELETE /api/agents/ag_rex/memory/an_old': () => {
      state.notes = state.notes.filter((n) => n.id !== 'an_old');
      return { ok: true };
    },
    'DELETE /api/agents/ag_rex/memory': () => {
      state.notes = [];
      return { ok: true };
    },
    'PATCH /api/agents/ag_rex': (body) => {
      state.agent = { ...state.agent, ...(body as Partial<Agent>), revision: 4 };
      return state.agent;
    },
  });
  return { backend, state };
}

describe("An agent's Memory tab", () => {
  it('lists its notes newest first, and adds one', async () => {
    const { backend } = backendWith([
      note('an_old', 'The report is due Fridays', 1_000),
      note('an_mid', 'Use the shared drive', 2_000),
    ]);
    view = await renderWithQuery(<MemoryHarness />);
    await settle();
    expect(noteTexts()).toEqual(['Use the shared drive', 'The report is due Fridays']);

    await typeInto(fieldByLabel('New note'), '  Ada likes tables  ');
    await click(buttonByText('Add note'));
    expect(backend.calls.filter((call) => call.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/agents/ag_rex/memory', body: { text: 'Ada likes tables' } },
    ]);
    expect(toast).toHaveBeenCalledWith('Note added.');
    expect(noteTexts()).toEqual([
      'Ada likes tables',
      'Use the shared drive',
      'The report is due Fridays',
    ]);
    expect((fieldByLabel('New note') as HTMLInputElement).value).toBe('');
  });

  it('deletes a note', async () => {
    const { backend } = backendWith([note('an_old', 'The report is due Fridays', 1_000)]);
    view = await renderWithQuery(<MemoryHarness />);
    await settle();
    await click(byLabel('Delete "The report is due Fridays"'));
    expect(backend.calls.filter((call) => call.method === 'DELETE').map((c) => c.path)).toEqual([
      '/api/agents/ag_rex/memory/an_old',
    ]);
    expect(toast).toHaveBeenCalledWith('Note deleted.');
    expect(document.body.textContent).toContain('No notes yet.');
  });

  it('resets its memory after asking', async () => {
    const { backend } = backendWith([
      note('an_old', 'The report is due Fridays', 1_000),
      note('an_mid', 'Use the shared drive', 2_000),
    ]);
    view = await renderWithQuery(<MemoryHarness />);
    await settle();
    await click(buttonByText('Reset memory'));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Reset Rex's memory?");
    expect(dialog.textContent).toContain('It forgets all 2 of its notes.');
    expect(backend.calls.some((call) => call.method === 'DELETE')).toBe(false);

    await click(
      [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Reset memory'),
    );
    expect(backend.calls.filter((call) => call.method === 'DELETE').map((c) => c.path)).toEqual([
      '/api/agents/ag_rex/memory',
    ]);
    expect(toast).toHaveBeenCalledWith("Rex's notes are reset.");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(noteTexts()).toEqual([]);
  });

  it('switches memory off and shares categories, like Settings → You', async () => {
    const { backend } = backendWith([]);
    view = await renderWithQuery(<MemoryHarness />);
    await settle();
    const work = [...document.querySelectorAll('label')]
      .find((label) => label.textContent === 'Work')
      ?.querySelector('input');
    await click(work);
    const id = [...document.querySelectorAll('p')].find((p) => p.textContent === 'Memory on')?.id;
    await click(document.querySelector(`[role="switch"][aria-labelledby="${id}"]`));
    expect(
      backend.calls.filter((call) => call.method === 'PATCH').map((call) => call.body),
    ).toEqual([
      { memory: { off: false, share: ['work'] } },
      { memory: { off: true, share: ['work'] } },
    ]);
    expect(toast).toHaveBeenCalledWith('Rex saved.');
  });
});

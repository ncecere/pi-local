// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Fact } from '../../src/api/client';
import { SettingsYouPage } from '../../src/routes/settings/you';
import { agent, basics, fact, you } from './memory-fixtures';
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
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
    className?: string;
  }) => (
    <a
      href={Object.entries(params ?? {}).reduce(
        (path, [key, value]) => path.replace(`$${key}`, value),
        to,
      )}
      className={className}
    >
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

const text = () => document.body.textContent ?? '';
const byLabel = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[aria-label]')].find(
    (element) => element.getAttribute('aria-label') === label,
  ) ?? null;
const sectionTitled = (title: string) =>
  [...document.querySelectorAll('section')].find(
    (section) => section.querySelector('h2')?.textContent === title,
  );

/** The page against a backend whose facts and agents can change. */
function backendWith({ facts = [] as Fact[], agents = [agent()] as Agent[] } = {}) {
  const state = { facts, agents, you: you() };
  const backend = fakeBackend({
    'GET /api/you': () => state.you,
    'GET /api/you/memories': () => state.facts,
    'GET /api/agents': () => state.agents,
    'GET /api/agents/ag_rex/threads': () => [
      {
        threadId: 'th_trip',
        title: 'Trip planning',
        createdAt: 1,
        updatedAt: 1,
        busy: false,
        visibility: 'private',
        participants: [],
      },
    ],
  });
  return { backend, state };
}

describe('Settings → You', () => {
  it('saves the About me card, prefilled from this computer until then', async () => {
    const { backend, state } = backendWith();
    backend.routes['PUT /api/you/basics'] = (body) => {
      state.you = { ...state.you, basics: body as never, saved: true };
      return body;
    };
    view = await renderWithQuery(<SettingsYouPage />);
    await settle();
    expect(text()).toContain('Prefilled from this computer');
    expect((fieldByLabel('Name') as HTMLInputElement).value).toBe('Ada Lovelace');
    expect(text()).toContain('sent only to the model provider each agent uses');

    await typeInto(fieldByLabel('Role'), '  Mathematician ');
    await click(buttonByText('Save'));
    expect(backend.calls.filter((call) => call.method === 'PUT')).toEqual([
      {
        method: 'PUT',
        path: '/api/you/basics',
        body: basics({ role: 'Mathematician' }),
      },
    ]);
    expect(toast).toHaveBeenCalledWith('About me saved.');
    expect(text()).not.toContain('Prefilled from this computer');
  });

  it('shows facts by category with where they came from', async () => {
    backendWith({
      facts: [
        fact(),
        fact({
          id: 'um_k2',
          category: 'work',
          text: 'Works at the Analytical Engine company',
          sourceAgent: 'ag_rex',
          sourceThread: 'th_trip',
        }),
        fact({
          id: 'um_k3',
          category: 'work',
          text: 'Reads the Babbage newsletter',
          trust: 'external',
          sourceAgent: 'ag_rex',
        }),
      ],
    });
    view = await renderWithQuery(<SettingsYouPage />);
    await settle();
    const known = sectionTitled('What agents know about you')!;
    expect([...known.querySelectorAll('h3')].map((h) => h.textContent)).toEqual([
      'Preferences',
      'Work',
    ]);
    const row = (id: string) => known.querySelector(`[data-fact-id="${id}"]`);
    expect(row('um_k1')?.textContent).toContain('Added by you');
    expect(row('um_k2')?.textContent).toContain('Saved by Rex · in Trip planning');
    expect(row('um_k2')?.querySelector('a')?.getAttribute('href')).toBe(
      '/agents/ag_rex/threads/th_trip',
    );
    expect(row('um_k3')?.textContent).toContain('From outside text');
    expect(row('um_k1')?.textContent).not.toContain('From outside text');
  });

  it('accepts a suggestion, or edits it first, and shows them at the top', async () => {
    const suggestion = fact({
      id: 'um_s1',
      status: 'suggested',
      trust: 'inferred',
      category: 'people',
      text: 'Has a sister named Annabella',
      sourceAgent: 'ag_rex',
      sourceThread: 'th_trip',
    });
    const { backend, state } = backendWith({
      facts: [suggestion, fact({ id: 'um_s2', status: 'suggested', text: 'Likes tea' })],
    });
    backend.routes['PATCH /api/you/memories/um_s1'] = (body) => {
      state.facts = state.facts.map((f) => (f.id === 'um_s1' ? { ...f, status: 'active' } : f));
      return { ...suggestion, ...(body as object), status: 'active' };
    };
    backend.routes['PATCH /api/you/memories/um_s2'] = (body) => ({
      ...fact(),
      ...(body as object),
    });
    view = await renderWithQuery(<SettingsYouPage />);
    await settle();
    expect(document.querySelector('h2')?.textContent).toBe('Suggestions waiting');
    const waiting = sectionTitled('Suggestions waiting')!;
    expect(waiting.textContent).toContain('Saved by Rex · in Trip planning');

    await click(byLabel('Accept "Has a sister named Annabella"'));
    expect(backend.calls.filter((call) => call.method === 'PATCH')[0]).toEqual({
      method: 'PATCH',
      path: '/api/you/memories/um_s1',
      body: { accept: true },
    });
    expect(toast).toHaveBeenCalledWith('Accepted. Agents know it now.');
    expect(sectionTitled('Suggestions waiting')?.textContent).not.toContain('Annabella');
    expect(sectionTitled('What agents know about you')?.textContent).toContain(
      'Has a sister named Annabella',
    );

    await click(byLabel('Edit then accept "Likes tea"'));
    const editor = sectionTitled('Suggestions waiting')!;
    await typeInto(editor.querySelector('input'), 'Likes green tea');
    await click(buttonByText('Save and accept'));
    expect(backend.calls.filter((call) => call.method === 'PATCH')[1]).toEqual({
      method: 'PATCH',
      path: '/api/you/memories/um_s2',
      body: { text: 'Likes green tea', category: 'preferences', accept: true },
    });
  });

  it('dismisses a suggestion and deletes a fact', async () => {
    const { backend, state } = backendWith({
      facts: [fact(), fact({ id: 'um_s1', status: 'suggested', text: 'Likes tea' })],
    });
    const remove = (id: string) => () => {
      state.facts = state.facts.filter((f) => f.id !== id);
      return { ok: true };
    };
    backend.routes['DELETE /api/you/memories/um_k1'] = remove('um_k1');
    backend.routes['DELETE /api/you/memories/um_s1'] = remove('um_s1');
    view = await renderWithQuery(<SettingsYouPage />);
    await settle();

    await click(byLabel('Delete "Prefers short answers"'));
    expect(toast).toHaveBeenCalledWith('Deleted.');
    expect(text()).not.toContain('Prefers short answers');

    await click(byLabel('Dismiss "Likes tea"'));
    expect(toast).toHaveBeenCalledWith('Dismissed.');
    expect(sectionTitled('Suggestions waiting')).toBeUndefined();
    expect(backend.calls.filter((call) => call.method === 'DELETE').map((c) => c.path)).toEqual([
      '/api/you/memories/um_k1',
      '/api/you/memories/um_s1',
    ]);
  });

  it('adds a fact in a category', async () => {
    const { backend } = backendWith();
    backend.routes['POST /api/you/memories'] = (body) => fact(body as Partial<Fact>);
    view = await renderWithQuery(<SettingsYouPage />);
    await settle();
    const known = sectionTitled('What agents know about you')!;
    const select = known.querySelector('select') as HTMLSelectElement;
    select.value = 'projects';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await typeInto(known.querySelector('input'), 'Writing notes on the engine');
    await click(buttonByText('Add'));
    expect(backend.calls.find((call) => call.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/you/memories',
      body: { category: 'projects', text: 'Writing notes on the engine' },
    });
    expect(toast).toHaveBeenCalledWith('Added.');
  });

  it('saves which agents see what, and memory on or off, per agent', async () => {
    const { backend, state } = backendWith({
      agents: [
        agent(),
        agent({ id: 'ag_ada', name: 'Ada', memory: { off: false, share: ['work'] } }),
      ],
    });
    backend.routes['PATCH /api/agents/ag_rex'] = (body) => {
      const next = { ...state.agents[0]!, ...(body as Partial<Agent>) };
      state.agents = [next, state.agents[1]!];
      return next;
    };
    backend.routes['PATCH /api/agents/ag_ada'] = (body) => ({
      ...state.agents[1]!,
      ...(body as Partial<Agent>),
    });
    view = await renderWithQuery(<SettingsYouPage />);
    await settle();
    const table = document.querySelector('table')!;
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      'Agent',
      'Memory on',
      'People',
      'Projects',
      'Work',
      'Health',
      'Family',
      'Finances',
      'Home',
      'Interests',
    ]);
    expect((byLabel('Ada sees work') as HTMLInputElement).checked).toBe(true);

    await click(byLabel('Rex sees health'));
    await click(byLabel('Rex sees people'));
    await click(byLabel('Memory for Ada'));
    expect(
      backend.calls.filter((call) => call.method === 'PATCH').map((c) => [c.path, c.body]),
    ).toEqual([
      ['/api/agents/ag_rex', { memory: { off: false, share: ['health'] } }],
      // In the categories' order.
      ['/api/agents/ag_rex', { memory: { off: false, share: ['people', 'health'] } }],
      ['/api/agents/ag_ada', { memory: { off: true, share: ['work'] } }],
    ]);
    expect(toast).toHaveBeenCalledWith('Rex saved.');
    expect(text()).toContain(
      'Every agent with memory on sees your About me card and your preferences.',
    );
  });

  it('erases everything only once "erase" is typed', async () => {
    const { backend, state } = backendWith({ facts: [fact()] });
    backend.routes['POST /api/you/erase'] = () => {
      state.facts = [];
      return { ok: true };
    };
    view = await renderWithQuery(<SettingsYouPage />);
    await settle();
    await click(buttonByText('Erase everything'));
    const dialog = document.querySelector('[role="dialog"]')!;
    const confirm = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent === 'Erase everything',
    )!;
    expect(confirm.disabled).toBe(true);
    await typeInto(fieldByLabel('Type "erase" to confirm'), 'Erase');
    expect(confirm.disabled).toBe(true);
    await typeInto(fieldByLabel('Type "erase" to confirm'), 'erase');
    expect(confirm.disabled).toBe(false);
    await click(confirm);
    expect(backend.calls.filter((call) => call.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/you/erase', body: { confirm: 'erase' } },
    ]);
    expect(toast).toHaveBeenCalledWith('Everything about you is erased.');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(text()).not.toContain('Prefers short answers');
  });
});

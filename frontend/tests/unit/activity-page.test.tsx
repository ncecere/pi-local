// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ActivityEntry, type ActivityPage, type Agent, ApiError } from '../../src/api/client';
import { ActivityTab } from '../../src/components/agent-manager/activity-tab';
import { SettingsActivityPage } from '../../src/routes/settings/activity';
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
      href={Object.entries(params ?? {}).reduce((href, [k, v]) => href.replace(`$${k}`, v), to)}
      className={className}
    >
      {children}
    </a>
  ),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
  toast.mockClear();
  toast.error.mockClear();
});

let nextId = 1;
function entry(change: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: nextId++,
    at: Date.UTC(2026, 9, 21, 14, 3, 22),
    kind: 'tool',
    agentId: 'ag_hardac',
    agentName: 'Hardac',
    threadId: 't1',
    actor: 'Hardac',
    title: 'bash',
    outcome: 'ok',
    durationMs: 1400,
    detail: { callId: 'c1', arguments: { command: 'git status' } },
    ...change,
  };
}

const page = (items: ActivityEntry[], nextBefore: string | null = null): ActivityPage => ({
  items,
  nextBefore,
});

const agents = [
  { id: 'ag_hardac', name: 'Hardac', enabled: true },
  { id: 'ag_rex', name: 'Rex', enabled: true },
] as unknown as Agent[];

const calls = (backend: ReturnType<typeof fakeBackend>) =>
  backend.calls.filter((call) => call.path.startsWith('/api/activity')).map((call) => call.path);

async function choose(select: HTMLElement | null, value: string) {
  if (!(select instanceof HTMLSelectElement)) throw new Error('Not a select');
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

describe('Settings → Activity', () => {
  it('names approval tools in human words and includes the key argument', async () => {
    fakeBackend({
      'GET /api/agents': () => agents,
      'GET /api/activity?limit=100': () =>
        page([
          entry({
            kind: 'approval',
            title: 'Approved bash',
            detail: {
              tool: 'bash',
              arguments: { command: 'git status --short' },
              summary: 'Asked by the profile',
            },
          }),
        ]),
    });
    view = await renderWithQuery(<SettingsActivityPage />);
    await settle();
    const row = document.querySelector('li[data-kind="approval"]');
    expect(row?.textContent).toContain('Approved: Run command');
    expect(row?.textContent).toContain('git status --short');
    expect(row?.textContent).toContain('Asked by the profile');
  });

  it('lists what happened, newest first, with how each thing ended and a link to its conversation', async () => {
    fakeBackend({
      'GET /api/agents': () => agents,
      'GET /api/activity?limit=100': () =>
        page([
          entry({
            title: 'bash',
            detail: {
              callId: 'c1',
              arguments: { command: 'git status' },
              approval: { status: 'approved', by: 'Ann' },
            },
          }),
          entry({
            title: 'write',
            outcome: 'denied',
            durationMs: null,
            threadId: 't2',
            detail: {
              callId: 'c2',
              arguments: { path: 'notes.md' },
              error: 'Tool call blocked: denied by Ann: not today',
            },
          }),
          entry({
            kind: 'message',
            title: 'Message sent',
            actor: 'Ann',
            durationMs: null,
            detail: { preview: 'Please tidy the notes', chars: 21 },
          }),
          entry({
            kind: 'sign_in',
            agentId: null,
            agentName: '',
            threadId: null,
            actor: 'Ann',
            title: 'Signed in to GitHub',
            durationMs: null,
            detail: { server: 'github' },
          }),
        ]),
    });
    view = await renderWithQuery(<SettingsActivityPage />);
    await settle();

    const rows = [...document.querySelectorAll('li[data-kind]')];
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual([
      'tool',
      'tool',
      'message',
      'sign_in',
    ]);
    expect(rows[0]!.textContent).toContain('Tool call');
    expect(rows[0]!.textContent).toContain('Run command');
    expect(rows[0]!.textContent).toContain('git status');
    expect(rows[0]!.textContent).toContain('Hardac');
    expect(rows[0]!.textContent).toContain('Done');
    expect(rows[0]!.textContent).toContain('1.4 s');
    expect(rows[0]!.querySelector('a')?.getAttribute('href')).toBe('/agents/ag_hardac/threads/t1');
    expect(rows[1]!.querySelector('[data-outcome="denied"]')?.textContent).toBe('Denied');
    expect(rows[1]!.textContent).toContain('denied by Ann: not today');
    expect(rows[1]!.querySelector('a')?.getAttribute('href')).toBe('/agents/ag_hardac/threads/t2');
    expect(rows[2]!.textContent).toContain('Please tidy the notes');
    // Without an agent or a conversation there is nothing to open.
    expect(rows[3]!.textContent).toContain('Signed in to GitHub');
    expect(rows[3]!.querySelector('a')).toBeNull();
  });

  it('filters ask the backend, and clearing them goes back', async () => {
    const backend = fakeBackend({
      'GET /api/agents': () => agents,
      'GET /api/activity?limit=100': () => page([entry({})]),
      'GET /api/activity?agent=ag_rex&limit=100': () => page([]),
      'GET /api/activity?agent=ag_rex&kind=error&limit=100': () => page([]),
      'GET /api/activity?agent=ag_rex&kind=error&outcome=error&limit=100': () => page([]),
      'GET /api/activity?agent=ag_rex&kind=error&outcome=error&q=boom&limit=100': () => page([]),
    });
    view = await renderWithQuery(<SettingsActivityPage />);
    await settle();
    expect(fieldByLabel('Agent')?.querySelectorAll('option').length).toBe(3);

    await choose(fieldByLabel('Agent'), 'ag_rex');
    expect(document.body.textContent).toContain('Nothing matches these filters.');
    await choose(fieldByLabel('What'), 'error');
    await choose(fieldByLabel('How it ended'), 'error');
    const search = fieldByLabel('Search');
    await typeInto(search, ' boom ');
    await act(async () => {
      search
        ?.closest('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(calls(backend).at(-1)).toBe(
      '/api/activity?agent=ag_rex&kind=error&outcome=error&q=boom&limit=100',
    );

    await click(buttonByText('Clear filters'));
    // Unfiltered again (its answer was kept, so nothing new is asked).
    expect((fieldByLabel('Agent') as HTMLSelectElement).value).toBe('');
    expect((fieldByLabel('What') as HTMLSelectElement).value).toBe('');
    expect((fieldByLabel('Search') as HTMLInputElement).value).toBe('');
    expect(calls(backend)).toContain('/api/activity?limit=100');
    expect(document.querySelectorAll('li[data-kind]').length).toBe(1);
    expect(buttonByText('Clear filters')).toBeUndefined();
  });

  it('the period filter asks for entries since a time', async () => {
    const backend = fakeBackend({
      'GET /api/agents': () => agents,
      'GET /api/activity?limit=100': () => page([entry({})]),
    });
    backend.routes = new Proxy(backend.routes, {
      get: (routes, key: string) =>
        key.startsWith('GET /api/activity?since=') ? () => page([]) : routes[key],
    });
    view = await renderWithQuery(<SettingsActivityPage />);
    await settle();
    const before = Date.now();
    await choose(fieldByLabel('When'), 'day');
    const last = calls(backend).at(-1)!;
    const since = Number(new URL(last, 'http://x').searchParams.get('since'));
    expect(since).toBeGreaterThanOrEqual(before - 24 * 3_600_000);
    expect(since).toBeLessThanOrEqual(Date.now() - 24 * 3_600_000 + 1_000);
  });

  it('shows older entries a page at a time', async () => {
    const backend = fakeBackend({
      'GET /api/agents': () => agents,
      'GET /api/activity?limit=100': () => page([entry({ title: 'newer' })], '1792000000000.9'),
      'GET /api/activity?before=1792000000000.9&limit=100': () => page([entry({ title: 'older' })]),
    });
    view = await renderWithQuery(<SettingsActivityPage />);
    await settle();
    expect(document.body.textContent).toContain('newer');
    await click(buttonByText('Show older'));
    expect(calls(backend).at(-1)).toBe('/api/activity?before=1792000000000.9&limit=100');
    expect(document.body.textContent).toContain('older');
    expect(buttonByText('Show older')).toBeUndefined();
  });

  it('exports what the filters match, through the desktop dialog when there is one', async () => {
    const backend = fakeBackend({
      'GET /api/agents': () => agents,
      'GET /api/activity?limit=100': () => page([entry({})]),
      'GET /api/activity?kind=tool&limit=100': () => page([entry({})]),
      'POST /api/activity/export?kind=tool': () => ({ path: '/Users/ann/activity.csv' }),
    });
    view = await renderWithQuery(<SettingsActivityPage />);
    await settle();
    await choose(fieldByLabel('What'), 'tool');
    await click(buttonByText('Export CSV'));
    expect(
      backend.calls.some(
        (call) => call.method === 'POST' && call.path === '/api/activity/export?kind=tool',
      ),
    ).toBe(true);
    expect(toast).toHaveBeenCalledWith('Saved /Users/ann/activity.csv.');
  });

  it('says plainly when the export fails or the dialog is cancelled', async () => {
    let answer: () => unknown = () => ({ cancelled: true });
    fakeBackend({
      'GET /api/agents': () => agents,
      'GET /api/activity?limit=100': () => page([entry({})]),
      'POST /api/activity/export?': () => answer(),
    });
    view = await renderWithQuery(<SettingsActivityPage />);
    await settle();
    await click(buttonByText('Export CSV'));
    expect(toast).not.toHaveBeenCalled();
    answer = () => {
      throw new ApiError(500, 'internal', 'could not export the activity');
    };
    await click(buttonByText('Export CSV'));
    expect(toast.error).toHaveBeenCalledWith('could not export the activity');
  });

  it('says so when there is nothing yet, and when the log cannot be read', async () => {
    fakeBackend({ 'GET /api/agents': () => agents, 'GET /api/activity?limit=100': () => page([]) });
    view = await renderWithQuery(<SettingsActivityPage />);
    await settle();
    expect(document.body.textContent).toContain(
      'Nothing yet. What your agents do shows here as it happens.',
    );
    view.unmount();

    fakeBackend({
      'GET /api/agents': () => agents,
      'GET /api/activity?limit=100': () => {
        throw new ApiError(500, 'internal', 'could not read the activity');
      },
    });
    view = await renderWithQuery(<SettingsActivityPage />);
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'could not read the activity',
    );
  });
});

describe("an agent's Activity tab", () => {
  it("lists that agent's entries without an agent filter, and exports only them", async () => {
    const backend = fakeBackend({
      'GET /api/agents': () => agents,
      'GET /api/activity?agent=ag_rex&limit=100': () =>
        page([entry({ agentId: 'ag_rex', agentName: 'Rex', actor: 'Rex', title: 'read' })]),
      'POST /api/activity/export?agent=ag_rex': () => ({ path: '/tmp/rex.csv' }),
    });
    view = await renderWithQuery(<ActivityTab agent={agents[1]!} />);
    await settle();
    expect(fieldByLabel('Agent')).toBeNull();
    expect(document.body.textContent).toContain('What Rex did and what was done to it');
    expect(document.querySelectorAll('li[data-kind]').length).toBe(1);
    // The agent's own name isn't repeated on every row.
    expect(document.querySelector('li[data-kind]')?.textContent).not.toContain('Rex');
    await click(buttonByText('Export CSV'));
    expect(backend.calls.some((call) => call.path === '/api/activity/export?agent=ag_rex')).toBe(
      true,
    );
  });
});

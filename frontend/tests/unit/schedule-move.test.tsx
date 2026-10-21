// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Schedule } from '../../src/api/client';
import { ScheduleDialog } from '../../src/components/schedules/schedule-dialog';
import { ScheduleList } from '../../src/components/schedules/schedule-list';
import { scheduleChanges, scheduleFormOf } from '../../src/lib/schedules';
import { agent } from './memory-fixtures';
import {
  buttonByText,
  click,
  fakeBackend,
  fieldByLabel,
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

const REX = agent();
const ADA = agent({ id: 'ag_ada', name: 'Ada' });
const NOW = Date.UTC(2026, 9, 21, 12, 0);

const schedule = (change: Partial<Schedule> = {}): Schedule => ({
  id: 'sc_1',
  agentId: 'ag_rex',
  agentName: 'Rex',
  name: 'Morning briefing',
  once: false,
  at: null,
  cron: '0 9 * * 1-5',
  timezone: 'America/New_York',
  message: 'Brief me',
  threadMode: 'new',
  threadId: null,
  originThreadId: null,
  madeBy: 'user',
  missedPolicy: 'run_once',
  paused: false,
  pausedReason: null,
  nextFireAt: NOW + 3_600_000,
  lastFireAt: null,
  lastRun: null,
  createdAt: NOW - 86_400_000,
  ...change,
});

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

describe('a finished one-time schedule', () => {
  it('shows Done instead of Pause or Resume, and the others keep theirs', async () => {
    fakeBackend();
    view = await renderWithQuery(
      <ScheduleList
        agents={[REX]}
        emptyText="None"
        schedules={[
          schedule({
            id: 'a',
            name: 'Reminder',
            once: true,
            at: NOW - 1000,
            cron: null,
            nextFireAt: null,
          }),
          schedule({ id: 'b', name: 'Daily' }),
          schedule({ id: 'c', name: 'Weekly', paused: true }),
        ]}
      />,
    );
    const button = (label: string) => document.querySelector(`button[aria-label="${label}"]`);
    expect(button('Pause Reminder')).toBeNull();
    expect(button('Resume Reminder')).toBeNull();
    const reminder = [...document.querySelectorAll('li')].find((row) =>
      row.textContent?.includes('Reminder'),
    );
    // It says Done where the pause control would be.
    expect(
      [...(reminder?.querySelectorAll('span') ?? [])].some((s) => s.textContent === 'Done'),
    ).toBe(true);
    // Run now, edit and delete stay.
    expect(button('Edit Reminder')).not.toBeNull();
    expect(button('Pause Daily')).not.toBeNull();
    expect(button('Resume Weekly')).not.toBeNull();
  });

  it('is not one that merely has no next time while recurring', async () => {
    fakeBackend();
    view = await renderWithQuery(
      <ScheduleList
        agents={[REX]}
        emptyText="None"
        schedules={[schedule({ name: 'Odd', nextFireAt: null })]}
      />,
    );
    expect(document.querySelector('button[aria-label="Pause Odd"]')).not.toBeNull();
  });
});

describe('moving a schedule to another agent', () => {
  const select = () => fieldByLabel('Agent') as HTMLSelectElement;
  async function choose(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(
        select(),
        value,
      );
      select().dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  async function edit(current: Schedule) {
    const backend = fakeBackend({
      'GET /api/agents': () => [REX, ADA],
      'GET /api/agents/ag_rex/threads': () => [],
      'GET /api/agents/ag_ada/threads': () => [],
      'PATCH /api/schedules/sc_1': () => ({ ...current, agentId: 'ag_ada', agentName: 'Ada' }),
    });
    // Opened from an agent's own page, which knows only that agent.
    view = await renderWithQuery(
      <ScheduleDialog schedule={current} agents={[REX]} agentId="ag_rex" onClose={() => {}} />,
    );
    await settle();
    return backend;
  }

  it('offers an Agent select in the edit dialog, on the current agent', async () => {
    await edit(schedule());
    expect(select().value).toBe('ag_rex');
    expect([...select().options].map((option) => option.textContent)).toEqual(['Rex', 'Ada']);
    expect(document.body.textContent).not.toContain('Runs will start new conversations');
  });

  it('says its runs will start new conversations with the new agent, and sends agentId', async () => {
    const backend = await edit(schedule());
    await choose('ag_ada');
    expect(document.querySelector('[role="note"]')?.textContent).toBe(
      'Runs will start new conversations with Ada.',
    );
    await click(buttonByText('Save'));
    expect(backend.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      agentId: 'ag_ada',
      threadMode: 'new',
    });
  });

  it('leaves out "same conversation" once moved, and brings it back when moved back', async () => {
    const same = schedule({ threadMode: 'this', threadId: 't9' });
    await edit(same);
    expect(document.body.textContent).toContain('Always the same conversation');
    await choose('ag_ada');
    expect(document.body.textContent).not.toContain('Always the same conversation');
    await choose('ag_rex');
    expect(document.body.textContent).toContain('Always the same conversation');
    expect(document.body.textContent).not.toContain('Runs will start new conversations');
  });

  it('sends nothing for the agent when it did not change', async () => {
    const backend = await edit(schedule());
    await click(buttonByText('Save'));
    // Nothing changed: the dialog just closes.
    expect(backend.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('is only the agent, and a new conversation each time, in the PATCH body', () => {
    const before = scheduleFormOf(schedule({ threadMode: 'this', threadId: 't9' }), 'ag_rex');
    const after = { ...before, agentId: 'ag_ada', threadMode: 'new' as const, threadId: '' };
    expect(scheduleChanges(before, after)).toEqual({ agentId: 'ag_ada', threadMode: 'new' });
  });
});

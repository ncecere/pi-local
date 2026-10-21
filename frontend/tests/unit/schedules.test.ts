import { describe, expect, it } from 'vitest';
import type { Schedule, ScheduleRun } from '../../src/api/types';
import {
  applyRunToHistory,
  applyScheduleEvent,
  applyScheduleRun,
  describeCron,
  isScheduledThreadId,
  lastRunLabel,
  madeByLabel,
  nextFireLabel,
  presetCron,
  relativeTime,
  runStatusLabel,
  type ScheduleForm,
  scheduleChanges,
  scheduleFormOf,
  scheduleFormProblem,
  scheduleInputOf,
  scheduleStatus,
  sortSchedules,
  type WhenForm,
  whenFromSchedule,
  whenLabel,
  whenProblem,
  whenToInput,
  zonedTimeToMs,
} from '../../src/lib/schedules';

const NY = 'America/New_York';
// Tue 20 Oct 2026 12:00 UTC (08:00 in New York, EDT).
const NOW = Date.UTC(2026, 9, 20, 12, 0);

const run = (extra: Partial<ScheduleRun> = {}): ScheduleRun => ({
  id: 'r1',
  scheduleId: 's1',
  threadId: 'sched-1',
  firedAt: NOW - 10 * 60_000,
  status: 'done',
  error: null,
  finishedAt: NOW - 5 * 60_000,
  ...extra,
});

const schedule = (extra: Partial<Schedule> = {}): Schedule => ({
  id: 's1',
  agentId: 'ag_a',
  agentName: 'Helper',
  name: 'Morning briefing',
  once: false,
  at: null,
  cron: '0 9 * * 1-5',
  timezone: NY,
  message: 'Brief me.',
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
  ...extra,
});

describe('describeCron', () => {
  // Times follow the system's locale: 12 h in the US, 24 h in much of Europe.
  it.each([
    ['0 9 * * *', 'Every day at 9:00 AM'],
    ['0 9 * * 1-5', 'Every weekday at 9:00 AM'],
    ['30 8 * * MON-FRI', 'Every weekday at 8:30 AM'],
    ['0 9 * * 1', 'Every Monday at 9:00 AM'],
    ['0 9 * * 7', 'Every Sunday at 9:00 AM'],
    ['0 10 * * 0,6', 'Every Saturday and Sunday at 10:00 AM'],
    ['0 9 * * 1,3,5', 'Every Mon, Wed and Fri at 9:00 AM'],
    ['0 9,17 * * *', 'Every day at 9:00 AM and 5:00 PM'],
    ['0 * * * *', 'Every hour'],
    ['15 * * * *', 'Every hour at :15'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['* * * * *', 'Every minute'],
    ['0 */2 * * *', 'Every 2 hours'],
    ['0 8 1 * *', 'On the 1st of every month at 8:00 AM'],
    ['0 8 1,15 * *', 'On the 1st and 15th of every month at 8:00 AM'],
    ['0 0 25 12 *', 'Every year on Dec 25 at 12:00 AM'],
    ['@daily', 'Every day at 12:00 AM'],
    ['@weekly', 'Every Sunday at 12:00 AM'],
    ['@hourly', 'Every hour'],
    ['  0   9 * *  1-5 ', 'Every weekday at 9:00 AM'],
  ])('%s → %s', (expr, words) => {
    expect(describeCron(expr, 'en-US')).toBe(words);
  });

  it('writes times in 24 h where the locale does', () => {
    const british = describeCron('0 9,17 * * *', 'en-GB');
    expect(british).toContain('17:00');
    expect(british).not.toMatch(/AM|PM/);
    expect(describeCron('0 9,17 * * *', 'en-US')).toContain('5:00 PM');
  });

  it('gives up on what it does not read, so the expression itself is shown', () => {
    for (const expr of [
      '0 9 1-7 * 1',
      '5/10 * * * *',
      '0 9 * *',
      'nonsense',
      '@every 5m',
      '61 9 * * *',
    ])
      expect(describeCron(expr)).toBeNull();
  });
});

describe('whenLabel', () => {
  it('says a one-time schedule with its date and time', () => {
    const at = Date.UTC(2026, 9, 21, 13, 0); // Wed 21 Oct 09:00 in New York
    expect(
      whenLabel(schedule({ once: true, at, cron: null }), {
        timeZone: NY,
        now: NOW,
        locale: 'en-US',
      }),
    ).toBe('Once, Oct 21, 9:00 AM');
  });

  it('says a recurring one in words with its zone, or its expression', () => {
    expect(whenLabel(schedule(), { timeZone: 'UTC', now: NOW, locale: 'en-US' })).toBe(
      'Every weekday at 9:00 AM (America/New_York)',
    );
    expect(whenLabel(schedule({ cron: '0 9 1-7 * 1' }), { now: NOW })).toBe(
      '0 9 1-7 * 1 (America/New_York)',
    );
  });
});

describe('the "when" form and {at | cron, timezone}', () => {
  const base: WhenForm = {
    kind: 'once',
    date: '2026-10-21',
    time: '09:00',
    preset: 'daily',
    weekday: 1,
    minute: 0,
    cron: '',
    timezone: NY,
  };

  it('sends a one-time schedule as a wall-clock time in its zone', () => {
    expect(whenToInput(base)).toEqual({ at: '2026-10-21T09:00', timezone: NY });
  });

  it('sends each preset as its cron expression', () => {
    const repeats = { ...base, kind: 'repeats' as const, time: '07:30' };
    expect(presetCron({ ...repeats, preset: 'daily' })).toBe('30 7 * * *');
    expect(presetCron({ ...repeats, preset: 'weekdays' })).toBe('30 7 * * 1-5');
    expect(presetCron({ ...repeats, preset: 'weekly', weekday: 0 })).toBe('30 7 * * 0');
    expect(presetCron({ ...repeats, preset: 'hourly', minute: 45 })).toBe('45 * * * *');
    expect(whenToInput({ ...repeats, preset: 'custom', cron: '  0  12 * * 6 ' })).toEqual({
      cron: '0 12 * * 6',
      timezone: NY,
    });
  });

  it('round-trips: form → API → schedule → form', () => {
    const forms: WhenForm[] = [
      base,
      { ...base, date: '2026-11-01', time: '01:30' }, // the night DST ends in New York
      { ...base, kind: 'repeats', preset: 'daily', time: '06:05' },
      { ...base, kind: 'repeats', preset: 'weekdays', time: '09:00' },
      { ...base, kind: 'repeats', preset: 'weekly', weekday: 3, time: '18:45' },
      { ...base, kind: 'repeats', preset: 'hourly', minute: 20 },
      { ...base, kind: 'repeats', preset: 'custom', cron: '*/10 9-17 * * 1-5' },
      { ...base, kind: 'repeats', preset: 'custom', cron: '@daily', timezone: 'Asia/Tokyo' },
    ];
    for (const form of forms) {
      const input = whenToInput(form);
      // What the backend stores: `at` as an instant (no offset: in the zone), or the cron.
      const saved =
        'at' in input
          ? {
              once: true,
              at: zonedTimeToMs(form.date, form.time, input.timezone),
              cron: null,
              timezone: input.timezone,
            }
          : { once: false, at: null, cron: input.cron, timezone: input.timezone };
      const back = whenFromSchedule(saved, NOW);
      expect(whenToInput(back)).toEqual(input);
      expect(back.kind).toBe(form.kind);
      if (form.kind === 'once') expect([back.date, back.time]).toEqual([form.date, form.time]);
      else expect(back.preset).toBe(form.preset);
    }
  });

  it('round-trips: cron → form → cron, with presets recognised', () => {
    for (const cron of ['0 9 * * *', '0 9 * * 1-5', '15 18 * * 4', '5 * * * *', '0 9 1 * *']) {
      const form = whenFromSchedule({ once: false, at: null, cron, timezone: NY }, NOW);
      expect(presetCron(form)).toBe(cron);
    }
    expect(
      whenFromSchedule({ once: false, at: null, cron: '0 9 * * 7', timezone: NY }).weekday,
    ).toBe(0);
    expect(
      whenFromSchedule({ once: false, at: null, cron: '0 9 1 * *', timezone: NY }).preset,
    ).toBe('custom');
  });

  it('turns a wall clock in a zone into the instant, and back', () => {
    expect(zonedTimeToMs('2026-10-21', '09:00', NY)).toBe(Date.UTC(2026, 9, 21, 13, 0));
    expect(zonedTimeToMs('2026-12-21', '09:00', NY)).toBe(Date.UTC(2026, 11, 21, 14, 0));
    expect(zonedTimeToMs('2026-10-21', '09:00', 'UTC')).toBe(Date.UTC(2026, 9, 21, 9, 0));
    expect(Number.isNaN(zonedTimeToMs('', '09:00', NY))).toBe(true);
  });

  it('says what is missing before sending', () => {
    expect(whenProblem(base)).toBeNull();
    expect(whenProblem({ ...base, date: '' })).toBe('Choose a date.');
    expect(whenProblem({ ...base, kind: 'repeats', preset: 'custom', cron: ' ' })).toMatch(/cron/);
    expect(whenProblem({ ...base, kind: 'repeats', preset: 'hourly', minute: 60 })).toMatch(
      /minute/,
    );
  });
});

describe('the schedule form', () => {
  it('starts a new one once, tomorrow at 09:00, in a new conversation, run once if missed', () => {
    const form = scheduleFormOf(null, 'ag_a', NOW);
    expect(form).toMatchObject({
      agentId: 'ag_a',
      threadMode: 'new',
      missedPolicy: 'run_once',
      when: { kind: 'once', time: '09:00' },
    });
    expect(scheduleFormProblem(form)).toBe('Write the message it sends.');
    expect(scheduleFormProblem({ ...form, message: 'Hi', threadMode: 'this' })).toMatch(
      /conversation/,
    );
  });

  it('sends a whole new schedule, and only what changed in an edit', () => {
    const form: ScheduleForm = scheduleFormOf(schedule(), 'ag_a', NOW);
    expect(scheduleInputOf(form)).toEqual({
      name: 'Morning briefing',
      message: 'Brief me.',
      cron: '0 9 * * 1-5',
      timezone: NY,
      threadMode: 'new',
      missedPolicy: 'run_once',
    });
    expect(scheduleChanges(form, form)).toEqual({});
    expect(scheduleChanges(form, { ...form, message: ' Brief me now. ' })).toEqual({
      message: 'Brief me now.',
    });
    expect(scheduleChanges(form, { ...form, when: { ...form.when, kind: 'once' } })).toMatchObject({
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T09:00$/),
      timezone: NY,
    });
    expect(scheduleChanges(form, { ...form, threadMode: 'this', threadId: 't1' })).toEqual({
      threadMode: 'this',
      threadId: 't1',
    });
  });
});

describe('status labels', () => {
  it('says what a schedule is doing', () => {
    expect(scheduleStatus(schedule()).label).toBe('Active');
    expect(scheduleStatus(schedule({ paused: true })).label).toBe('Paused');
    expect(
      scheduleStatus(schedule({ paused: true, pausedReason: 'It failed 5 times in a row.' })),
    ).toEqual({
      state: 'paused',
      label: 'Paused after failing',
      detail: 'It failed 5 times in a row.',
    });
    expect(scheduleStatus(schedule({ lastRun: run({ status: 'running' }) })).state).toBe('running');
    expect(scheduleStatus(schedule({ once: true, nextFireAt: null })).label).toBe('Done');
  });

  it('says runs, next times and who made it', () => {
    expect(runStatusLabel('failed')).toBe('Failed');
    expect(lastRunLabel(run(), NOW)).toBe('Finished 5 minutes ago');
    expect(lastRunLabel(run({ status: 'running', finishedAt: null }), NOW)).toBe(
      'Running (started 10 minutes ago)',
    );
    // A run that ended after the (ticking) clock last moved is still in the past.
    expect(lastRunLabel(run({ finishedAt: NOW + 5000 }), NOW)).toBe('Finished just now');
    expect(nextFireLabel(schedule(), NOW)).toBe('in 1 hour');
    expect(nextFireLabel(schedule({ paused: true }), NOW)).toBe('Not while paused');
    expect(nextFireLabel(schedule({ nextFireAt: null }), NOW)).toBe('Not again');
    expect(madeByLabel(schedule({ madeBy: 'agent' }))).toBe('The agent');
    expect(relativeTime(NOW + 20_000, NOW)).toBe('in under a minute');
    expect(relativeTime(NOW + 26 * 3_600_000, NOW)).toBe('tomorrow');
  });

  it('knows a conversation a schedule started', () => {
    expect(isScheduledThreadId('sched-abc')).toBe(true);
    expect(isScheduledThreadId('3f2a')).toBe(false);
  });
});

describe('the cached list', () => {
  const a = schedule({ id: 'a', nextFireAt: NOW + 2000 });
  const b = schedule({ id: 'b', nextFireAt: NOW + 1000 });
  const done = schedule({ id: 'c', nextFireAt: null });

  it('keeps the next to fire first, paused and finished last', () => {
    expect(sortSchedules([done, a, b]).map((s) => s.id)).toEqual(['b', 'a', 'c']);
    expect(
      sortSchedules([schedule({ id: 'p', paused: true, nextFireAt: NOW }), a]).map((s) => s.id),
    ).toEqual(['a', 'p']);
  });

  it('adds, changes and removes', () => {
    expect(applyScheduleEvent([a], 'b', b)?.map((s) => s.id)).toEqual(['b', 'a']);
    expect(applyScheduleEvent([a, b], 'a', { ...a, name: 'Renamed' })?.[1]?.name).toBe('Renamed');
    expect(applyScheduleEvent([a, b], 'a', null)?.map((s) => s.id)).toEqual(['b']);
    expect(applyScheduleEvent(undefined, 'a', a)).toBeUndefined();
  });

  it('records a run that ended, but never over a later one', () => {
    const later = run({ id: 'r2', firedAt: NOW });
    const withLater = applyScheduleRun([schedule({ id: 's1', lastRun: later })], {
      scheduleId: 's1',
      run: run({ id: 'r1', status: 'failed' }),
    });
    expect(withLater?.[0]?.lastRun?.id).toBe('r2');
    const updated = applyScheduleRun([schedule({ lastRun: run({ status: 'running' }) })], {
      scheduleId: 's1',
      run: run({ status: 'done' }),
    });
    expect(updated?.[0]?.lastRun?.status).toBe('done');
    expect(updated?.[0]?.lastFireAt).toBe(run().firedAt);
    expect(applyRunToHistory([run()], run({ id: 'r9' }))?.map((r) => r.id)).toEqual(['r9', 'r1']);
    expect(applyRunToHistory([run()], run({ status: 'failed' }))?.[0]?.status).toBe('failed');
  });
});

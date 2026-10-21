import type {
  Schedule,
  ScheduleInput,
  ScheduleRun,
  ScheduleRunEvent,
  ScheduleRunStatus,
} from '~/api/types';
import { formatDayTime, formatMonthDay, formatTimeOfDay } from '~/lib/dates';

/**
 * Schedules (docs/api.md, "Always on"): saying when one fires, the "when" form
 * and the API's `{at | cron, timezone}`, and status labels. Pure: no React.
 */

/** The limits on what an agent sets for itself (docs/api.md). */
export const AGENT_SCHEDULE_LIMITS = { count: 20, minMinutes: 5, runsPerDay: 300 } as const;
/** A schedule's message: 1–32,000 characters. Its name: at most 80 (longer is cut). */
export const SCHEDULE_MESSAGE_MAX = 32_000;
export const SCHEDULE_NAME_MAX = 80;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const MONTH_SHORT = MONTH_NAMES.map((name) => name.slice(0, 3));
const DAY_ALIASES: Record<string, number> = Object.fromEntries(
  DAY_SHORT.map((name, index) => [name.toLowerCase(), index]),
);
const MONTH_ALIASES: Record<string, number> = Object.fromEntries(
  MONTH_SHORT.map((name, index) => [name.toLowerCase(), index + 1]),
);

export { DAY_NAMES };

const pad = (value: number) => String(value).padStart(2, '0');

/** "a, b and c". */
function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** "1st", "2nd", "23rd". */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}

/** A plain number field within bounds, or null. */
function numberIn(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

/**
 * A list field ("1,3,5", "1-5", "mon-fri", "MON,WED") as its sorted values, or
 * null when it has steps or anything else this describer doesn't read.
 */
function listIn(
  field: string,
  min: number,
  max: number,
  aliases: Record<string, number> = {},
): number[] | null {
  const value = (part: string) => {
    const alias = aliases[part.toLowerCase()];
    return alias !== undefined ? alias : numberIn(part, min, max);
  };
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const range = part.split('-');
    if (range.length === 1) {
      const single = value(part);
      if (single === null) return null;
      out.add(single);
    } else if (range.length === 2) {
      const from = value(range[0]!);
      const to = value(range[1]!);
      if (from === null || to === null || to < from) return null;
      for (let at = from; at <= to; at++) out.add(at);
    } else return null;
  }
  return [...out].sort((a, b) => a - b);
}

/** Weekdays (0–6; 7 is Sunday too) of a day-of-week field. */
function daysOf(field: string): number[] | null {
  const days = listIn(field, 0, 7, DAY_ALIASES);
  if (!days) return null;
  return [...new Set(days.map((day) => day % 7))].sort((a, b) => a - b);
}

function daysPhrase(days: number[]): string {
  const key = days.join(',');
  if (key === '1,2,3,4,5') return 'weekday';
  if (key === '0,6') return 'Saturday and Sunday';
  if (days.length === 1) return DAY_NAMES[days[0]!]!;
  if (days.length === 7) return 'day';
  return joinWords(days.map((day) => DAY_SHORT[day]!));
}

/** What `@daily` and the like mean, as a cron expression. */
const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

/**
 * A cron expression in words, for the common patterns: "Every weekday at
 * 9:00 AM", "Every hour at :15", "Every 15 minutes", "On the 1st of every
 * month at 8:30 AM" (times in the system's hour style). Null when it is
 * something else (show the expression itself).
 */
export function describeCron(expression: string, locale?: string): string | null {
  const expr = MACROS[expression.trim().toLowerCase()] ?? expression.trim().replace(/\s+/g, ' ');
  const fields = expr.split(' ');
  if (fields.length !== 5) return null;
  const [minuteField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const everyDay = domField === '*' && monthField === '*' && (dowField === '*' || dowField === '?');

  // Sub-daily: every minute, every N minutes, every hour, every N hours.
  if (hourField === '*' && everyDay) {
    if (minuteField === '*') return 'Every minute';
    const step = /^(?:\*|0)\/(\d+)$/.exec(minuteField);
    if (step) {
      const n = Number(step[1]);
      if (n >= 1 && n < 60) return n === 1 ? 'Every minute' : `Every ${n} minutes`;
      return null;
    }
    const minute = numberIn(minuteField, 0, 59);
    if (minute === null) return null;
    return minute === 0 ? 'Every hour' : `Every hour at :${pad(minute)}`;
  }
  const minute = numberIn(minuteField, 0, 59);
  if (minute === null) return null;
  const hourStep = /^(?:\*|0)\/(\d+)$/.exec(hourField);
  if (hourStep && everyDay) {
    const n = Number(hourStep[1]);
    if (n < 1 || n >= 24) return null;
    const at = minute === 0 ? '' : ` at :${pad(minute)}`;
    return n === 1 ? `Every hour${at}` : `Every ${n} hours${at}`;
  }
  const hours = listIn(hourField, 0, 23);
  if (!hours || hours.length > 6) return null;
  const times = joinWords(hours.map((hour) => formatTimeOfDay(hour, minute, locale)));

  if (domField === '*' && monthField === '*') {
    if (dowField === '*' || dowField === '?') return `Every day at ${times}`;
    const days = daysOf(dowField);
    if (!days) return null;
    return `Every ${daysPhrase(days)} at ${times}`;
  }
  if (dowField !== '*' && dowField !== '?') return null;
  const dates = listIn(domField, 1, 31);
  if (!dates || dates.length > 4) return null;
  if (monthField === '*')
    return `On the ${joinWords(dates.map(ordinal))} of every month at ${times}`;
  const months = listIn(monthField, 1, 12, MONTH_ALIASES);
  if (months?.length !== 1 || dates.length !== 1) return null;
  return `Every year on ${formatMonthDay(months[0]!, dates[0]!, locale)} at ${times}`;
}

// ── Time zones and wall clocks ───────────────────────────────────────────────────────────────

/** This browser's time zone (IANA), the form's default. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Every IANA zone this browser knows, with `include` (the current choice) among them. */
export function timeZones(include?: string): string[] {
  let zones: string[] = [];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    zones = intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  const all = new Set([...zones, 'UTC', browserTimeZone(), ...(include ? [include] : [])]);
  return [...all].sort((a, b) => a.localeCompare(b));
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();
/**
 * The date and time an instant is on the clocks of `timeZone`, as numbers to
 * compute with (never shown: lib/dates.ts writes dates and times for people).
 */
export function wallClockOf(ms: number, timeZone: string): WallClock {
  let format = clockFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
      hourCycle: 'h23',
    });
    clockFormats.set(timeZone, format);
  }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: DAY_SHORT.indexOf(parts.weekday ?? 'Sun'),
  };
}

/** The instant a date ("YYYY-MM-DD") and time ("HH:MM") name in `timeZone`; NaN when invalid. */
export function zonedTimeToMs(date: string, time: string, timeZone: string): number {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return Number.NaN;
  const wanted = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  // The zone's offset at a guess, then again at the corrected guess (around a DST change).
  const offsetAt = (ms: number) => {
    const clock = wallClockOf(ms, timeZone);
    return (
      Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute) -
      Math.floor(ms / 60_000) * 60_000
    );
  };
  let guess = wanted - offsetAt(wanted);
  guess = wanted - offsetAt(guess);
  return guess;
}

const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
/** "in 5 minutes", "tomorrow", "3 hours ago". */
export function relativeTime(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff > 0 ? 'in under a minute' : 'just now';
  const minutes = Math.round(diff / 60_000);
  if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, 'minute');
  const hours = Math.round(diff / 3_600_000);
  if (Math.abs(hours) < 24) return relativeFormat.format(hours, 'hour');
  const days = Math.round(diff / 86_400_000);
  if (Math.abs(days) < 45) return relativeFormat.format(days, 'day');
  return relativeFormat.format(Math.round(days / 30), 'month');
}

/**
 * When a schedule fires, in words: "Once, Oct 21, 9:00 AM" (on this
 * computer's clock), or "Every weekday at 9:00 AM (America/New_York)" (the
 * expression itself when it isn't a common pattern).
 */
export function whenLabel(
  schedule: Pick<Schedule, 'once' | 'at' | 'cron' | 'timezone'>,
  {
    timeZone = browserTimeZone(),
    now = Date.now(),
    locale,
  }: { timeZone?: string; now?: number; locale?: string } = {},
): string {
  if (schedule.once || (schedule.at !== null && !schedule.cron)) {
    return schedule.at === null
      ? 'Once'
      : `Once, ${formatDayTime(schedule.at, { timeZone, now, locale })}`;
  }
  const cron = schedule.cron ?? '';
  return `${describeCron(cron, locale) ?? cron} (${schedule.timezone})`;
}

// ── The "when" form ──────────────────────────────────────────────────────────────────────────

export type RepeatPreset = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'custom';

/** The form's "When": once at a date and time, or repeating (a preset or a cron expression). */
export interface WhenForm {
  kind: 'once' | 'repeats';
  /** YYYY-MM-DD (once). */
  date: string;
  /** HH:MM: once, and the daily, weekday and weekly presets. */
  time: string;
  preset: RepeatPreset;
  /** 0 (Sunday) – 6: the weekly preset. */
  weekday: number;
  /** 0–59: the hourly preset's minute. */
  minute: number;
  /** The custom preset's expression. */
  cron: string;
  timezone: string;
}

/** What the API takes for "when": exactly one of `at` (no offset: in `timezone`) and `cron`. */
export type WhenInput = { at: string; timezone: string } | { cron: string; timezone: string };

/** A new schedule's "when": once, tomorrow at 09:00, in this browser's zone. */
export function defaultWhenForm(now = Date.now(), timeZone = browserTimeZone()): WhenForm {
  const tomorrow = wallClockOf(now + 86_400_000, timeZone);
  return {
    kind: 'once',
    date: `${tomorrow.year}-${pad(tomorrow.month)}-${pad(tomorrow.day)}`,
    time: '09:00',
    preset: 'weekdays',
    weekday: 1,
    minute: 0,
    cron: '',
    timezone: timeZone,
  };
}

/** The cron expression a repeating form means (the custom one as typed, trimmed). */
export function presetCron(form: WhenForm): string {
  const [hour, minute] = form.time.split(':').map(Number) as [number, number];
  switch (form.preset) {
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekly':
      return `${minute} ${hour} * * ${form.weekday}`;
    case 'hourly':
      return `${form.minute} * * * *`;
    case 'custom':
      return form.cron.trim().replace(/\s+/g, ' ');
  }
}

/** Why the form can't be sent yet, or null. The backend checks the rest (and says so). */
export function whenProblem(form: WhenForm): string | null {
  if (!form.timezone) return 'Choose a time zone.';
  if (form.kind === 'once') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return 'Choose a date.';
    if (!/^\d{2}:\d{2}$/.test(form.time)) return 'Choose a time.';
    return null;
  }
  if (form.preset === 'custom') {
    if (!form.cron.trim()) return 'Write a cron expression, like 0 9 * * 1-5.';
    return null;
  }
  if (form.preset === 'hourly')
    return Number.isInteger(form.minute) && form.minute >= 0 && form.minute <= 59
      ? null
      : 'Choose a minute from 0 to 59.';
  if (!/^\d{2}:\d{2}$/.test(form.time)) return 'Choose a time.';
  return null;
}

/** The form as the API's `{at | cron, timezone}`. */
export function whenToInput(form: WhenForm): WhenInput {
  if (form.kind === 'once') return { at: `${form.date}T${form.time}`, timezone: form.timezone };
  return { cron: presetCron(form), timezone: form.timezone };
}

/** A repeating expression as the preset that writes it, when one does. */
function presetOf(cron: string): Partial<WhenForm> & { preset: RepeatPreset } {
  const fields = cron.trim().split(/\s+/);
  if (fields.length === 5) {
    const [m, h, dom, month, dow] = fields as [string, string, string, string, string];
    const minute = numberIn(m, 0, 59);
    const hour = numberIn(h, 0, 23);
    if (minute !== null && dom === '*' && month === '*') {
      if (h === '*' && dow === '*') return { preset: 'hourly', minute };
      if (hour !== null) {
        const time = `${pad(hour)}:${pad(minute)}`;
        if (dow === '*') return { preset: 'daily', time };
        if (dow === '1-5') return { preset: 'weekdays', time };
        const day = numberIn(dow, 0, 7);
        if (day !== null) return { preset: 'weekly', time, weekday: day % 7 };
      }
    }
  }
  return { preset: 'custom', cron: cron.trim() };
}

/** A schedule's "when" as the form shows it (the other fields keep sensible defaults). */
export function whenFromSchedule(
  schedule: Pick<Schedule, 'once' | 'at' | 'cron' | 'timezone'>,
  now = Date.now(),
): WhenForm {
  const base = defaultWhenForm(now, schedule.timezone || browserTimeZone());
  if (schedule.cron) {
    // A repeating schedule keeps the form's custom expression for a preset it doesn't match.
    return { ...base, kind: 'repeats', ...presetOf(schedule.cron) };
  }
  if (schedule.at !== null) {
    const clock = wallClockOf(schedule.at, base.timezone);
    return {
      ...base,
      kind: 'once',
      date: `${clock.year}-${pad(clock.month)}-${pad(clock.day)}`,
      time: `${pad(clock.hour)}:${pad(clock.minute)}`,
    };
  }
  return base;
}

// ── The whole form ───────────────────────────────────────────────────────────────────────────

export interface ScheduleForm {
  agentId: string;
  name: string;
  message: string;
  when: WhenForm;
  threadMode: 'new' | 'this';
  threadId: string;
  missedPolicy: 'run_once' | 'skip';
}

export function scheduleFormOf(
  schedule: Schedule | null,
  agentId: string,
  now = Date.now(),
): ScheduleForm {
  if (!schedule)
    return {
      agentId,
      name: '',
      message: '',
      when: defaultWhenForm(now),
      threadMode: 'new',
      threadId: '',
      missedPolicy: 'run_once',
    };
  return {
    agentId: schedule.agentId,
    name: schedule.name,
    message: schedule.message,
    when: whenFromSchedule(schedule, now),
    threadMode: schedule.threadMode,
    threadId: schedule.threadId ?? '',
    missedPolicy: schedule.missedPolicy,
  };
}

/** Why the form can't be saved yet, or null. */
export function scheduleFormProblem(form: ScheduleForm): string | null {
  if (!form.agentId) return 'Choose an agent.';
  if (!form.message.trim()) return 'Write the message it sends.';
  if (form.message.trim().length > SCHEDULE_MESSAGE_MAX)
    return `The message is at most ${SCHEDULE_MESSAGE_MAX.toLocaleString('en')} characters.`;
  if (form.threadMode === 'this' && !form.threadId) return 'Choose the conversation it runs in.';
  return whenProblem(form.when);
}

/** The request body for the form (create, or the whole of an edit: the backend keeps what is equal). */
export function scheduleInputOf(form: ScheduleForm): ScheduleInput {
  return {
    name: form.name.trim(),
    message: form.message.trim(),
    ...whenToInput(form.when),
    threadMode: form.threadMode,
    ...(form.threadMode === 'this' ? { threadId: form.threadId } : {}),
    missedPolicy: form.missedPolicy,
  };
}

/**
 * An edit as a PATCH body: only what changed. "When" is sent (as a whole)
 * only when it changed, so editing the message of a reminder that already
 * fired doesn't send its past time again ("That time has passed").
 */
export function scheduleChanges(before: ScheduleForm, after: ScheduleForm): ScheduleInput {
  const a = scheduleInputOf(before);
  const b = scheduleInputOf(after);
  const out: ScheduleInput = {};
  if (a.name !== b.name) out.name = b.name;
  if (a.message !== b.message) out.message = b.message;
  if (JSON.stringify(whenToInput(before.when)) !== JSON.stringify(whenToInput(after.when)))
    Object.assign(out, whenToInput(after.when));
  if (a.threadMode !== b.threadMode || a.threadId !== b.threadId) {
    out.threadMode = b.threadMode;
    if (b.threadId !== undefined) out.threadId = b.threadId;
  }
  if (a.missedPolicy !== b.missedPolicy) out.missedPolicy = b.missedPolicy;
  // Moved to another agent (PATCH agentId): its runs start new conversations there.
  if (before.agentId !== after.agentId) {
    out.agentId = after.agentId;
    out.threadMode = 'new';
    delete out.threadId;
  }
  return out;
}

/** What moving a schedule to another agent means for it. */
export const movedNotice = (agentName: string) =>
  `Runs will start new conversations with ${agentName}.`;

/** A one-time schedule that has fired: nothing left to pause or resume. */
export const isDone = (schedule: Pick<Schedule, 'once' | 'nextFireAt'>) =>
  schedule.once && schedule.nextFireAt === null;

// ── Status ───────────────────────────────────────────────────────────────────────────────────

export type ScheduleState = 'active' | 'running' | 'paused' | 'finished';

export interface ScheduleStatus {
  state: ScheduleState;
  label: string;
  /** Why (a schedule that paused itself), when there is something to say. */
  detail: string | null;
}

/** What a schedule is doing: waiting for its next time, running, paused (and why), or done. */
export function scheduleStatus(schedule: Schedule): ScheduleStatus {
  if (schedule.paused)
    return {
      state: 'paused',
      label: schedule.pausedReason ? 'Paused after failing' : 'Paused',
      detail: schedule.pausedReason,
    };
  if (schedule.lastRun?.status === 'running')
    return { state: 'running', label: 'Running now', detail: null };
  if (schedule.nextFireAt === null)
    return {
      state: 'finished',
      label: 'Done',
      detail: schedule.once ? 'A one-time reminder that has fired.' : null,
    };
  return { state: 'active', label: 'Active', detail: null };
}

const RUN_LABEL: Record<ScheduleRunStatus, string> = {
  running: 'Running',
  done: 'Finished',
  failed: 'Failed',
};
export const runStatusLabel = (status: ScheduleRunStatus) => RUN_LABEL[status] ?? status;

/** "Finished 5 minutes ago", "Failed yesterday", "Running (started 2 minutes ago)". */
export function lastRunLabel(run: ScheduleRun, now = Date.now()): string {
  // In the past, whatever a clock that ticks now and then says.
  const ago = (at: number) => relativeTime(Math.min(at, now), now);
  if (run.status === 'running') return `Running (started ${ago(run.firedAt)})`;
  return `${runStatusLabel(run.status)} ${ago(run.finishedAt ?? run.firedAt)}`;
}

export const madeByLabel = (schedule: Pick<Schedule, 'madeBy'>) =>
  schedule.madeBy === 'agent' ? 'The agent' : 'You';

/** "Next: in 5 minutes", or why there is none. */
export function nextFireLabel(schedule: Schedule, now = Date.now()): string {
  if (schedule.paused) return 'Not while paused';
  if (schedule.nextFireAt === null) return 'Not again';
  return relativeTime(schedule.nextFireAt, now);
}

// ── The cached list ──────────────────────────────────────────────────────────────────────────

/** Next to fire first (as the API lists them); those with no next time last, newest first. */
export function sortSchedules(list: Schedule[]): Schedule[] {
  return list.slice().sort((a, b) => {
    const an = a.paused ? null : a.nextFireAt;
    const bn = b.paused ? null : b.nextFireAt;
    if (an !== null && bn !== null && an !== bn) return an - bn;
    if (an === null && bn !== null) return 1;
    if (an !== null && bn === null) return -1;
    return b.createdAt - a.createdAt;
  });
}

/** The list with one schedule changed or added (in its place), or removed when `schedule` is null. */
export function applyScheduleEvent(
  list: Schedule[] | undefined,
  scheduleId: string,
  schedule: Schedule | null | undefined,
): Schedule[] | undefined {
  if (!list) return list;
  const rest = list.filter((candidate) => candidate.id !== scheduleId);
  return schedule ? sortSchedules([...rest, schedule]) : rest;
}

/** A run that ended: its schedule's last run (unless a later run is already known). */
export function applyScheduleRun(
  list: Schedule[] | undefined,
  event: Pick<ScheduleRunEvent, 'scheduleId' | 'run'>,
): Schedule[] | undefined {
  if (!list) return list;
  let changed = false;
  const next = list.map((schedule) => {
    if (schedule.id !== event.scheduleId) return schedule;
    const last = schedule.lastRun;
    if (last && last.id !== event.run.id && last.firedAt > event.run.firedAt) return schedule;
    changed = true;
    return {
      ...schedule,
      lastRun: event.run,
      lastFireAt: Math.max(schedule.lastFireAt ?? 0, event.run.firedAt),
    };
  });
  return changed ? next : list;
}

/** A schedule's run history with one run changed or added at the top. */
export function applyRunToHistory(
  runs: ScheduleRun[] | undefined,
  run: ScheduleRun,
): ScheduleRun[] | undefined {
  if (!runs) return runs;
  const index = runs.findIndex((candidate) => candidate.id === run.id);
  if (index < 0) return [run, ...runs];
  const next = runs.slice();
  next[index] = run;
  return next;
}

/** A conversation a schedule started: its ID says so (`sched-…`). */
export const isScheduledThreadId = (threadId: string) => threadId.startsWith('sched-');

/**
 * The one place dates and times become text. Times follow the person's locale
 * (`Intl` with the default locale, so 12 h or 24 h comes from the system:
 * "2:03 PM" or "14:03"); days are short dates: "Oct 21", with the year only
 * when it isn't this year's ("Oct 21, 2025"). Nothing here fixes `hour12` or a
 * "HH:mm" pattern. Pure.
 *
 * `locale` is for tests; the app never passes it.
 */

export type Moment = number | Date | string;

export interface DateOptions {
  /** The moment "today" and "this year" are measured from (Unix ms). Default: now. */
  now?: number;
  /** An IANA zone to write the moment in. Default: this computer's. */
  timeZone?: string;
  locale?: string;
}

const dateOf = (when: Moment): Date => (when instanceof Date ? when : new Date(when));

const formats = new Map<string, Intl.DateTimeFormat>();
function format(locale: string | undefined, options: Intl.DateTimeFormatOptions) {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let found = formats.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(locale, options);
    formats.set(key, found);
  }
  return found;
}

const TIME = { hour: 'numeric', minute: '2-digit' } as const;
const DAY = { month: 'short', day: 'numeric' } as const;

/** The calendar year of a moment, in a zone: what "this year" means. */
function yearOf(date: Date, timeZone: string | undefined): number {
  return Number(format('en-US', { year: 'numeric', timeZone }).format(date));
}

/** The date's year when it isn't the current one, as a format option. */
function yearIfOther(date: Date, { now = Date.now(), timeZone }: DateOptions) {
  return yearOf(date, timeZone) === yearOf(new Date(now), timeZone)
    ? {}
    : ({ year: 'numeric' } as const);
}

const invalid = (date: Date, when: Moment) => (Number.isNaN(date.getTime()) ? String(when) : null);

/** The time of day: "2:03 PM", or "14:03" where the system uses 24 hours. */
export function formatTime(when: Moment, options: DateOptions = {}): string {
  const date = dateOf(when);
  return (
    invalid(date, when) ??
    format(options.locale, { ...TIME, timeZone: options.timeZone }).format(date)
  );
}

/** A day as a short date: "Oct 21" ("Oct 21, 2025" in another year). */
export function formatDay(when: Moment, options: DateOptions = {}): string {
  const date = dateOf(when);
  return (
    invalid(date, when) ??
    format(options.locale, {
      ...DAY,
      ...yearIfOther(date, options),
      timeZone: options.timeZone,
    }).format(date)
  );
}

/** A day and the time on it: "Oct 21, 2:03 PM". */
export function formatDayTime(when: Moment, options: DateOptions = {}): string {
  const date = dateOf(when);
  return (
    invalid(date, when) ??
    format(options.locale, {
      ...DAY,
      ...yearIfOther(date, options),
      ...TIME,
      timeZone: options.timeZone,
    }).format(date)
  );
}

/** When something was sent: the time today, the day and time on another day. */
export function formatClock(when: Moment, options: DateOptions = {}): string {
  const date = dateOf(when);
  const bad = invalid(date, when);
  if (bad) return bad;
  const now = new Date(options.now ?? Date.now());
  const sameDay =
    format('en-US', { dateStyle: 'short', timeZone: options.timeZone }).format(date) ===
    format('en-US', { dateStyle: 'short', timeZone: options.timeZone }).format(now);
  return sameDay ? formatTime(date, options) : formatDayTime(date, options);
}

/** The exact moment, for a tooltip: "Oct 21, 2026, 2:03:22 PM". */
export function formatExact(when: Moment, options: DateOptions = {}): string {
  const date = dateOf(when);
  return (
    invalid(date, when) ??
    format(options.locale, {
      ...DAY,
      year: 'numeric',
      ...TIME,
      second: '2-digit',
      timeZone: options.timeZone,
    }).format(date)
  );
}

/** A weekday and a time, for something a few days off: "Thu 9:00 AM". */
export function formatWeekdayTime(when: Moment, options: DateOptions = {}): string {
  const date = dateOf(when);
  return (
    invalid(date, when) ??
    format(options.locale, { weekday: 'short', ...TIME, timeZone: options.timeZone }).format(date)
  );
}

/** A time of day with no date (a schedule's hour and minute), in the system's hour style. */
export function formatTimeOfDay(hour: number, minute: number, locale?: string): string {
  // Read in UTC so no zone or daylight-saving change moves it.
  return format(locale, { ...TIME, timeZone: 'UTC' }).format(Date.UTC(2000, 0, 1, hour, minute));
}

/** A month and day with no year (a schedule's date): "Jan 1". `month` is 1–12. */
export function formatMonthDay(month: number, day: number, locale?: string): string {
  return format(locale, { ...DAY, timeZone: 'UTC' }).format(Date.UTC(2000, month - 1, day));
}

/** "2026-10-21" (a local day, as the usage report names them) as a date; null when it isn't one. */
export function dayFromKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

/** A day named "2026-10-21" as a short date: "Oct 21". Anything else is returned as it is. */
export function formatDayKey(key: string, options: DateOptions = {}): string {
  const date = dayFromKey(key);
  return date ? formatDay(date, options) : key;
}

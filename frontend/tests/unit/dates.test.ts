import { describe, expect, it } from 'vitest';
import {
  dayFromKey,
  formatClock,
  formatDay,
  formatDayKey,
  formatDayTime,
  formatExact,
  formatMonthDay,
  formatTime,
  formatTimeOfDay,
  formatWeekdayTime,
} from '../../src/lib/dates';

// 21 Oct 2026, 14:03:22 on this computer's clock; locales and zones are named so the tests don't depend on the machine.
const at = new Date(2026, 9, 21, 14, 3, 22).getTime();
const NOW = new Date(2026, 9, 21, 16, 0).getTime();

describe('time of day follows the locale', () => {
  it('is 12 h where the locale uses it, and 24 h where it does not', () => {
    expect(formatTime(at, { locale: 'en-US' })).toBe('2:03 PM');
    expect(formatTime(at, { locale: 'en-GB' })).toMatch(/^14:03$/);
    expect(formatTime(at, { locale: 'de-DE' })).toMatch(/^14:03$/);
  });

  it('never fixes the hour style: a morning hour has no forced zero in the US', () => {
    const morning = new Date(2026, 9, 21, 9, 5).getTime();
    expect(formatTime(morning, { locale: 'en-US' })).toBe('9:05 AM');
  });

  it('writes an hour and minute with no date (a schedule)', () => {
    expect(formatTimeOfDay(9, 0, 'en-US')).toBe('9:00 AM');
    expect(formatTimeOfDay(17, 30, 'en-US')).toBe('5:30 PM');
    expect(formatTimeOfDay(17, 30, 'en-GB')).toBe('17:30');
    expect(formatTimeOfDay(0, 0, 'en-US')).toBe('12:00 AM');
  });

  it('can name the zone it is written in', () => {
    const utc = Date.UTC(2026, 9, 21, 13, 0);
    expect(formatTime(utc, { locale: 'en-US', timeZone: 'America/New_York' })).toBe('9:00 AM');
    expect(formatTime(utc, { locale: 'en-US', timeZone: 'UTC' })).toBe('1:00 PM');
  });
});

describe('days are short dates', () => {
  it('is "Oct 21", with the year only in another year', () => {
    expect(formatDay(at, { locale: 'en-US', now: NOW })).toBe('Oct 21');
    expect(formatDay(new Date(2025, 11, 31), { locale: 'en-US', now: NOW })).toBe('Dec 31, 2025');
  });

  it('puts a day and a time together', () => {
    expect(formatDayTime(at, { locale: 'en-US', now: NOW })).toBe('Oct 21, 2:03 PM');
    expect(formatDayTime(at, { locale: 'en-GB', now: NOW })).toMatch(/21 Oct,? 14:03/);
    expect(formatDayTime(new Date(2025, 0, 4, 9, 30), { locale: 'en-US', now: NOW })).toBe(
      'Jan 4, 2025, 9:30 AM',
    );
  });

  it('writes a month and day without a year', () => {
    expect(formatMonthDay(12, 25, 'en-US')).toBe('Dec 25');
    expect(formatMonthDay(1, 1, 'en-US')).toBe('Jan 1');
  });

  it('names a weekday and time for something a few days off', () => {
    expect(formatWeekdayTime(at, { locale: 'en-US' })).toBe('Wed 2:03 PM');
  });

  it('is the exact moment for a tooltip', () => {
    expect(formatExact(at, { locale: 'en-US' })).toBe('Oct 21, 2026, 2:03:22 PM');
  });
});

describe('a message time', () => {
  it('is the time today, and the day with it on another day', () => {
    expect(formatClock(new Date(2026, 9, 21, 9, 5), { now: NOW, locale: 'en-US' })).toBe('9:05 AM');
    expect(formatClock(new Date(2026, 9, 20, 21, 30), { now: NOW, locale: 'en-US' })).toBe(
      'Oct 20, 9:30 PM',
    );
  });
});

describe('the usage report’s ISO days', () => {
  it('become short dates, read as local days (never shifted by the zone)', () => {
    expect(formatDayKey('2026-10-21', { locale: 'en-US', now: NOW })).toBe('Oct 21');
    expect(formatDayKey('2026-01-01', { locale: 'en-US', now: NOW })).toBe('Jan 1');
    expect(formatDayKey('2025-12-31', { locale: 'en-US', now: NOW })).toBe('Dec 31, 2025');
    expect(dayFromKey('2026-10-21')?.getDate()).toBe(21);
  });

  it('leaves anything else as it is', () => {
    expect(formatDayKey('soon')).toBe('soon');
    expect(dayFromKey('2026-10')).toBeNull();
  });
});

describe('a value that is not a date', () => {
  it('is shown as it came, never "Invalid Date"', () => {
    expect(formatDay('nope')).toBe('nope');
    expect(formatDayTime('nope')).toBe('nope');
    expect(formatTime('nope')).toBe('nope');
  });
});

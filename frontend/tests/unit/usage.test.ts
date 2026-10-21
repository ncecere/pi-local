import { describe, expect, it } from 'vitest';
import type { UsageTotals } from '../../src/api/types.ts';
import {
  barHeights,
  byUse,
  cachedOf,
  costOf,
  emptyTotals,
  fillDays,
  tokensOf,
} from '../../src/lib/usage.ts';

const totals = (change: Partial<UsageTotals>): UsageTotals => ({ ...emptyTotals(), ...change });

describe('tokensOf / cachedOf', () => {
  it('counts input, output and cache tokens', () => {
    const t = totals({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheWriteTokens: 3,
    });
    expect(tokensOf(t)).toBe(118);
    expect(cachedOf(t)).toBe(103);
  });
});

describe('costOf', () => {
  it('is a dash when every request is unpriced', () => {
    expect(costOf(totals({ requests: 4, unpricedRequests: 4 }))).toEqual({
      text: '—',
      partial: false,
    });
  });

  it('is dollars, partial when some requests are unpriced', () => {
    expect(costOf(totals({ requests: 4, costUsd: 1.234, unpricedRequests: 1 }))).toEqual({
      text: '$1.23',
      partial: true,
    });
    expect(costOf(totals({ requests: 4, costUsd: 12 }))).toEqual({
      text: '$12.00',
      partial: false,
    });
    expect(costOf(emptyTotals())).toEqual({ text: '$0.00', partial: false });
  });

  it('shows under a cent as such', () => {
    expect(costOf(totals({ requests: 1, costUsd: 0.0004 })).text).toBe('<$0.001');
    expect(costOf(totals({ requests: 1, costUsd: 0.0123 })).text).toBe('$0.012');
  });
});

describe('fillDays', () => {
  it('fills the days the report left out, in order', () => {
    const days = fillDays(
      [
        { ...totals({ requests: 2 }), day: '2026-03-03' },
        { ...totals({ requests: 1 }), day: '2026-02-28' },
      ],
      '2026-02-27',
      '2026-03-03',
    );
    expect(days.map((day) => [day.day, day.requests])).toEqual([
      ['2026-02-27', 0],
      ['2026-02-28', 1],
      ['2026-03-01', 0],
      ['2026-03-02', 0],
      ['2026-03-03', 2],
    ]);
  });

  it('keeps a full range as it is', () => {
    const full = ['2026-10-18', '2026-10-19', '2026-10-20'].map((day) => ({
      ...emptyTotals(),
      day,
    }));
    expect(fillDays(full, '2026-10-18', '2026-10-20')).toEqual(full);
  });

  it('sorts what it has when the range is unreadable', () => {
    const days = fillDays(
      [
        { ...emptyTotals(), day: 'b' },
        { ...emptyTotals(), day: 'a' },
      ],
      'x',
      'y',
    );
    expect(days.map((day) => day.day)).toEqual(['a', 'b']);
  });
});

describe('barHeights', () => {
  it('scales to the busiest', () => {
    expect(barHeights([0, 50, 100, 25])).toEqual([0, 50, 100, 25]);
    expect(barHeights([0, 0])).toEqual([0, 0]);
    expect(barHeights([])).toEqual([]);
  });
});

describe('byUse', () => {
  it('orders by tokens, then requests, then name', () => {
    const rows = [
      { ...totals({ inputTokens: 5, requests: 1 }), name: 'b' },
      { ...totals({ inputTokens: 50 }), name: 'z' },
      { ...totals({ inputTokens: 5, requests: 3 }), name: 'c' },
      { ...totals({ inputTokens: 5, requests: 1 }), name: 'a' },
    ];
    expect(byUse(rows).map((row) => row.name)).toEqual(['z', 'c', 'a', 'b']);
  });
});

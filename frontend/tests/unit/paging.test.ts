import { describe, expect, it } from 'vitest';
import { nextPage, PAGE_SIZE, visibleOf } from '../../src/lib/paging.ts';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}` }));

describe('visibleOf', () => {
  it('shows everything when it fits', () => {
    expect(visibleOf(rows(3), 5)).toHaveLength(3);
    expect(visibleOf(rows(5), 5)).toHaveLength(5);
  });

  it('shows the first page of a longer list, in order', () => {
    expect(visibleOf(rows(100), 40).map((r) => r.key)).toEqual(rows(40).map((r) => r.key));
  });

  it('keeps the open conversation, last, when it is further down', () => {
    const shown = visibleOf(rows(100), 40, 'k77');
    expect(shown).toHaveLength(41);
    expect(shown.at(-1)?.key).toBe('k77');
    expect(shown[0]?.key).toBe('k0');
  });

  it('adds nothing for one already shown, or one that is not in the list', () => {
    expect(visibleOf(rows(100), 40, 'k3')).toHaveLength(40);
    expect(visibleOf(rows(100), 40, 'gone')).toHaveLength(40);
    expect(visibleOf(rows(100), 40, null)).toHaveLength(40);
  });

  it('does not change the list it is given', () => {
    const all = rows(100);
    visibleOf(all, 10, 'k90');
    expect(all).toHaveLength(100);
  });
});

describe('nextPage', () => {
  it('is a page, or what is left', () => {
    expect(nextPage(500)).toBe(PAGE_SIZE);
    expect(nextPage(12)).toBe(12);
  });
});

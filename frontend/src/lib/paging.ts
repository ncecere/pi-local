/**
 * A long list is drawn a page at a time: a person with a few thousand conversations would otherwise get a few
 * thousand rows (and a hundred thousand elements) in the sidebar. The rest is one "Show more" away, and a search
 * looks through all of them whatever is drawn.
 */

/** Rows drawn at first, and added by each "Show more". */
export const PAGE_SIZE = 40;

/**
 * The first `limit` of `items`, plus the `keep` one (the conversation that is open) wherever it is, so the
 * open conversation never disappears from its list because it is further down.
 */
export function visibleOf<T extends { key: string }>(
  items: readonly T[],
  limit: number,
  keep?: string | null,
): T[] {
  if (items.length <= limit) return [...items];
  const first = items.slice(0, limit);
  if (!keep || first.some((item) => item.key === keep)) return first;
  const kept = items.find((item) => item.key === keep);
  return kept ? [...first, kept] : first;
}

/** How many a "Show more" adds: a page, or what is left. */
export const nextPage = (hidden: number) => Math.min(PAGE_SIZE, hidden);

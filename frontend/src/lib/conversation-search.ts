import type { SearchResult } from '~/api/types';
import { activityAt, type InboxEntry } from './inbox';

/** A conversation found by a search: by its title, or by a message in it (`hit`). */
export interface ConversationMatch {
  entry: InboxEntry;
  /** The message that matched, when the title did not. */
  hit?: SearchResult;
}

/**
 * The conversations a search finds, as the sidebar's search does: those whose
 * title holds the query (most recent activity first), then those whose
 * messages do (`GET /api/search`, in its order). Each once, and at most
 * `limit` of each kind.
 * A hit whose conversation isn't listed is left out.
 */
export function matchConversations(
  entries: readonly InboxEntry[],
  hits: readonly SearchResult[],
  query: string,
  limit = 6,
): ConversationMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const titled = entries
    .filter((entry) => entry.title.toLowerCase().includes(q))
    .sort((a, b) => activityAt(b.meta, b) - activityAt(a.meta, a));
  const seen = new Set(titled.map((entry) => entry.key));
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const inMessages: ConversationMatch[] = [];
  for (const hit of hits) {
    if (inMessages.length >= limit) break;
    const entry = byKey.get(`${hit.agentId}/${hit.threadId}`);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    inMessages.push({ entry, hit });
  }
  return [...titled.slice(0, limit).map((entry) => ({ entry })), ...inMessages];
}

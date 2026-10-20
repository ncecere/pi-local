import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type SearchResult } from '~/api/client';
import { useFeature } from '~/hooks/use-session';

/** A conversation whose messages match: `GET /api/search?q=` (docs/api.md, "Search"). */
export type MessageHit = SearchResult;

/** The API reads at most this many characters of a query. */
export const SEARCH_QUERY_MAX = 200;

/**
 * A query worth searching for: the API matches words of two letters or more
 * (each at the start of a word), so it needs at least one.
 */
export const searchable = (query: string) => /[\p{L}\p{N}]{2}/u.test(query);

/** The query as sent: trimmed, at most 200 characters. */
export const searchQueryOf = (query: string) => query.trim().slice(0, SEARCH_QUERY_MAX);

/**
 * Conversations whose text holds the query (the `messageSearch` feature), once the person has stopped typing for a
 * moment. Empty when the feature is off or the query is too short.
 */
export function useMessageSearch(query: string): {
  enabled: boolean;
  hits: MessageHit[];
  pending: boolean;
  failed: boolean;
} {
  const enabled = useFeature('messageSearch');
  const [settled, setSettled] = useState(searchQueryOf(query));
  useEffect(() => {
    const timer = setTimeout(() => setSettled(searchQueryOf(query)), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const active = enabled && searchable(settled);
  const results = useQuery({
    queryKey: ['search', settled],
    queryFn: () =>
      api.get<{ results: MessageHit[] }>(`/api/search?q=${encodeURIComponent(settled)}`),
    enabled: active,
    staleTime: 30_000,
  });
  return {
    enabled,
    hits: active && searchable(query) ? (results.data?.results ?? []) : [],
    pending: active && (results.isFetching || settled !== searchQueryOf(query)),
    failed: active && results.isError,
  };
}

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '~/api/client';
import { useFeature } from '~/hooks/use-session';

export interface MessageHit {
  agentId: string;
  threadId: string;
  /** A line around the match; the matched words sit between U+0001 and U+0002. */
  snippet: string;
  indexedAt: string;
}

/** A query worth searching for: two letters or digits at least. */
export const searchable = (query: string) => (query.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2;

/**
 * Conversations whose text holds the query (the `messageSearch` feature), once the person has stopped typing for a
 * moment. Empty when the feature is off or the query is too short.
 */
export function useMessageSearch(query: string): {
  enabled: boolean;
  hits: MessageHit[];
  pending: boolean;
} {
  const enabled = useFeature('messageSearch');
  const [settled, setSettled] = useState(query.trim());
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query.trim()), 300);
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
    pending: active && (results.isFetching || settled !== query.trim()),
  };
}

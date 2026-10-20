import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { Agent, AgentEvent, AgentThread, AgentThreadEvent } from '~/api/client';
import { transport } from '~/api/transport';
import { AGENTS_KEY, applyAgentEvent, threadsKey } from '~/hooks/use-agents';
import { useInboxActions, useInboxStore } from '~/hooks/use-inbox';
import { setEventsLive } from '~/lib/events-live';
import { threadKey } from '~/lib/inbox';

/**
 * Follows the agents and their conversations as they change, through one
 * stream for every agent (`/api/events`, docs/api.md "Live events"):
 * - `thread`: a conversation created, renamed, started, finished, deleted.
 *   It updates that agent's conversation list in place, and tells the inbox
 *   when a reply starts or ends, so rows show Working, Done and Failed
 *   without anyone polling.
 * - `agent`: an agent created, renamed, deleted, or its runtime's status
 *   (asleep, awake, error) changed. It updates the ['agents'] list in place.
 * - `resync`, or a reconnect: events may have been missed; the lists are read
 *   again.
 * Mounted once, in the app shell.
 */

type ThreadEvent = AgentThreadEvent;

/** A list with one conversation changed (or added at the top), or removed. */
export function applyThreadEvent(
  list: AgentThread[] | undefined,
  event: Pick<ThreadEvent, 'threadId' | 'deleted' | 'thread'>,
): AgentThread[] | undefined {
  if (!list) return list;
  if (event.deleted || !event.thread)
    return list.filter((thread) => thread.threadId !== event.threadId);
  const index = list.findIndex((thread) => thread.threadId === event.threadId);
  if (index < 0) return [event.thread, ...list];
  const next = list.slice();
  next[index] = event.thread;
  return next;
}

export function usePlatformEvents() {
  const queryClient = useQueryClient();
  const store = useInboxStore();
  const actions = useInboxActions();
  const latest = useRef({ store, actions });
  latest.current = { store, actions };

  useEffect(() => {
    if (!store) return;
    const source = transport.channel('/api/events');
    if (!source) return;
    let connectedBefore = false;
    const readListsAgain = () => {
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true });
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'agents' && query.queryKey[2] === 'threads',
      });
    };

    source.on('ready', () => {
      setEventsLive(true);
      // The browser reconnected on its own: what happened meanwhile was not heard.
      if (connectedBefore) readListsAgain();
      connectedBefore = true;
    });
    source.on('resync', readListsAgain);
    source.on('agent', (data) => {
      let event: AgentEvent;
      try {
        event = JSON.parse(data) as AgentEvent;
      } catch {
        return;
      }
      // A list never loaded, or a change that does not say what the agent is now: read it again.
      if (queryClient.getQueryData(AGENTS_KEY) === undefined || (!event.deleted && !event.agent)) {
        void queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true });
        return;
      }
      queryClient.setQueryData<Agent[]>(AGENTS_KEY, (list) =>
        applyAgentEvent(list, event.agentId, event.deleted ? null : event.agent),
      );
      if (event.deleted) queryClient.removeQueries({ queryKey: threadsKey(event.agentId) });
    });
    source.on('thread', (data) => {
      let event: ThreadEvent;
      try {
        event = JSON.parse(data) as ThreadEvent;
      } catch {
        return;
      }
      const key = threadsKey(event.agentId);
      if (queryClient.getQueryData(key) === undefined)
        void queryClient.invalidateQueries({ queryKey: key });
      else queryClient.setQueryData<AgentThread[]>(key, (list) => applyThreadEvent(list, event));

      // The inbox hears a reply start and end with this browser's clock, as if it had watched.
      const { store, actions } = latest.current;
      const inboxKey = threadKey(event.agentId, event.threadId);
      const meta = store?.get(inboxKey);
      if (event.deleted || !event.thread) return;
      if (event.thread.busy) {
        if (meta?.workingSince === undefined) actions.working(inboxKey);
      } else if (meta?.workingSince !== undefined) {
        actions.finished(inboxKey, Boolean(event.thread.lastError));
      }
    });
    source.onError(() => setEventsLive(false));
    return () => {
      source.close();
      setEventsLive(false);
    };
  }, [store, queryClient]);
}

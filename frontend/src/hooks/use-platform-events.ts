import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type {
  Agent,
  AgentEvent,
  AgentThread,
  AgentThreadEvent,
  Approval,
  ApprovalEvent,
  McpEvent,
  McpServer,
  Schedule,
  ScheduleEvent,
  ScheduleRun,
  ScheduleRunEvent,
  Team,
  TeamEvent,
} from '~/api/client';
import { transport } from '~/api/transport';
import { AGENTS_KEY, applyAgentEvent, threadsKey } from '~/hooks/use-agents';
import { APPROVALS_KEY } from '~/hooks/use-approvals';
import { useInboxActions, useInboxStore } from '~/hooks/use-inbox';
import { MCP_SERVERS_KEY } from '~/hooks/use-mcp';
import { SCHEDULES_KEY, scheduleRunsKey } from '~/hooks/use-schedules';
import { TEAMS_KEY } from '~/hooks/use-teams';
import { applyApprovalEvent } from '~/lib/approvals';
import { setEventsLive } from '~/lib/events-live';
import { threadKey } from '~/lib/inbox';
import { applyMcpEvent } from '~/lib/mcp';
import { applyRunToHistory, applyScheduleEvent, applyScheduleRun } from '~/lib/schedules';
import { applyTeamEvent } from '~/lib/teams';

/**
 * Follows the agents and their conversations as they change, through one
 * stream for every agent (`/api/events`, docs/api.md "Live events"):
 * - `thread`: a conversation created, renamed, started, finished, deleted.
 *   It updates that agent's conversation list in place, and tells the inbox
 *   when a reply starts or ends, so rows show Working, Done and Failed
 *   without anyone polling.
 * - `agent`: an agent created, renamed, deleted, or its runtime's status
 *   (asleep, awake, error) changed. It updates the ['agents'] list in place.
 * - `team`: a team created, changed or deleted. It updates ['teams'] in place.
 * - `approval`: a tool call asks for approval, or its request was decided,
 *   timed out or cancelled. It updates the pending list (['approvals']) in place,
 *   so the sidebar's "Needs you" and the title's count follow at once.
 * - `mcp`: an MCP server added, changed, tested, signed in or out, or deleted.
 *   It updates the catalog (['mcp', 'servers']) in place: an OAuth sign-in's
 *   outcome arrives this way.
 * - `schedule`: a schedule made, changed (paused, its next time) or deleted.
 *   It updates ['schedules'] in place.
 * - `schedule_run`: a scheduled run ended. Its schedule's last run (and its
 *   history, when open) change, and a quiet toast links to its conversation.
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
  const navigate = useNavigate();
  const latest = useRef({ store, actions, navigate });
  latest.current = { store, actions, navigate };

  useEffect(() => {
    if (!store) return;
    const source = transport.channel('/api/events');
    if (!source) return;
    let connectedBefore = false;
    const readListsAgain = () => {
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true });
      void queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
      void queryClient.invalidateQueries({ queryKey: APPROVALS_KEY });
      void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_KEY });
      void queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY });
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
    source.on('team', (data) => {
      let event: TeamEvent;
      try {
        event = JSON.parse(data) as TeamEvent;
      } catch {
        return;
      }
      if (queryClient.getQueryData(TEAMS_KEY) === undefined || (!event.deleted && !event.team)) {
        void queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
        return;
      }
      queryClient.setQueryData<Team[]>(TEAMS_KEY, (list) =>
        applyTeamEvent(list, event.teamId, event.deleted ? null : event.team),
      );
    });
    source.on('approval', (data) => {
      let event: ApprovalEvent;
      try {
        event = JSON.parse(data) as ApprovalEvent;
      } catch {
        return;
      }
      if (!event.approval || queryClient.getQueryData(APPROVALS_KEY) === undefined) {
        void queryClient.invalidateQueries({ queryKey: APPROVALS_KEY });
        return;
      }
      const approval: Approval = {
        ...event.approval,
        agentId: event.approval.agentId ?? event.agentId,
      };
      queryClient.setQueryData<Approval[]>(APPROVALS_KEY, (list) =>
        applyApprovalEvent(list, approval),
      );
    });
    source.on('mcp', (data) => {
      let event: McpEvent;
      try {
        event = JSON.parse(data) as McpEvent;
      } catch {
        return;
      }
      if (
        queryClient.getQueryData(MCP_SERVERS_KEY) === undefined ||
        (!event.deleted && !event.server)
      ) {
        void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_KEY });
        return;
      }
      queryClient.setQueryData<McpServer[]>(MCP_SERVERS_KEY, (list) =>
        applyMcpEvent(list, event.slug, event.deleted ? null : event.server),
      );
    });
    source.on('schedule', (data) => {
      let event: ScheduleEvent;
      try {
        event = JSON.parse(data) as ScheduleEvent;
      } catch {
        return;
      }
      if (
        queryClient.getQueryData(SCHEDULES_KEY) === undefined ||
        (!event.deleted && !event.schedule)
      ) {
        void queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY });
        return;
      }
      queryClient.setQueryData<Schedule[]>(SCHEDULES_KEY, (list) =>
        applyScheduleEvent(list, event.scheduleId, event.deleted ? null : event.schedule),
      );
    });
    source.on('schedule_run', (data) => {
      let event: ScheduleRunEvent;
      try {
        event = JSON.parse(data) as ScheduleRunEvent;
      } catch {
        return;
      }
      if (!event.run) return;
      if (queryClient.getQueryData(SCHEDULES_KEY) === undefined)
        void queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY });
      else
        queryClient.setQueryData<Schedule[]>(SCHEDULES_KEY, (list) =>
          applyScheduleRun(list, event),
        );
      queryClient.setQueryData<ScheduleRun[]>(scheduleRunsKey(event.scheduleId), (runs) =>
        applyRunToHistory(runs, event.run),
      );
      // Quietly: not while that conversation is on screen.
      const path = `/agents/${encodeURIComponent(event.agentId)}/threads/${encodeURIComponent(event.run.threadId)}`;
      if (window.location.pathname === path) return;
      const failed = event.run.status === 'failed';
      toast(`Scheduled run ${failed ? 'failed' : 'finished'}: ${event.name}`, {
        duration: 5000,
        ...(failed && event.run.error ? { description: event.run.error } : {}),
        action: {
          label: 'Open',
          onClick: () =>
            void latest.current.navigate({
              to: '/agents/$agentId/threads/$threadId',
              params: { agentId: event.agentId, threadId: event.run.threadId },
            }),
        },
      });
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

import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  type Agent,
  type AgentThread,
  ApiError,
  agentPath,
  api,
  type ChatView,
  threadPath,
} from '~/api/client';
import { chattable, threadsKey, useAgents } from '~/hooks/use-agents';
import { useCurrentUser } from '~/hooks/use-session';
import { isEventsLive } from '~/lib/events-live';
import {
  bucketOf,
  change,
  DROPPED_AFTER_MS,
  type InboxEntry,
  isSnoozed,
  isWorking,
  needsAttention,
  nextWake,
  replyDropped,
  replyFinished,
  type Sections,
  sectionsOf,
  statusOf,
  type ThreadMeta,
  threadKey,
  withPlatform,
} from '~/lib/inbox';
import {
  type InboxStore,
  inboxStoreFor,
  readThreadCache,
  writeThreadCache,
} from '~/lib/inbox-store';

const EMPTY: Record<string, ThreadMeta> = {};
const NO_STORE_SUBSCRIBE = () => () => undefined;
const NO_METAS = () => EMPTY;

/** The signed-in person's inbox store; undefined while signed out. */
export function useInboxStore(): InboxStore | undefined {
  const userId = useCurrentUser()?.user.id;
  return useMemo(() => (userId ? inboxStoreFor(userId) : undefined), [userId]);
}

/** What this browser knows about each conversation, by thread key. */
export function useInboxMetas(): Record<string, ThreadMeta> {
  const store = useInboxStore();
  return useSyncExternalStore(
    store?.subscribe ?? NO_STORE_SUBSCRIBE,
    store?.getSnapshot ?? NO_METAS,
    NO_METAS,
  );
}

/** How a visit is throttled: a conversation streaming ten times a second is not saved ten times a second. */
const VISIT_EVERY_MS = 5_000;

export interface InboxActions {
  pin(key: string): ThreadMeta | undefined;
  unpin(key: string): ThreadMeta | undefined;
  settle(key: string): ThreadMeta | undefined;
  unsettle(key: string): ThreadMeta | undefined;
  snooze(key: string, until: number): ThreadMeta | undefined;
  wake(key: string): ThreadMeta | undefined;
  archive(key: string): ThreadMeta | undefined;
  unarchive(key: string): ThreadMeta | undefined;
  markUnread(key: string): ThreadMeta | undefined;
  /** Put a conversation back as it was (Undo). */
  restore(key: string, meta: ThreadMeta | undefined): void;
  /** The conversation is open and in view. */
  visit(key: string): void;
  /** The agent is working here; after a send, `awaitingUsers` is what its transcript must hold before it is done. */
  working(key: string, awaitingUsers?: number): void;
  finished(key: string, failed: boolean): void;
  forget(key: string): void;
}

const NOOP_ACTIONS: InboxActions = {
  pin: () => undefined,
  unpin: () => undefined,
  settle: () => undefined,
  unsettle: () => undefined,
  snooze: () => undefined,
  wake: () => undefined,
  archive: () => undefined,
  unarchive: () => undefined,
  markUnread: () => undefined,
  restore: () => undefined,
  visit: () => undefined,
  working: () => undefined,
  finished: () => undefined,
  forget: () => undefined,
};

export function inboxActionsFor(store: InboxStore): InboxActions {
  const now = () => Date.now();
  return {
    pin: (key) => store.update(key, (meta) => change.pin(meta, now())),
    unpin: (key) => store.update(key, change.unpin),
    settle: (key) => store.update(key, (meta) => change.settle(meta, now())),
    unsettle: (key) => store.update(key, change.unsettle),
    snooze: (key, until) => store.update(key, (meta) => change.snooze(meta, until, now())),
    wake: (key) => store.update(key, change.wake),
    archive: (key) => store.update(key, (meta) => change.archive(meta, now())),
    unarchive: (key) => store.update(key, change.unarchive),
    markUnread: (key) => store.update(key, (meta) => change.markUnread(meta, now())),
    restore: (key, meta) => store.set(key, meta),
    visit: (key) => {
      const meta = store.get(key) ?? {};
      const at = now();
      const seen = meta.visitedAt ?? 0;
      const unseen = (meta.completedAt ?? 0) > seen || (meta.failedAt ?? 0) > seen;
      const woke = meta.snoozedUntil !== undefined && meta.snoozedUntil <= at;
      if (!unseen && !woke && meta.visitedAt !== undefined && at - seen < VISIT_EVERY_MS) return;
      store.set(key, change.visit(meta, at));
    },
    working: (key, awaitingUsers) =>
      store.update(key, (meta) => change.working(meta, now(), awaitingUsers)),
    finished: (key, failed) => store.update(key, (meta) => change.finished(meta, now(), failed)),
    forget: (key) => store.update(key, change.forgotten),
  };
}

/** The inbox's changes, for the signed-in person. Stable between renders. */
export function useInboxActions(): InboxActions {
  const store = useInboxStore();
  return useMemo(() => (store ? inboxActionsFor(store) : NOOP_ACTIONS), [store]);
}

// ── The clock ───────────────────────────────────────────────────────────────────────────────

/** The time, refreshed every minute and when the next snooze ends. */
function useNow(wakeAt: number | null): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (wakeAt === null) return;
    const delay = Math.min(wakeAt - Date.now() + 250, 2_000_000_000);
    if (delay <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [wakeAt]);
  return now;
}

// ── The rows ────────────────────────────────────────────────────────────────────────────────

/** How long an unlisted conversation's state is kept: a new one may not be listed yet. */
const PRUNE_GRACE_MS = 10 * 60_000;

export interface Inbox {
  agents: Agent[];
  sections: Sections;
  entries: InboxEntry[];
  now: number;
  loading: boolean;
  failed: boolean;
}

/** Every conversation of every agent the person can use, sorted into the inbox's sections. */
export function useInbox(): Inbox {
  const userId = useCurrentUser()?.user.id;
  const store = useInboxStore();
  const metas = useInboxMetas();
  const since = store?.since ?? 0;
  const agentsQuery = useAgents();
  const agents = useMemo(() => chattable(agentsQuery.data), [agentsQuery.data]);

  const lists = useQueries({
    queries: agents.map((agent) => ({
      queryKey: threadsKey(agent.id),
      queryFn: () => api.get<AgentThread[]>(agentPath(agent.id, '/threads')),
      // Listing reads the platform's record of threads; it no longer wakes the agent.
      staleTime: 15_000,
      placeholderData: () => (userId ? readThreadCache(userId, agent.id) : undefined),
    })),
  });

  // Remember each list for next time, and forget state of conversations that are gone.
  const signature = lists
    .map((list) => `${list.dataUpdatedAt}:${list.isPlaceholderData}`)
    .join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature stands for the lists
  useEffect(() => {
    lists.forEach((list, index) => {
      const agent = agents[index];
      if (!agent || !userId || !list.data || list.isPlaceholderData) return;
      writeThreadCache(userId, agent.id, list.data);
      store?.prune(
        agent.id,
        new Set(list.data.map((thread) => thread.threadId)),
        Date.now(),
        PRUNE_GRACE_MS,
      );
    });
  }, [signature, userId]);

  const wakeAt = useMemo(() => nextWake(Object.values(metas), Date.now()), [metas]);
  const now = useNow(wakeAt);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` stands for the lists' data
  const entries = useMemo(() => {
    const out: InboxEntry[] = [];
    lists.forEach((list, index) => {
      const agent = agents[index];
      if (!agent) return;
      for (const thread of list.data ?? []) {
        const key = threadKey(agent.id, thread.threadId);
        // What this browser knows, with what the platform says (busy, finished, failed).
        const meta = withPlatform(metas[key] ?? {}, thread, since);
        out.push({
          key,
          agentId: agent.id,
          threadId: thread.threadId,
          title: thread.title,
          updatedAt: thread.updatedAt,
          meta,
          bucket: bucketOf(meta, thread, now),
          status: statusOf(meta, now),
        });
      }
    });
    return out;
  }, [agents, metas, now, signature]);

  const sections = useMemo(() => sectionsOf(entries, now), [entries, now]);
  return {
    agents,
    sections,
    entries,
    now,
    loading:
      agentsQuery.isPending ||
      (entries.length === 0 && lists.some((list) => list.isPending && list.fetchStatus !== 'idle')),
    failed: agentsQuery.isError || (entries.length === 0 && lists.some((list) => list.isError)),
  };
}

/** How many conversations need the person: a reply finished or failed that they have not seen. */
export function useAttentionCount(): number {
  const metas = useInboxMetas();
  const now = Date.now();
  let count = 0;
  for (const meta of Object.values(metas)) {
    if (meta.archivedAt !== undefined || isSnoozed(meta, now)) continue;
    if (meta.settledAt !== undefined && (meta.completedAt ?? 0) <= meta.settledAt) continue;
    if (needsAttention(meta, now)) count++;
  }
  return count;
}

// ── Following replies that are still being written ──────────────────────────────────────────

const POLL_VISIBLE_MS = 5_000;
const POLL_HIDDEN_MS = 20_000;

/**
 * A conversation's stream only runs while it is open, so a reply still being
 * written when the person moves on would never be seen to finish. This checks
 * those conversations (and only those) for the end of the work, and records
 * it, so the sidebar can say "New reply". Mounted once, in the app shell.
 */
/** Whether the platform's list says this conversation is busy (the event stream keeps it current). */
function platformBusy(queryClient: ReturnType<typeof useQueryClient>, key: string): boolean {
  const [agentId, threadId] = key.split('/');
  if (!agentId) return false;
  return Boolean(
    queryClient
      .getQueryData<AgentThread[]>(threadsKey(agentId))
      ?.find((thread) => thread.threadId === threadId)?.busy,
  );
}

export function useInboxTracker() {
  const queryClient = useQueryClient();
  const store = useInboxStore();
  const actions = useInboxActions();
  const open = useParams({ strict: false }) as { agentId?: string; threadId?: string };
  const openKey = open.agentId && open.threadId ? threadKey(open.agentId, open.threadId) : null;
  const latest = useRef({ store, actions, openKey, queryClient });
  latest.current = { store, actions, openKey, queryClient };

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const check = async () => {
      const { store, actions, openKey } = latest.current;
      const metas = store?.getSnapshot() ?? EMPTY;
      const now = Date.now();
      const keys = Object.entries(metas)
        // The others are asked. The open conversation has its own stream, but is
        // asked too once it has been working a while: its turn may have been dropped.
        .filter(
          ([key, meta]) =>
            meta.workingSince !== undefined &&
            (key !== openKey || now - meta.workingSince > DROPPED_AFTER_MS),
        )
        // With the platform's event stream up, a reply the platform says is in
        // progress will be heard ending; only disagreements are asked about.
        .filter(([key]) => !isEventsLive() || !platformBusy(latest.current.queryClient, key))
        .map(([key, meta]) => [key, meta] as const);
      await Promise.all(
        keys.map(async ([key, meta]) => {
          // Lost track of it for hours: stop believing it is working.
          if (!isWorking(meta, now)) return actions.forget(key);
          const [agentId, threadId] = key.split('/');
          if (!agentId || !threadId) return actions.forget(key);
          try {
            const view = await api.get<ChatView>(threadPath(agentId, threadId));
            if (replyDropped(view, meta.workingSince, Date.now()))
              return actions.finished(key, true);
            if (key === openKey || !replyFinished(view, meta.awaitingUsers)) return;
            const last = view.messages.findLast((message) => message.role === 'assistant');
            actions.finished(key, Boolean(last?.error && last.error !== 'Interrupted'));
          } catch (error) {
            if (error instanceof ApiError && error.status === 404) actions.forget(key);
          }
        }),
      );
      if (!stopped)
        timer = setTimeout(
          check,
          document.visibilityState === 'hidden' ? POLL_HIDDEN_MS : POLL_VISIBLE_MS,
        );
    };
    timer = setTimeout(check, POLL_VISIBLE_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
}

// ── Following the person between devices ───────────────────────────────────────────────────

const PULL_EVERY_MS = 60_000;
const PUSH_AFTER_MS = 1_500;

function parseRemoteInbox(value: unknown): {
  threads: Record<string, ThreadMeta>;
  since?: number;
} {
  const doc = value as { v?: number; threads?: unknown; since?: unknown } | null;
  const threads = doc?.threads;
  return {
    threads: threads && typeof threads === 'object' ? (threads as Record<string, ThreadMeta>) : {},
    since: typeof doc?.since === 'number' ? doc.since : undefined,
  };
}

/**
 * Keeps the inbox (pinned, snoozed, done, read…) in the person's account, so
 * it follows them between devices. Pulls when the app opens, when the tab is
 * looked at again and every minute; saves shortly after each change. Each
 * conversation's later change wins. Mounted once, in the app shell.
 */
export function useInboxSync() {
  const store = useInboxStore();
  const metas = useInboxMetas();
  const pulled = useRef(false);
  const lastPushed = useRef<string | null>(null);

  useEffect(() => {
    if (!store) return;
    let stopped = false;
    const pull = async () => {
      try {
        const prefs = await api.get<Record<string, unknown>>('/api/me/prefs');
        if (stopped) return;
        const remote = parseRemoteInbox(prefs.inbox);
        const localNewer = store.merge(remote.threads, remote.since);
        // Nothing newer here: no need to send it back.
        if (!localNewer) lastPushed.current = JSON.stringify(store.exportAll());
        pulled.current = true;
      } catch {
        // Offline or signed out: the browser's copy carries on, and the next pull catches up.
      }
    };
    void pull();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void pull();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => void pull(), PULL_EVERY_MS);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [store]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `metas` is the trigger: every change is saved
  useEffect(() => {
    if (!store || !pulled.current) return;
    const body = JSON.stringify(store.exportAll());
    if (body === lastPushed.current) return;
    const timer = setTimeout(() => {
      lastPushed.current = body;
      void api
        .put('/api/me/prefs/inbox', {
          value: { v: 1, threads: JSON.parse(body), since: store.since },
        })
        .catch(() => {
          lastPushed.current = null; // try again with the next change or pull
        });
    }, PUSH_AFTER_MS);
    return () => clearTimeout(timer);
  }, [metas, store]);
}

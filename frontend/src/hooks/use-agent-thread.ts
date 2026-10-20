import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  api,
  type ChatAssistantMessage,
  type ChatMessage,
  type ChatView,
  errorMessage,
  threadPath,
} from '~/api/client';
import { transport } from '~/api/transport';
import type { AgentLive } from '~/components/agent/avatar/agent-live';
import { markThreadBusy, noteNewThread, threadsKey } from '~/hooks/use-agents';
import { useInboxActions } from '~/hooks/use-inbox';
import {
  type AgentUIMessage,
  type PendingMessage,
  pendingIdOf,
  reuseUnchanged,
  userMessagesWithText,
  viewToMessages,
} from '~/lib/chat-view';
import {
  changesMessages,
  DELTA_VERSION,
  type DeltaState,
  EMPTY_DELTA_STATE,
  followDelta,
  parseDeltaEvent,
} from '~/lib/delta';
import { replyFinished, threadKey } from '~/lib/inbox';
import { isFinal } from '~/lib/sse';
import {
  type EarlierPages,
  earlierCursorOf,
  prependPage,
  rebaseEarlier,
  TRANSCRIPT_PAGE,
  withEarlier,
} from '~/lib/transcript-pages';

/** The API's limit on one message (docs/api.md). */
export const AGENT_MESSAGE_MAX_LENGTH = 32_000;

/**
 * How this page follows the conversation. `idle` before a new conversation's
 * first message is accepted (it does not exist yet); `paused` while the tab
 * is hidden and the agent is not working (an open stream keeps the agent
 * awake, so a forgotten tab would keep it from hibernating).
 */
export type Connection =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'paused'
  | 'not-found'
  | 'failed';

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
/** How long a hidden tab keeps an idle agent's stream open. */
const HIDDEN_GRACE_MS = 60_000;

/**
 * A first message handed over by the home page (or an edit), sent once the
 * conversation opens.
 */
export interface Handover {
  agentId: string;
  threadId: string;
  text: string;
  requestId: string;
  /** The person was typing: keep the cursor in the composer. */
  focus: boolean;
  /**
   * The conversation exists already (an edited message's fork): its
   * transcript is followed at once, and the message is sent into it.
   */
  existing?: boolean;
}

const HANDOVER_KEY = 'pai.handover';

export function writeHandover(handover: Handover) {
  sessionStorage.setItem(HANDOVER_KEY, JSON.stringify(handover));
}

export function peekHandover(agentId: string, threadId: string): Handover | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(HANDOVER_KEY) ?? 'null') as Handover | null;
    return value && value.agentId === agentId && value.threadId === threadId ? value : null;
  } catch {
    return null;
  }
}

function clearHandover(threadId: string) {
  try {
    const value = JSON.parse(sessionStorage.getItem(HANDOVER_KEY) ?? 'null') as Handover | null;
    if (value?.threadId === threadId) sessionStorage.removeItem(HANDOVER_KEY);
  } catch {
    sessionStorage.removeItem(HANDOVER_KEY);
  }
}

/**
 * Matches messages sent from this tab to the transcript's. A user message in
 * the transcript carries the request ID it was sent with, so a sent message
 * is matched by that. A transcript without request IDs (a conversation from
 * before they were recorded) falls back to the text: the n-th message with a
 * text (after `baseline` of them) is the n-th one sent with it, so the same
 * words sent twice are told apart. A match is kept (`confirmed`, with the
 * transcript's id) rather than dropped: the message then keeps its identity
 * on screen, so it does not re-mount (a flash) when the transcript replaces it.
 */
export function reconcile(
  pending: PendingMessage[],
  view: ChatView | Pick<ChatView, 'messages'>,
): PendingMessage[] {
  const users = view.messages.filter((message) => message.role === 'user');
  const byRequest = new Map<string, ChatMessage>();
  const unidentified: ChatMessage[] = [];
  for (const user of users) {
    if (user.requestId) byRequest.set(user.requestId, user);
    else unidentified.push(user);
  }
  const taken = new Map<string, number>();
  let changed = false;
  const next = pending.map((message) => {
    if (message.state === 'failed') return message;
    const sent = byRequest.get(message.requestId);
    if (sent) {
      if (message.state === 'confirmed' && message.matchedId === sent.id) return message;
      changed = true;
      return { ...message, state: 'confirmed' as const, matchedId: sent.id };
    }
    // The fallback: by text, among messages that carry no request ID.
    const text = message.text.trim();
    const same = unidentified.filter((user) => (user.text ?? '').trim() === text);
    const before = taken.get(text) ?? 0;
    const match = same[message.baseline + before];
    if (!match) return message;
    taken.set(text, before + 1);
    if (message.state === 'confirmed') return message;
    changed = true;
    return { ...message, state: 'confirmed' as const, matchedId: match.id };
  });
  return changed ? next : pending;
}

/** Whether the server does not speak the delta format (an older runtime): follow whole views. */
const noDeltaFormat = (error: unknown) =>
  error instanceof ApiError &&
  error.status === 400 &&
  (error.code === 'invalid_format' || error.code === 'unsupported_version');

/** How a message is sent while the agent is busy: after the reply (the default), or into it. */
export interface SendOptions {
  /** Join the reply in progress after its current step (`whenBusy: "steer"`). */
  steer?: boolean;
}

/**
 * One conversation with an agent: its transcript as the platform streams it,
 * messages sent from this tab until the transcript has them, and stop.
 *
 * The platform is the only record. The stream (the delta format, docs/api.md
 * "Chat features") opens with a snapshot of the latest messages and then
 * sends only what changed; `applyDelta` (lib/delta.ts) keeps the view. A
 * reconnect sends the last event's id (Last-Event-ID) and gets a new snapshot,
 * so nothing is replayed; a missing event is a gap, answered the same way.
 * Earlier messages are loaded a page at a time (`loadEarlier`).
 */
export function useAgentThread({
  agentId,
  threadId,
  handover,
}: {
  agentId: string;
  threadId: string;
  /** Set for a conversation started on the home page: it exists once this is accepted. */
  handover: Handover | null;
}) {
  const queryClient = useQueryClient();
  /** The live window the stream keeps up to date. */
  const [view, setView] = useState<ChatView | null>(null);
  const viewRef = useRef<ChatView | null>(null);
  /** Pages loaded before the live window. */
  const [earlier, setEarlier] = useState<EarlierPages | null>(null);
  const earlierRef = useRef<EarlierPages | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadingEarlierRef = useRef(false);
  const [earlierError, setEarlierError] = useState<string | null>(null);
  /** What the stream has applied: its view and the last event's sequence (for Last-Event-ID). */
  const deltaRef = useRef<DeltaState>(EMPTY_DELTA_STATE);
  /** Whole `view` events, for a runtime that does not speak the delta format. */
  const legacyStream = useRef(false);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  /** After a send: how many of the person's messages the transcript must hold before a quiet agent means "done". */
  const awaitingUsers = useRef<number | null>(null);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const fresh = handover !== null && handover.existing !== true;
  const [connection, setConnection] = useState<Connection>(fresh ? 'idle' : 'connecting');
  const [connectError, setConnectError] = useState<string | null>(null);
  // The conversation exists on the platform: an existing one, or a new one
  // whose first message was accepted. The stream 404s before that.
  const [exists, setExists] = useState(!fresh);
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const [reconnectKey, setReconnectKey] = useState(0);

  /** The whole transcript shown: earlier pages, then the live window. */
  const shownView = useMemo(() => withEarlier(view, earlier), [view, earlier]);

  // ---- The stream -------------------------------------------------------
  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Hidden and idle for a while: let the agent hibernate.
  const busy = view?.busy ?? false;
  const [pausedForHidden, setPausedForHidden] = useState(false);
  useEffect(() => {
    if (!hidden) {
      setPausedForHidden(false);
      return;
    }
    if (busy) return;
    const timer = setTimeout(() => setPausedForHidden(true), HIDDEN_GRACE_MS);
    return () => clearTimeout(timer);
  }, [hidden, busy]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectKey is the trigger for Retry and Resume
  useEffect(() => {
    if (!exists) return;
    if (pausedForHidden) {
      setConnection('paused');
      return;
    }
    const abort = new AbortController();
    let attempt = 0;

    /** A view arrived: a snapshot (the window may have moved), or a change applied to the one held. */
    const receive = (next: ChatView, snapshot: boolean, messagesChanged: boolean) => {
      attempt = 0;
      if (snapshot) {
        const rebased = rebaseEarlier(earlierRef.current, viewRef.current, next);
        earlierRef.current = rebased;
        setEarlier(rebased);
      }
      viewRef.current = next;
      setView(next);
      setConnection('live');
      setConnectError(null);
      if (messagesChanged) {
        const all = withEarlier(next, earlierRef.current) ?? next;
        setPending((current) => reconcile(current, all));
      }
    };

    void (async () => {
      setConnection((current) => (current === 'live' ? 'reconnecting' : 'connecting'));
      while (!abort.signal.aborted) {
        const legacy = legacyStream.current;
        const url = threadPath(
          agentId,
          threadId,
          legacy ? '/events' : `/events?format=delta&v=${DELTA_VERSION}&limit=${TRANSCRIPT_PAGE}`,
        );
        const lastSeq = deltaRef.current.seq;
        const headers = !legacy && lastSeq > 0 ? { 'Last-Event-ID': String(lastSeq) } : undefined;
        // Its own signal, so a gap can end this connection (and only this one).
        const connectionAbort = new AbortController();
        const onAbort = () => connectionAbort.abort();
        abort.signal.addEventListener('abort', onAbort);
        let gap = false;
        try {
          await transport.stream(
            url,
            (event) => {
              if (gap) return;
              if (event.event === 'view') {
                // A whole view: what an older runtime sends (and a full snapshot).
                const next = JSON.parse(event.data) as ChatView;
                deltaRef.current = { view: next, seq: deltaRef.current.seq };
                receive(next, true, true);
                return;
              }
              const delta = parseDeltaEvent(event.data);
              if (!delta) return;
              const followed = followDelta(deltaRef.current, delta);
              if (followed.gap) {
                gap = true;
                connectionAbort.abort();
                return;
              }
              deltaRef.current = followed.state;
              if (followed.state.view)
                receive(followed.state.view, delta.type === 'snapshot', changesMessages(delta));
            },
            connectionAbort.signal,
            headers,
          );
          // The platform ended the stream (the runtime restarted, or idled
          // out): follow again straight away.
          if (abort.signal.aborted) return;
          setConnection('reconnecting');
        } catch (error) {
          if (abort.signal.aborted) return;
          if (!gap && !legacy && noDeltaFormat(error)) {
            legacyStream.current = true;
            continue;
          }
          if (!gap && isFinal(error)) {
            setConnection(error.status === 404 ? 'not-found' : 'failed');
            setConnectError(error.message);
            return;
          }
          setConnection('reconnecting');
          // A gap is mended by the next snapshot, at once the first time.
          if (gap && attempt === 0) {
            attempt++;
            continue;
          }
          if (!gap) setConnectError(errorMessage(error, 'The connection to the agent was lost.'));
        } finally {
          abort.signal.removeEventListener('abort', onAbort);
        }
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!;
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    })();
    return () => abort.abort();
  }, [agentId, threadId, exists, pausedForHidden, reconnectKey]);

  const reconnect = useCallback(() => {
    setPausedForHidden(false);
    setReconnectKey((key) => key + 1);
  }, []);

  // ---- Earlier messages -------------------------------------------------
  const earlierCursor = earlierCursorOf(earlier, view);
  /**
   * Loads the page before what is shown and puts it first. `beforeShown` is
   * called just before it is (the scroll position is read then, to keep what
   * the reader sees in place). False when nothing was added.
   */
  const loadEarlier = useCallback(
    async (beforeShown?: () => void) => {
      const cursor = earlierCursorOf(earlierRef.current, viewRef.current);
      if (!cursor || loadingEarlierRef.current) return false;
      loadingEarlierRef.current = true;
      setLoadingEarlier(true);
      setEarlierError(null);
      try {
        const page = await api.get<ChatView>(
          threadPath(
            agentId,
            threadId,
            `?limit=${TRANSCRIPT_PAGE}&before=${encodeURIComponent(cursor)}`,
          ),
        );
        // A new snapshot moved the window meanwhile: this page may not join
        // up with it (the next request asks for the right one).
        if (earlierCursorOf(earlierRef.current, viewRef.current) !== cursor) return false;
        const held = earlierRef.current?.messages.length ?? 0;
        const next = prependPage(earlierRef.current, viewRef.current, page);
        beforeShown?.();
        earlierRef.current = next;
        setEarlier(next);
        return next.messages.length > held;
      } catch (error) {
        setEarlierError(errorMessage(error, "Earlier messages couldn't be loaded."));
        return false;
      } finally {
        loadingEarlierRef.current = false;
        setLoadingEarlier(false);
      }
    },
    [agentId, threadId],
  );

  // A stop is over once the agent is no longer working.
  useEffect(() => {
    if (!busy) setStopping(false);
  }, [busy]);

  // The inbox learns when this conversation starts and stops working, and when it is looked at.
  const inbox = useInboxActions();
  const inboxRef = useRef(inbox);
  inboxRef.current = inbox;
  const inboxKey = threadKey(agentId, threadId);
  const lastViewReply = view?.messages.findLast(
    (message: ChatMessage): message is ChatAssistantMessage => message.role === 'assistant',
  );
  const replyFailed = Boolean(lastViewReply?.error && lastViewReply.error !== 'Interrupted');

  // The reply ended: its conversation moved up the list (and may be new there).
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (busy) inbox.working(inboxKey);
    if (wasBusy.current && !busy) {
      inbox.finished(inboxKey, replyFailed);
      awaitingUsers.current = null;
      void queryClient.invalidateQueries({ queryKey: threadsKey(agentId) });
    }
    wasBusy.current = busy;
  }, [busy, agentId, queryClient, inbox, inboxKey, replyFailed]);

  // A reply can finish between two views, so that busy is never seen to fall:
  // the transcript holding the message that was sent, with the agent idle, says so.
  useEffect(() => {
    if (awaitingUsers.current === null || !shownView) return;
    if (!replyFinished(shownView, awaitingUsers.current)) return;
    awaitingUsers.current = null;
    inbox.finished(inboxKey, replyFailed);
    void queryClient.invalidateQueries({ queryKey: threadsKey(agentId) });
  }, [shownView, agentId, queryClient, inbox, inboxKey, replyFailed]);

  // Open and in view: whatever was new is seen.
  const seenView = view !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `view` is the trigger: each change of an open conversation is seen
  useEffect(() => {
    if (seenView && !hidden) inbox.visit(inboxKey);
  }, [view, seenView, hidden, inbox, inboxKey]);

  // ---- Sending ----------------------------------------------------------
  const submit = useCallback(
    async (
      text: string,
      requestId: string = crypto.randomUUID(),
      /** What goes back in the message box if it fails: the text as typed, without the files' block. */
      typed: string = text,
      options: SendOptions = {},
    ) => {
      const content = text.trim();
      if (!content) return false;
      const steer = options.steer === true;
      setSendError(null);
      const shown = withEarlier(viewRef.current, earlierRef.current);
      setPending((current) =>
        current.some((message) => message.requestId === requestId)
          ? current
          : [
              ...current.filter((message) => message.state !== 'failed'),
              {
                requestId,
                text: content,
                state: 'sending',
                baseline: userMessagesWithText(shown, content),
                ...(steer ? { steer: true } : {}),
              },
            ],
      );
      try {
        await api.post(threadPath(agentId, threadId, '/messages'), {
          text: content,
          requestId,
          ...(steer ? { whenBusy: 'steer' } : {}),
        });
        setPending((current) =>
          current.map((message) =>
            message.requestId === requestId && message.state === 'sending'
              ? { ...message, state: 'queued' }
              : message,
          ),
        );
        if (!exists) {
          noteNewThread(queryClient, agentId, threadId, content);
          setExists(true);
        }
        clearHandover(threadId);
        // The agent is going to work on it, even if it has not said so yet, and
        // the inbox should follow that if the person leaves before it does.
        const users = (withEarlier(viewRef.current, earlierRef.current)?.messages ?? []).filter(
          (m) => m.role === 'user',
        ).length;
        const waiting = pendingRef.current.filter(
          (m) => m.state === 'sending' || m.state === 'queued',
        ).length;
        awaitingUsers.current = Math.max(awaitingUsers.current ?? 0, users + Math.max(waiting, 1));
        inboxRef.current.working(threadKey(agentId, threadId), awaitingUsers.current);
        markThreadBusy(queryClient, agentId, threadId);
        return true;
      } catch (error) {
        setPending((current) =>
          current.map((message) =>
            message.requestId === requestId ? { ...message, state: 'failed' } : message,
          ),
        );
        // Back into the composer, unless something new was typed meanwhile.
        setDraft((current) => (current.trim() ? current : typed.trim()));
        setSendError(
          `Your message wasn't sent, so it's back in the message box. ${errorMessage(error, '')}`.trim(),
        );
        clearHandover(threadId);
        return false;
      }
    },
    [agentId, threadId, exists, queryClient],
  );

  /**
   * Sends the draft. `compose` makes the message from it (adding the attached
   * files' block); true once the agent accepted it. `steer`: into the reply
   * in progress rather than after it.
   */
  const send = useCallback(
    async (compose?: (text: string) => string, options?: SendOptions) => {
      const typed = draft;
      const text = compose ? compose(typed) : typed;
      if (!text.trim() || text.trim().length > AGENT_MESSAGE_MAX_LENGTH) return false;
      setDraft('');
      return submit(text, undefined, typed, options);
    },
    [draft, submit],
  );

  // The home page's first message, once.
  const handedOver = useRef(false);
  useEffect(() => {
    if (!handover || handedOver.current) return;
    handedOver.current = true;
    void submit(handover.text, handover.requestId);
  }, [handover, submit]);

  const stop = useCallback(async () => {
    setStopping(true);
    try {
      await api.post(threadPath(agentId, threadId, '/stop'));
    } catch (error) {
      setStopping(false);
      setSendError(errorMessage(error, "The agent couldn't be stopped. Try again."));
    }
  }, [agentId, threadId]);

  // ---- What the page shows ----------------------------------------------
  const previous = useRef<AgentUIMessage[]>([]);
  const messages = useMemo(() => {
    const next = reuseUnchanged(previous.current, viewToMessages(shownView, pending));
    previous.current = next;
    return next;
  }, [shownView, pending]);

  /**
   * The messages after the earlier pages: what the scroll treats as the
   * conversation (a page put before it is not a question being sent).
   */
  const liveMessages = useMemo(() => {
    if (!earlier || earlier.messages.length === 0) return messages;
    const before = new Set(earlier.messages.map((message) => message.id));
    for (const message of pending)
      if (message.matchedId && before.has(message.matchedId)) before.add(pendingIdOf(message));
    return messages.filter((message) => !before.has(message.id));
  }, [messages, earlier, pending]);

  const waitingForAgent = pending.some(
    (message) => message.state === 'sending' || message.state === 'queued',
  );

  // What the agent's avatar shows: a tool running, a stream being restored, a reply that failed.
  const lastReply = messages.findLast((message) => message.role === 'assistant');
  const runningTool =
    busy &&
    Boolean(
      lastReply?.parts.some(
        (part) => part.type === 'dynamic-tool' && part.state === 'input-available',
      ),
    );
  const failed = !busy && lastReply?.metadata?.status === 'error';
  const connected = connection === 'live';
  const reconnecting = connection === 'reconnecting';
  const live = useMemo<AgentLive>(
    () => ({ connected, busy, runningTool, reconnecting, failed }),
    [connected, busy, runningTool, reconnecting, failed],
  );

  return {
    view,
    /** The whole transcript loaded: earlier pages, then the live window. */
    shownView,
    messages,
    /** `messages` without the earlier pages (see liveMessages). */
    liveMessages,
    /** The agent is working on a reply in this conversation. */
    busy,
    /** For the agent's avatar: see publishAgentLive. */
    live,
    /** Sent from this tab and not taken up by the agent yet. */
    waitingForAgent,
    pending,
    connection,
    connectError,
    reconnect,
    /**
     * Shown: the first view arrived, or a new conversation's first message is on
     * its way (never a spinner for that). An existing one waits for its transcript.
     */
    ready: view !== null || fresh,
    /** Earlier messages can be loaded. */
    hasEarlier: earlierCursor !== undefined,
    loadEarlier,
    loadingEarlier,
    earlierError,
    /** The documents the agent exposes for this conversation, by kind, with their revisions. */
    documents: view?.documents,
    draft,
    setDraft,
    send,
    sendError,
    clearSendError: () => setSendError(null),
    stop,
    stopping,
  };
}

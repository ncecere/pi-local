import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, Clock, CornerUpLeft, LoaderCircle, Sparkles } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, type McpElicitation } from '~/api/client';
import { AgentPicker } from '~/components/agent/agent-picker';
import { publishAgentLive } from '~/components/agent/avatar/agent-live';
import {
  AttachButton,
  AttachmentTray,
  DropOverlay,
  useFileDrop,
} from '~/components/chat/attachments';
import { Composer } from '~/components/chat/composer';
import { DocumentsPanel } from '~/components/chat/documents-panel';
import { ElicitationList } from '~/components/chat/elicitation-card';
import { preloadMarkdownRenderer, useMarkdownRendererReady } from '~/components/chat/markdown';
import { textOf } from '~/components/chat/message-content';
import { MessageList } from '~/components/chat/message-list';
import { ModelPicker } from '~/components/chat/model-picker';
import { NoReplyNote } from '~/components/chat/reply-outcome-note';
import { Button } from '~/components/ui/button';
import { FullPageSpinner } from '~/components/ui/spinner';
import { UnavailableState } from '~/components/ui/unavailable-state';
import { BudgetBanner } from '~/components/usage/budget-parts';
import {
  type Connection,
  peekHandover,
  useAgentThread,
  writeHandover,
} from '~/hooks/use-agent-thread';
import { useAgent, useAgents, useForkThread, useThreadInfo } from '~/hooks/use-agents';
import { useAttachments } from '~/hooks/use-attachments';
import { useBudgets } from '~/hooks/use-budgets';
import { type ChatScrollTarget, useChatScroll } from '~/hooks/use-chat-scroll';
import { useElicitationsByThread } from '~/hooks/use-elicitations';
import { useModelChoice } from '~/hooks/use-model-choice';
import { budgetNotice } from '~/lib/budget';
import { isPendingMessage, type ReplyMetadata } from '~/lib/chat-view';
import { usePageTitle } from '~/lib/document-title';
import {
  branchPointOf,
  clearComposerFocus,
  peekComposerFocus,
  requestComposerFocus,
  transcriptIdOf,
} from '~/lib/fork';
import { choiceOf } from '~/lib/model-choice';
import { isScheduledThreadId } from '~/lib/schedules';
import { findSnippetMessage } from '~/lib/search-find';
import { rememberAgent } from '~/routes/chat/home';

const NO_ELICITATIONS: McpElicitation[] = [];

/** How long an idle agent leaves the person's message unanswered before the page says so. */
const DROPPED_NOTICE_MS = 4_000;

export function ChatThreadPage({
  agentId,
  threadId,
  find,
}: {
  agentId: string;
  threadId: string;
  /** A message-search result's snippet: open at the message it came from. */
  find?: string;
}) {
  // Everything here belongs to one conversation: a new one starts afresh.
  return (
    <ThreadConversation
      key={`${agentId}/${threadId}`}
      agentId={agentId}
      threadId={threadId}
      find={find}
    />
  );
}

const CONNECTION_NOTE: Partial<Record<Connection, string>> = {
  connecting: 'Connecting to the agent…',
  reconnecting: 'Reconnecting to the agent…',
  paused: 'Paused while this tab was in the background.',
};

function ThreadConversation({
  agentId,
  threadId,
  find,
}: {
  agentId: string;
  threadId: string;
  find?: string;
}) {
  // Read once: a reload after the first message was accepted opens it as an existing conversation.
  const [handover] = useState(() => peekHandover(agentId, threadId));
  // A branch just made: the cursor goes to its message box.
  const [focusComposer] = useState(() => peekComposerFocus(threadId));
  useEffect(() => clearComposerFocus(threadId), [threadId]);
  const agentsQuery = useAgents();
  const agent = useAgent(agentId);
  const session = useAgentThread({ agentId, threadId, handover });
  // The agent's budget (or the app's) nearly used, over, or used up: said above the message box.
  const budgets = useBudgets();
  const budgetNote = budgetNotice(agentId, budgets.data);
  const info = useThreadInfo(agentId, threadId);
  // The model and thinking level for this conversation, chosen in the composer. A conversation
  // opened from the new chat page starts with the choice its first message carries.
  const handoverChoice = useMemo(
    () => ({
      ...(handover?.modelId !== undefined ? { modelId: handover.modelId } : {}),
      ...(handover?.thinking !== undefined ? { thinking: handover.thinking } : {}),
    }),
    [handover],
  );
  const modelChoice = useModelChoice(choiceOf(info), handoverChoice);
  const { commit: commitModelChoice } = modelChoice;
  const handoverAccepted = useRef(false);
  const accepted = session.accepted;
  useEffect(() => {
    if (!accepted || handoverAccepted.current) return;
    handoverAccepted.current = true;
    commitModelChoice(handoverChoice);
  }, [accepted, handoverChoice, commitModelChoice]);
  // MCP servers asking the person something while a tool call of this conversation waits.
  const elicitations = useElicitationsByThread().get(`${agentId}/${threadId}`);
  const title = info?.title;
  const calledBy = info?.calledBy ?? null;
  usePageTitle(title ?? (agent ? `Chat with ${agent.name}` : 'Conversation'));

  useEffect(() => rememberAgent(agentId), [agentId]);

  // Every avatar of this agent shows what this conversation says it is doing.
  const { live } = session;
  useEffect(() => publishAgentLive(agentId, live), [agentId, live]);
  useEffect(() => () => publishAgentLive(agentId, null), [agentId]);

  // The Markdown renderer loads beside the transcript, so replies do not
  // show as Markdown source and then jump.
  useEffect(() => {
    preloadMarkdownRenderer().catch(() => undefined);
  }, []);
  const rendererReady = useMarkdownRendererReady(
    session.messages.some((message) => message.role === 'assistant'),
  );
  // Once the conversation has been shown it stays: nothing later (a stream that
  // reconnects, the renderer still loading) may swap it, composer and all, back
  // for a spinner.
  const [shown, setShown] = useState(false);
  if (!shown && session.ready && rendererReady) setShown(true);

  const { messages, busy, waitingForAgent } = session;
  const working = busy || waitingForAgent;
  const liveReplyId = useMemo(() => {
    if (!busy) return null;
    // The reply being written is the last one in the transcript; queued
    // messages from this tab come after it.
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (message.role === 'assistant') return message.id;
      if (!isPendingMessage(message)) return null;
    }
    return null;
  }, [busy, messages]);

  // A search result opens at the message its snippet came from, when it is loaded.
  const target = useMemo<ChatScrollTarget | undefined>(() => {
    if (!find || !shown) return undefined;
    const messageId = findSnippetMessage(
      messages.map((message) => ({ id: message.id, text: textOf(message) })),
      find,
    );
    return messageId ? { messageId, key: find } : undefined;
  }, [find, shown, messages]);

  // Earlier pages put before the transcript are not the conversation moving on.
  const scroll = useChatScroll(session.liveMessages, working, target, true, shown);
  const { loadEarlier } = session;
  const { keepPlaceForPrepend } = scroll;
  const showEarlier = useCallback(
    () => void loadEarlier(keepPlaceForPrepend),
    [loadEarlier, keepPlaceForPrepend],
  );

  // Files attached to the next message: chosen, dropped on the conversation, or pasted.
  const attachments = useAttachments(agent);
  const drop = useFileDrop(attachments.add, attachments.enabled && Boolean(agent?.enabled));
  const sendWithFiles = (steer = false) => {
    if (attachments.busy) return;
    // Only what the person changed since the last message goes with this one.
    const { changes } = modelChoice;
    const files = attachments.ready;
    void session.send({ steer, attachments: files, ...changes }).then((sent) => {
      if (!sent) return;
      attachments.clear();
      commitModelChoice(changes);
    });
  };

  // "Send again": the question the latest reply answered.
  const { setDraft } = session;
  const lastQuestion = useMemo(
    () => messages.findLast((message) => message.role === 'user' && !isPendingMessage(message)),
    [messages],
  );
  const retry = useCallback(() => {
    if (lastQuestion) setDraft(textOf(lastQuestion));
  }, [lastQuestion, setDraft]);

  // Editing a message, and branching from a reply: both in a new conversation
  // (POST …/fork); this one stays as it is. Read through a ref so the rows keep
  // their callbacks (they are memoized).
  const navigate = useNavigate();
  const fork = useForkThread();
  const forkState = useRef({ session, fork, navigate });
  forkState.current = { session, fork, navigate };
  const backToOriginal = useCallback(
    () => ({
      label: 'Open original',
      onClick: () =>
        void forkState.current.navigate({
          to: '/agents/$agentId/threads/$threadId',
          params: { agentId, threadId },
        }),
    }),
    [agentId, threadId],
  );
  const editMessage = useCallback(
    async (messageId: string, text: string): Promise<string | null> => {
      const { session, fork, navigate } = forkState.current;
      const beforeMessageId = transcriptIdOf(messageId, session.pending);
      if (!beforeMessageId) return 'This message is still being sent. Try again in a moment.';
      // Its files go with the edited words.
      const sent = session.messages.find((message) => message.id === messageId);
      const files = (sent?.metadata as ReplyMetadata | undefined)?.attachments;
      try {
        const created = await fork.mutateAsync({ agentId, threadId, beforeMessageId });
        // The new conversation sends the edited text as soon as it opens (with a request ID).
        writeHandover({
          agentId,
          threadId: created.threadId,
          text,
          requestId: crypto.randomUUID(),
          focus: false,
          existing: true,
          ...(files?.length ? { attachments: files } : {}),
        });
        await navigate({
          to: '/agents/$agentId/threads/$threadId',
          params: { agentId, threadId: created.threadId },
        });
        toast('Edited in a new conversation. The original is kept.', {
          action: backToOriginal(),
        });
        return null;
      } catch (error) {
        return errorMessage(error, "The new conversation couldn't be made. Try again.");
      }
    },
    [agentId, threadId, backToOriginal],
  );
  const branchFrom = useCallback(
    async (replyId: string) => {
      const { session, fork, navigate } = forkState.current;
      const afterMessageId = branchPointOf(
        session.shownView?.messages ?? [],
        replyId,
        session.pending,
      );
      if (!afterMessageId) {
        toast.error("This reply can't be branched from yet.");
        return;
      }
      try {
        const created = await fork.mutateAsync({ agentId, threadId, afterMessageId });
        requestComposerFocus(created.threadId);
        await navigate({
          to: '/agents/$agentId/threads/$threadId',
          params: { agentId, threadId: created.threadId },
        });
        toast('Branched into a new conversation. The original is kept.', {
          action: backToOriginal(),
        });
      } catch (error) {
        toast.error(errorMessage(error, "The new conversation couldn't be made. Try again."));
      }
    },
    [agentId, threadId, backToOriginal],
  );

  // The agent is idle and the person spoke last: the turn was dropped. Said
  // after a moment, so a turn just starting never flashes it.
  const lastMessage = messages.at(-1);
  const unanswered =
    shown && !working && lastMessage?.role === 'user' && !isPendingMessage(lastMessage);
  const [dropped, setDropped] = useState(false);
  useEffect(() => {
    if (!unanswered) return setDropped(false);
    const timer = setTimeout(() => setDropped(true), DROPPED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [unanswered]);

  if (session.connection === 'not-found') {
    return (
      <UnavailableState
        alert
        title="Conversation unavailable"
        actions={
          <Button asChild>
            <Link to="/" search={{ agent: agentId }}>
              New chat
            </Link>
          </Button>
        }
      >
        This conversation may have been deleted, or it belongs to an agent your account can't use.
      </UnavailableState>
    );
  }
  if (session.connection === 'failed') {
    return (
      <UnavailableState
        alert
        title="Could not open the conversation"
        actions={
          <>
            <Button type="button" onClick={session.reconnect}>
              Retry
            </Button>
            <Link to="/" className="text-sm underline">
              New chat
            </Link>
          </>
        }
      >
        {session.connectError ?? 'The platform refused the request.'}
      </UnavailableState>
    );
  }
  if (!shown && (!session.ready || !rendererReady)) {
    return (
      <div role="status" aria-label="Loading conversation" className="flex h-full flex-col">
        <FullPageSpinner />
        <p className="pb-8 text-center text-sm text-[var(--text-muted)]">
          {agent && !agent.running ? `Waking ${agent.name}…` : 'Loading the conversation…'}
        </p>
      </div>
    );
  }

  // Started by a schedule: its first message came from a trigger.
  const firstUser = session.shownView?.messages.find((message) => message.role === 'user');
  const scheduled =
    (!session.hasEarlier && firstUser?.role === 'user' && firstUser.author?.kind === 'trigger') ||
    isScheduledThreadId(threadId);

  const note = CONNECTION_NOTE[session.connection];
  const waitingLabel =
    waitingForAgent && !busy
      ? agent && !agent.running
        ? `Waking ${agent.name}…`
        : 'Waiting for the agent…'
      : undefined;

  return (
    <>
      <h1 className="sr-only">{title ?? 'Conversation'}</h1>
      <div className="relative flex h-full">
        <div className="relative flex h-full min-w-0 flex-1 flex-col" {...drop.handlers}>
          <DropOverlay show={drop.dragging} agentName={agent?.name} />
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scroll.scrollRef}
              onScroll={scroll.onScroll}
              data-conversation-scroller
              className="relative flex-1 overflow-y-auto"
            >
              <div ref={scroll.contentRef}>
                {calledBy && (
                  <div className="mx-auto max-w-[42rem] px-4 pt-4">
                    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/40 px-3.5 py-2 text-sm text-[var(--text-secondary)]">
                      <CornerUpLeft
                        className="size-4 shrink-0 text-[var(--text-muted)]"
                        aria-hidden="true"
                      />
                      <span>
                        Asked by{' '}
                        <span className="font-medium text-[var(--text-primary)]">
                          {calledBy.name}
                        </span>
                      </span>
                      <span aria-hidden="true">—</span>
                      <Link
                        to="/agents/$agentId/threads/$threadId"
                        params={{ agentId: calledBy.agentId, threadId: calledBy.threadId }}
                        className="text-[var(--text-primary)] underline decoration-[var(--border-strong)] underline-offset-4 hover:decoration-current"
                      >
                        open their conversation
                      </Link>
                    </p>
                  </div>
                )}
                {scheduled && !calledBy && (
                  <div className="mx-auto max-w-[42rem] px-4 pt-4">
                    <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--text-muted)]">
                      <Clock className="size-3.5 shrink-0" aria-hidden="true" />
                      <span>
                        Started by a schedule
                        {firstUser?.role === 'user' && firstUser.author?.name
                          ? `: ${firstUser.author.name}`
                          : ''}
                      </span>
                      <span aria-hidden="true">·</span>
                      <Link
                        to="/settings/agents/$agentId"
                        params={{ agentId }}
                        search={{ tab: 'schedules' }}
                        className="underline decoration-[var(--border-strong)] underline-offset-4 hover:text-[var(--text-primary)] hover:decoration-current"
                      >
                        Schedules
                      </Link>
                    </p>
                  </div>
                )}
                {session.hasEarlier && (
                  <EarlierMessages
                    onLoad={showEarlier}
                    loading={session.loadingEarlier}
                    error={session.earlierError}
                    auto={scroll.detached}
                    scrollRef={scroll.scrollRef}
                  />
                )}
                <MessageList
                  messages={messages}
                  liveReplyId={liveReplyId}
                  working={working}
                  waitingLabel={waitingLabel}
                  agent={agent}
                  onRetry={retry}
                  onEdit={editMessage}
                  onBranch={branchFrom}
                  scrollRef={scroll.scrollRef}
                />
                {/* Kept mounted: an answered card stays a moment to say how it ended. */}
                <ElicitationList
                  elicitations={elicitations ?? NO_ELICITATIONS}
                  className="mx-auto w-full max-w-[46rem] px-4 pb-4 sm:pl-14"
                />
                {(session.sendError || note || dropped) && (
                  <div className="mx-auto max-w-[42rem] space-y-2 px-4 pb-4">
                    {dropped && (
                      <NoReplyNote agentName={agent?.name ?? 'The agent'} onRetry={retry} />
                    )}
                    {session.sendError && (
                      <p
                        role="alert"
                        className="rounded-xl bg-[var(--danger)]/15 px-4 py-3 text-sm text-[var(--danger-on-tint)]"
                      >
                        {session.sendError}
                      </p>
                    )}
                    {note && (
                      <p role="status" className="text-sm text-[var(--text-muted)]">
                        {note}{' '}
                        {session.connection === 'paused' && (
                          <button type="button" className="underline" onClick={session.reconnect}>
                            Resume
                          </button>
                        )}
                        {session.connection === 'reconnecting' && session.connectError && (
                          <span>({session.connectError})</span>
                        )}
                      </p>
                    )}
                  </div>
                )}
              </div>
              {/* Room below a just-sent question so it can sit at the top of the view. */}
              <div ref={scroll.spacerRef} aria-hidden="true" />
            </div>
            {scroll.detached && (
              <button
                type="button"
                onClick={scroll.jumpToLatest}
                className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-sm text-[var(--text-secondary)] shadow-sm transition-colors hover:text-[var(--text-primary)]"
              >
                <ArrowDown className="size-4" aria-hidden="true" />
                Jump to latest
              </button>
            )}
          </div>

          {budgetNote && (
            <div className="px-4 pb-2">
              <BudgetBanner notice={budgetNote} />
            </div>
          )}
          <Composer
            autoFocus={(handover?.focus ?? false) || focusComposer}
            value={session.draft}
            onChange={session.setDraft}
            onSubmit={() => sendWithFiles()}
            onSteer={() => sendWithFiles(true)}
            onStop={() => void session.stop()}
            tray={
              <>
                {/* Auto picked the agent: said by the composer (in sight) until the person sends again. */}
                {handover?.routed &&
                  agent &&
                  messages.filter((message) => message.role === 'user').length <= 1 && (
                    <p
                      className="mb-3 flex items-center gap-1.5 text-xs text-[var(--text-muted)]"
                      data-auto-routed=""
                    >
                      <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
                      Sent to {agent.name} (auto)
                    </p>
                  )}
                <AttachmentTray attachments={attachments} agent={agent} />
              </>
            }
            attach={<AttachButton onFiles={attachments.add} disabled={!agent?.enabled} />}
            onPasteFiles={agent?.enabled ? attachments.paste : undefined}
            hasExtra={attachments.ready.length > 0}
            holdSend={attachments.busy ? 'Sending waits until the files are uploaded.' : null}
            working={busy}
            stopping={session.stopping}
            disabled={agent ? !agent.enabled : false}
            placeholder={
              agent && !agent.enabled
                ? `${agent.name} is disabled.`
                : agent
                  ? `Message ${agent.name}…`
                  : undefined
            }
            options={
              <AgentPicker
                agents={agent ? [agent] : []}
                selected={agent ?? null}
                onSelect={() => undefined}
                loading={agentsQuery.isPending}
                locked
              />
            }
            model={
              <ModelPicker
                value={modelChoice.shown}
                agentModel={agent?.model}
                onModel={modelChoice.pickModel}
                onThinking={modelChoice.pickThinking}
                disabled={agent ? !agent.enabled : false}
              />
            }
          />
        </div>
        <DocumentsPanel agentId={agentId} threadId={threadId} documents={session.documents} />
      </div>
    </>
  );
}

/**
 * "Load earlier messages", above the first one shown: a click loads the page
 * before it, and so does scrolling up to it (once the reader has scrolled
 * away from the end; the conversation opens at its end). The page appears
 * above what the reader sees without moving it.
 */
function EarlierMessages({
  onLoad,
  loading,
  error,
  auto,
  scrollRef,
}: {
  onLoad: () => void;
  loading: boolean;
  error: string | null;
  /** Load on reaching it, not only on a click. */
  auto: boolean;
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const load = useRef(onLoad);
  load.current = onLoad;
  useEffect(() => {
    const node = ref.current;
    const root = scrollRef.current;
    if (!auto || loading || error || !node || !root || typeof IntersectionObserver === 'undefined')
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load.current();
      },
      { root, rootMargin: '400px 0px 0px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [auto, loading, error, scrollRef]);
  return (
    <div ref={ref} className="mx-auto flex max-w-[42rem] flex-col items-center gap-1.5 px-4 pt-4">
      <button
        type="button"
        onClick={onLoad}
        disabled={loading}
        className="flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-control)]/40 px-3 py-1.5 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-70"
      >
        {loading ? (
          <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        ) : (
          <ArrowUp className="size-4" aria-hidden="true" />
        )}
        {loading ? 'Loading earlier messages…' : 'Load earlier messages'}
      </button>
      {error && (
        <p role="alert" className="text-xs text-[var(--danger-on-tint)]">
          {error}
        </p>
      )}
    </div>
  );
}

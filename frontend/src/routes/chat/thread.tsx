import { Link } from '@tanstack/react-router';
import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgentPicker } from '~/components/agent/agent-picker';
import { publishAgentLive } from '~/components/agent/avatar/agent-live';
import { Composer } from '~/components/chat/composer';
import { preloadMarkdownRenderer, useMarkdownRendererReady } from '~/components/chat/markdown';
import { textOf } from '~/components/chat/message-content';
import { MessageList } from '~/components/chat/message-list';
import { NoReplyNote } from '~/components/chat/reply-outcome-note';
import { Button } from '~/components/ui/button';
import { FullPageSpinner } from '~/components/ui/spinner';
import { UnavailableState } from '~/components/ui/unavailable-state';
import { type Connection, peekHandover, useAgentThread } from '~/hooks/use-agent-thread';
import { useAgent, useAgents, useThreadTitle } from '~/hooks/use-agents';
import { useChatScroll } from '~/hooks/use-chat-scroll';
import { isPendingMessage } from '~/lib/chat-view';
import { usePageTitle } from '~/lib/document-title';
import { rememberAgent } from '~/routes/chat/home';

/** How long an idle agent leaves the person's message unanswered before the page says so. */
const DROPPED_NOTICE_MS = 4_000;

export function ChatThreadPage({ agentId, threadId }: { agentId: string; threadId: string }) {
  // Everything here belongs to one conversation: a new one starts afresh.
  return (
    <ThreadConversation key={`${agentId}/${threadId}`} agentId={agentId} threadId={threadId} />
  );
}

const CONNECTION_NOTE: Partial<Record<Connection, string>> = {
  connecting: 'Connecting to the agent…',
  reconnecting: 'Reconnecting to the agent…',
  paused: 'Paused while this tab was in the background.',
};

function ThreadConversation({ agentId, threadId }: { agentId: string; threadId: string }) {
  // Read once: a reload after the first message was accepted opens it as an existing conversation.
  const [handover] = useState(() => peekHandover(agentId, threadId));
  const agentsQuery = useAgents();
  const agent = useAgent(agentId);
  const session = useAgentThread({ agentId, threadId, handover });
  const title = useThreadTitle(agentId, threadId);
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

  const scroll = useChatScroll(messages, working, undefined, true, shown);

  // "Send again": the question the latest reply answered.
  const { setDraft } = session;
  const lastQuestion = useMemo(
    () => messages.findLast((message) => message.role === 'user' && !isPendingMessage(message)),
    [messages],
  );
  const retry = useCallback(() => {
    if (lastQuestion) setDraft(textOf(lastQuestion));
  }, [lastQuestion, setDraft]);

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
      <div className="flex h-full flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scroll.scrollRef}
            onScroll={scroll.onScroll}
            data-conversation-scroller
            className="relative flex-1 overflow-y-auto"
          >
            <div ref={scroll.contentRef}>
              <MessageList
                messages={messages}
                liveReplyId={liveReplyId}
                working={working}
                waitingLabel={waitingLabel}
                agent={agent}
                onRetry={retry}
                scrollRef={scroll.scrollRef}
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

        <Composer
          autoFocus={handover?.focus ?? false}
          value={session.draft}
          onChange={session.setDraft}
          onSubmit={() => void session.send()}
          onStop={() => void session.stop()}
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
        />
      </div>
    </>
  );
}

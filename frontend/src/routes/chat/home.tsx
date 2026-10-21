import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { MessageSquare, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Team } from '~/api/client';
import { AgentAvatar, agentStatusLabel } from '~/components/agent/agent-avatar';
import { AgentPicker } from '~/components/agent/agent-picker';
import {
  AttachButton,
  AttachmentTray,
  DropOverlay,
  useFileDrop,
} from '~/components/chat/attachments';
import { Composer } from '~/components/chat/composer';
import { ElicitationList } from '~/components/chat/elicitation-card';
import { Button } from '~/components/ui/button';
import { writeHandover } from '~/hooks/use-agent-thread';
import {
  chattable,
  newThreadId,
  noteNewThread,
  useAgentCatalog,
  useAgents,
  useAgentThreads,
} from '~/hooks/use-agents';
import { useAttachments } from '~/hooks/use-attachments';
import { usePendingElicitations } from '~/hooks/use-elicitations';
import { useCurrentUser } from '~/hooks/use-session';
import { useTeams } from '~/hooks/use-teams';
import { agentKindLabel } from '~/lib/agent-groups';
import { usePageTitle } from '~/lib/document-title';
import { focusComposerOnArrival } from '~/lib/focus-after-navigation';
import { greetingName } from '~/lib/greeting-name';
import { onlyDemoModel } from '~/lib/models';
import { chattableTeams } from '~/lib/teams';
import { cn } from '~/lib/utils';

const LAST_AGENT_KEY = 'pai.lastAgent';

export function rememberAgent(agentId: string) {
  localStorage.setItem(LAST_AGENT_KEY, agentId);
}

/** The agent a new chat starts with: the one asked for, the last used, or the first. */
function startingAgent(agents: Agent[], requested: string | undefined): Agent | null {
  const find = (id: string | null | undefined) =>
    id ? agents.find((agent) => agent.id === id) : undefined;
  return find(requested) ?? find(localStorage.getItem(LAST_AGENT_KEY)) ?? agents[0] ?? null;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(ms: number): string {
  const minutes = Math.round((ms - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return relative.format(Math.round(hours / 24), 'day');
}

/**
 * Landing page: choose an agent and say what to do. Sending opens the new
 * conversation at once with the message handed over; the conversation page
 * sends it, so a slow agent start shows there, not as a frozen home page.
 */
export function ChatHomePage({ agentId, teamId }: { agentId?: string; teamId?: string }) {
  const me = useCurrentUser();
  const agentsQuery = useAgents();
  const agents = useMemo(() => chattable(agentsQuery.data), [agentsQuery.data]);
  const teamsQuery = useTeams();
  const teams = useMemo(() => chattableTeams(teamsQuery.data, agents), [teamsQuery.data, agents]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  usePageTitle(null);

  const [chosenId, setChosenId] = useState<string | undefined>(agentId);
  useEffect(() => setChosenId(agentId), [agentId]);
  const [chosenTeamId, setChosenTeamId] = useState<string | undefined>(teamId);
  useEffect(() => setChosenTeamId(teamId), [teamId]);
  // A chat with a team is a chat with its lead.
  const team = teams.find((candidate) => candidate.id === chosenTeamId) ?? null;
  const agent = useMemo(
    () => startingAgent(agents, team?.leadId ?? chosenId),
    [agents, chosenId, team],
  );
  const selectAgent = useCallback(
    (next: Agent) => {
      setChosenId(next.id);
      setChosenTeamId(undefined);
      rememberAgent(next.id);
      void navigate({ to: '/', search: { agent: next.id }, replace: true });
    },
    [navigate],
  );
  const selectTeam = useCallback(
    (next: Team) => {
      setChosenId(next.leadId);
      setChosenTeamId(next.id);
      rememberAgent(next.leadId);
      void navigate({ to: '/', search: { agent: next.leadId, team: next.id }, replace: true });
    },
    [navigate],
  );
  const talkingTo = team ? team.name : agent?.name;

  const [draft, setDraft] = useState('');
  // Files for the first message, saved in the chosen agent's workspace.
  const attachments = useAttachments(agent);
  const drop = useFileDrop(attachments.add, attachments.enabled);
  const started = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => focusComposerOnArrival(), []);

  // Recent conversations with this agent. Listing wakes it, which also means
  // it is ready by the time the first message is sent.
  const threads = useAgentThreads(agent?.id, Boolean(agent));
  const recent = threads.data?.slice(0, 5) ?? [];
  // An MCP server's question for this agent that isn't part of a conversation is answered here.
  const pendingQuestions = usePendingElicitations();
  const questions = useMemo(
    () =>
      pendingQuestions.filter(
        (elicitation) => elicitation.agentId === agent?.id && !elicitation.threadId,
      ),
    [pendingQuestions, agent?.id],
  );

  const start = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || !agent || started.current) return;
      started.current = true;
      setSubmitting(true);
      const typing =
        document.activeElement instanceof HTMLTextAreaElement &&
        document.activeElement.getAttribute('aria-label') === 'Message input';
      const threadId = newThreadId();
      writeHandover({
        agentId: agent.id,
        threadId,
        text: content,
        requestId: crypto.randomUUID(),
        focus: typing,
      });
      rememberAgent(agent.id);
      noteNewThread(queryClient, agent.id, threadId, content);
      await navigate({
        to: '/agents/$agentId/threads/$threadId',
        params: { agentId: agent.id, threadId },
      });
    },
    [agent, navigate, queryClient],
  );

  const firstName = me && greetingName(me.user.name, null);
  const loading = agentsQuery.isPending;
  // First run: no agents at all, and maybe no model provider either (only the demo model).
  const noAgents = agentsQuery.isSuccess && agentsQuery.data.length === 0;
  const catalog = useAgentCatalog(noAgents);
  const demoOnly = noAgents && catalog.data !== undefined && onlyDemoModel(catalog.data.models);

  return (
    <div
      className="relative flex h-full flex-col justify-center md:justify-normal"
      {...drop.handlers}
    >
      <DropOverlay show={drop.dragging} agentName={agent?.name} />
      <div className="flex-none px-4 pb-8 md:flex-1 md:overflow-y-auto md:pt-[11vh] md:pb-0">
        <div className="mx-auto w-full max-w-[41.75rem]">
          <h1 className="flex flex-col items-center gap-3 text-center text-[1.375rem] font-bold leading-tight tracking-tight md:flex-row md:text-left md:text-[1.875rem]">
            {agent && <AgentAvatar agent={agent} size="lg" />}
            <span className={cn(!agent && !loading && 'text-[var(--text-secondary)]')}>
              {agent ? (
                <>
                  What should {talkingTo} work on
                  {firstName ? (
                    // The comma stays on the first line; on a phone the name is the second.
                    <>
                      ,
                      <span className="block md:inline md:before:content-['\00a0']">
                        {firstName}?
                      </span>
                    </>
                  ) : (
                    '?'
                  )}
                </>
              ) : loading ? (
                <span className="invisible">Loading</span>
              ) : (
                'No agents yet'
              )}
            </span>
          </h1>
          {agent && (
            <p className="mt-3 text-center text-sm text-[var(--text-muted)] md:text-left">
              {team
                ? `${team.description || 'A team'} · led by ${agent.name}`
                : agent.description || agentKindLabel(agent)}
              <span className="mx-1.5" aria-hidden="true">
                ·
              </span>
              <span>{agentStatusLabel(agent)}</span>
            </p>
          )}

          {agents.length > 1 && (
            <fieldset className="mt-7 hidden flex-wrap gap-2.5 border-0 p-0 md:flex">
              <legend className="sr-only">Agents</legend>
              {agents.slice(0, 8).map((candidate) => {
                const active = !team && candidate.id === agent?.id;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => selectAgent(candidate)}
                    className={cn(
                      'inline-flex h-[2.375rem] items-center gap-2 rounded-xl px-3.5 text-sm font-medium transition-colors',
                      active
                        ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                        : 'bg-[var(--bg-control-alt)] text-[var(--text-secondary)] hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    <AgentAvatar agent={candidate} size="sm" />
                    {candidate.name}
                  </button>
                );
              })}
            </fieldset>
          )}

          {noAgents ? (
            <div className="mt-6 flex flex-col items-center gap-3 md:items-start">
              <Button asChild variant="primary" size="lg">
                <Link to="/settings/agents" search={{ new: true }}>
                  <Plus />
                  Make an agent
                </Link>
              </Button>
              {demoOnly && (
                <p className="text-center text-sm text-[var(--text-muted)] md:text-left">
                  Add a model provider first in{' '}
                  <Link
                    to="/settings/models"
                    className="text-[var(--accent-bright)] underline-offset-4 hover:underline"
                  >
                    Settings → Models
                  </Link>
                  , or try the built-in demo model.
                </p>
              )}
            </div>
          ) : (
            <p className="mt-4 hidden text-sm md:block">
              <Link to="/settings/agents" className="text-[var(--accent-bright)] hover:underline">
                New agent
              </Link>
            </p>
          )}

          <ElicitationList elicitations={questions} className="mt-7" />

          {agent && recent.length > 0 && (
            <div className="mt-9 hidden md:block">
              <h2 className="mb-1 text-[0.6875rem] font-semibold text-[var(--accent-bright)]">
                Recent with {agent.name}
              </h2>
              {recent.map((thread, index) => (
                <Link
                  key={thread.threadId}
                  to="/agents/$agentId/threads/$threadId"
                  params={{ agentId: agent.id, threadId: thread.threadId }}
                  className={cn(
                    'flex h-[3.0625rem] w-full items-center gap-3 pr-2 text-left text-[0.9375rem] text-[var(--text-secondary)]',
                    'transition-colors hover:text-[var(--text-primary)]',
                    index < recent.length - 1 && 'border-b border-[var(--border-subtle)]/45',
                  )}
                >
                  <MessageSquare
                    className="size-4 shrink-0 text-[var(--text-muted)]"
                    aria-hidden="true"
                  />
                  <span dir="auto" className="min-w-0 flex-1 truncate">
                    {thread.title}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--text-muted)]">
                    {ago(thread.updatedAt)}
                  </span>
                </Link>
              ))}
            </div>
          )}

          {agentsQuery.isSuccess && agents.length === 0 && agentsQuery.data.length > 0 && (
            <p className="mt-8 rounded-xl bg-[var(--warning)]/10 px-4 py-3 text-sm text-[var(--warning)]">
              Your agents are all turned off.
            </p>
          )}
          {agentsQuery.isError && (
            <p
              role="alert"
              className="mt-8 rounded-xl bg-[var(--danger)]/15 px-4 py-3 text-sm text-[var(--danger-on-tint)]"
            >
              The list of agents could not be loaded. Reload to try again.
            </p>
          )}
        </div>
      </div>

      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={() => {
          if (!attachments.busy) void start(attachments.compose(draft));
        }}
        submitting={submitting}
        tray={<AttachmentTray attachments={attachments} agent={agent} />}
        attach={<AttachButton onFiles={attachments.add} disabled={!agent} />}
        onPasteFiles={agent ? attachments.add : undefined}
        hasExtra={attachments.ready.length > 0}
        holdSend={attachments.busy ? 'Sending waits until the files are uploaded.' : null}
        disabled={!agent}
        placeholder={
          agent
            ? team
              ? `Message ${team.name} (${agent.name})…`
              : `Message ${agent.name}…`
            : 'No agent to message'
        }
        options={
          <AgentPicker
            agents={agents}
            selected={agent}
            onSelect={selectAgent}
            teams={teams}
            selectedTeam={team}
            onSelectTeam={selectTeam}
            loading={loading}
          />
        }
      />
    </div>
  );
}

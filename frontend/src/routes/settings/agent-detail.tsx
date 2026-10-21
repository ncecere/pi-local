import { Link } from '@tanstack/react-router';
import { ChevronLeft, MessageSquarePlus } from 'lucide-react';
import { type KeyboardEvent, useId, useState } from 'react';
import { AgentAvatar } from '~/components/agent/agent-avatar';
import { ActivityTab } from '~/components/agent-manager/activity-tab';
import { AgentActions } from '~/components/agent-manager/agent-actions';
import { AgentStatus } from '~/components/agent-manager/agent-status';
import { CanAskTab } from '~/components/agent-manager/can-ask-tab';
import { ConfigTab } from '~/components/agent-manager/config-tab';
import { KindSettingsTab } from '~/components/agent-manager/kind-settings-tab';
import { KnowledgeTab } from '~/components/agent-manager/knowledge-tab';
import { LogsTab } from '~/components/agent-manager/logs-tab';
import { McpTab } from '~/components/agent-manager/mcp-tab';
import { MemoryTab } from '~/components/agent-manager/memory-tab';
import { OverviewTab } from '~/components/agent-manager/overview-tab';
import { SchedulesTab } from '~/components/agent-manager/schedules-tab';
import { SkillsTab } from '~/components/agent-manager/skills-tab';
import { ToolsTab } from '~/components/agent-manager/tools-tab';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useAgentCatalog, useAgents } from '~/hooks/use-agents';
import { agentKindLabel } from '~/lib/agent-groups';
import { usePageTitle } from '~/lib/document-title';
import { hasKindSettings } from '~/lib/kind-settings';
import { cn } from '~/lib/utils';

type TabId =
  | 'overview'
  | 'tools'
  | 'mcp'
  | 'skills'
  | 'kind'
  | 'memory'
  | 'knowledge'
  | 'can-ask'
  | 'schedules'
  | 'activity'
  | 'config'
  | 'logs';

const TAB_IDS: readonly string[] = [
  'overview',
  'tools',
  'mcp',
  'skills',
  'kind',
  'memory',
  'knowledge',
  'can-ask',
  'schedules',
  'activity',
  'config',
  'logs',
];

/** Settings → Agents → one agent: its details, kind settings, who it may ask, agent.yaml and logs. */
export function SettingsAgentDetailPage({
  agentId,
  initialTab,
}: {
  agentId: string;
  /** `?tab=`: the tab to open on ("tools" from the composer's attachments note). */
  initialTab?: string;
}) {
  const agents = useAgents();
  const catalog = useAgentCatalog();
  const agent = agents.data?.find((candidate) => candidate.id === agentId);
  usePageTitle(agent ? `${agent.name} · Agents · Settings` : 'Agent · Settings');
  const [tab, setTab] = useState<TabId>(() =>
    initialTab && TAB_IDS.includes(initialTab) ? (initialTab as TabId) : 'overview',
  );
  const [deleting, setDeleting] = useState(false);
  const id = useId();

  if (!agents.data || !catalog.data)
    return (
      <div className="py-12">
        <Spinner className="mx-auto" />
      </div>
    );

  if (!agent)
    return (
      <div className="flex flex-col items-start gap-4">
        <BackLink />
        <p className="text-sm text-[var(--text-muted)]">
          This agent doesn't exist any more. It may have been deleted.
        </p>
      </div>
    );

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'tools', label: 'Tools' },
    { id: 'mcp', label: 'Connections' },
    { id: 'skills', label: 'Skills' },
    ...(hasKindSettings(agent.agentKind)
      ? [{ id: 'kind' as const, label: `${agentKindLabel(agent)} settings` }]
      : []),
    { id: 'memory', label: 'Memory' },
    { id: 'knowledge', label: 'Knowledge' },
    { id: 'can-ask', label: 'Can ask' },
    { id: 'schedules', label: 'Schedules' },
    { id: 'activity', label: 'Activity' },
    { id: 'config', label: 'agent.yaml' },
    { id: 'logs', label: 'Logs' },
  ];
  const current = tabs.some((candidate) => candidate.id === tab) ? tab : 'overview';

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((candidate) => candidate.id === current);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    const target = tabs[next]!;
    setTab(target.id);
    document.getElementById(`${id}-tab-${target.id}`)?.focus();
  };

  return (
    <div className="flex flex-col gap-6">
      <BackLink />
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatar agent={agent} size={48} />
          <div className="min-w-0">
            <h2 className="truncate text-xl font-bold">{agent.name}</h2>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm text-[var(--text-muted)]">
              <span>{agentKindLabel(agent)}</span>
              {agent.model && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{agent.model.name}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <AgentStatus agent={agent} />
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" asChild>
            <Link to="/" search={{ agent: agent.id }}>
              <MessageSquarePlus />
              New chat
            </Link>
          </Button>
          <AgentActions agent={agent} deleting={deleting} setDeleting={setDeleting} />
        </div>
      </header>

      <div
        role="tablist"
        aria-label={`${agent.name} settings`}
        onKeyDown={onTabKey}
        className="flex gap-1 overflow-x-auto border-b border-[var(--border-subtle)]"
      >
        {tabs.map((candidate) => {
          const selected = candidate.id === current;
          return (
            <button
              key={candidate.id}
              id={`${id}-tab-${candidate.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${id}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(candidate.id)}
              className={cn(
                '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
                selected
                  ? 'border-[var(--accent)] font-medium text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              {candidate.label}
            </button>
          );
        })}
      </div>

      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${current}`}>
        {current === 'overview' && <OverviewTab agent={agent} catalog={catalog.data} />}
        {current === 'tools' && <ToolsTab agent={agent} />}
        {current === 'mcp' && (
          <McpTab
            agent={agent}
            onOpenTools={() => {
              setTab('tools');
              document.getElementById(`${id}-tab-tools`)?.focus();
            }}
          />
        )}
        {current === 'skills' && <SkillsTab agent={agent} />}
        {current === 'kind' && <KindSettingsTab agent={agent} />}
        {current === 'memory' && <MemoryTab agent={agent} />}
        {current === 'knowledge' && <KnowledgeTab agent={agent} />}
        {current === 'can-ask' && <CanAskTab agent={agent} agents={agents.data} />}
        {current === 'schedules' && <SchedulesTab agent={agent} />}
        {current === 'activity' && <ActivityTab agent={agent} />}
        {current === 'config' && <ConfigTab agent={agent} />}
        {current === 'logs' && <LogsTab agent={agent} />}
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/settings/agents"
      className="inline-flex w-fit items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
    >
      <ChevronLeft className="size-4" aria-hidden="true" />
      All agents
    </Link>
  );
}

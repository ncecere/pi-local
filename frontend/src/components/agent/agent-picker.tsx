import { Link } from '@tanstack/react-router';
import { Check, ChevronDown, Plus, Search, Users } from 'lucide-react';
import { memo, useMemo, useRef, useState } from 'react';
import type { Agent, Team } from '~/api/client';
import { AgentAvatar, agentStatusLabel } from '~/components/agent/agent-avatar';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { agentKindLabel } from '~/lib/agent-groups';
import { teamChatLabel } from '~/lib/teams';
import { cn } from '~/lib/utils';

/** One choice: an agent, or a team (a chat with its lead). */
type Item =
  | { key: string; kind: 'agent'; agent: Agent }
  | { key: string; kind: 'team'; team: Team; lead: Agent };

const optionId = (key: string) => `agent-option-${key.replace(':', '-')}`;

function matches(values: readonly string[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return values.some((value) => value.toLowerCase().includes(q));
}

const itemAgent = (item: Item) => (item.kind === 'agent' ? item.agent : item.lead);

/**
 * Chooses the agent a new conversation is with, or a team (a chat with its
 * lead, who may ask the members). A conversation stays with the agent it
 * started with (its memory and tools are that agent's), so in a conversation
 * this is shown read-only.
 */
export const AgentPicker = memo(function AgentPicker({
  agents,
  selected,
  onSelect,
  teams = [],
  selectedTeam = null,
  onSelectTeam,
  loading = false,
  locked = false,
}: {
  agents: Agent[];
  selected: Agent | null;
  onSelect: (agent: Agent) => void;
  /** Teams whose lead is among `agents`. */
  teams?: Team[];
  /** The chat is with this team (`selected` is its lead). */
  selectedTeam?: Team | null;
  onSelectTeam?: (team: Team) => void;
  loading?: boolean;
  /** In a conversation: shows the agent, without choosing another. */
  locked?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  // Your agents, then teams; arrow keys follow this order.
  const groups = useMemo(() => {
    const agentItems: Item[] = agents
      .filter((agent) => matches([agent.name, agent.description, agentKindLabel(agent)], query))
      .map((agent) => ({ key: `agent:${agent.id}`, kind: 'agent', agent }));
    const teamItems: Item[] = onSelectTeam
      ? teams.flatMap((team): Item[] => {
          const lead = byId.get(team.leadId);
          if (!lead || !matches([team.name, team.description, lead.name], query)) return [];
          return [{ key: `team:${team.id}`, kind: 'team', team, lead }];
        })
      : [];
    return [
      { label: 'Your agents', items: agentItems },
      { label: 'Teams', items: teamItems },
    ].filter((group) => group.items.length > 0);
  }, [agents, teams, byId, query, onSelectTeam]);
  const visible = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const selectedKey = selectedTeam
    ? `team:${selectedTeam.id}`
    : selected
      ? `agent:${selected.id}`
      : null;
  const active =
    visible.find((item) => item.key === activeKey) ??
    visible.find((item) => item.key === selectedKey) ??
    visible[0] ??
    null;

  function choose(item: Item) {
    if (item.kind === 'team') onSelectTeam?.(item.team);
    else onSelect(item.agent);
    setOpen(false);
  }

  function moveActive(step: 1 | -1) {
    if (visible.length === 0) return;
    const index = active ? visible.indexOf(active) : -1;
    const next = visible[(index + step + visible.length) % visible.length];
    if (!next) return;
    setActiveKey(next.key);
    document.getElementById(optionId(next.key))?.scrollIntoView({ block: 'nearest' });
  }

  const name = selected
    ? selectedTeam
      ? teamChatLabel(selectedTeam, selected)
      : selected.name
    : 'Choose an agent';
  const label = (
    <>
      {selected && <AgentAvatar agent={selected} size="sm" />}
      <span className="min-w-0 truncate">{name}</span>
    </>
  );

  const hasTeams = Boolean(onSelectTeam) && teams.some((team) => byId.has(team.leadId));
  if (locked || (agents.length <= 1 && selected && !hasTeams)) {
    return (
      <span
        className="inline-flex h-8 min-w-0 items-center gap-1.5 whitespace-nowrap px-2 text-[0.8125rem] font-semibold text-[var(--text-primary)]"
        title={selected ? `${name} · ${agentStatusLabel(selected)}` : undefined}
      >
        {label}
      </span>
    );
  }

  if (agents.length === 0) {
    return (
      <span className="px-2 text-[0.8125rem] text-[var(--text-muted)]">
        {loading ? 'Loading agents…' : 'No agents available'}
      </span>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setActiveKey(null);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger
        role="combobox"
        aria-haspopup="listbox"
        aria-label={`Select agent. Current: ${selected ? name : 'none'}`}
        title={selected ? name : undefined}
        className="inline-flex h-8 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[0.8125rem] font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-control-hover)]"
      >
        {label}
        <ChevronDown className="size-4 shrink-0 text-[var(--text-muted)]" />
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="top"
        collisionPadding={16}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchRef.current?.focus();
        }}
        aria-label="Choose an agent"
        className="flex max-h-[var(--radix-popover-content-available-height)] w-[min(26rem,calc(100vw-2rem))] flex-col p-0"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
          <Search className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
          <input
            ref={searchRef}
            aria-label={hasTeams ? 'Search agents and teams' : 'Search agents'}
            placeholder={hasTeams ? 'Search agents and teams...' : 'Search agents...'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls="agent-picker-listbox"
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(active.key) : undefined}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') event.stopPropagation();
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                moveActive(event.key === 'ArrowDown' ? 1 : -1);
              } else if (event.key === 'Enter' && active) {
                event.preventDefault();
                if (itemAgent(active).enabled) choose(active);
              }
            }}
            className="h-9 w-full bg-transparent text-[0.9375rem] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
        </div>
        <div
          id="agent-picker-listbox"
          role="listbox"
          aria-label="Agents"
          className="scrollbar-thin max-h-[min(24rem,calc(100vh-8rem))] overflow-y-auto p-1.5"
        >
          {visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">
              Nothing matches that search.
            </p>
          ) : (
            groups.map((group) => (
              // biome-ignore lint/a11y/useSemanticElements: a listbox's options are grouped with role="group" (WAI-ARIA), not a fieldset
              <div key={group.label} role="group" aria-label={group.label}>
                {groups.length > 1 && (
                  <p
                    aria-hidden="true"
                    className="px-2.5 pt-2 pb-1 text-xs font-medium text-[var(--text-muted)]"
                  >
                    {group.label}
                  </p>
                )}
                {group.items.map((item) => {
                  const agent = itemAgent(item);
                  const isSelected = item.key === selectedKey;
                  return (
                    <button
                      type="button"
                      tabIndex={-1}
                      key={item.key}
                      id={optionId(item.key)}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={!agent.enabled || undefined}
                      onPointerMove={() => setActiveKey(item.key)}
                      onClick={() => {
                        if (agent.enabled) choose(item);
                      }}
                      className={cn(
                        'flex w-full cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2 text-left',
                        active?.key === item.key && 'bg-[var(--bg-control-hover)]',
                        !agent.enabled && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <AgentAvatar agent={agent} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          {item.kind === 'team' && (
                            <Users
                              className="size-3.5 shrink-0 text-[var(--text-muted)]"
                              aria-hidden="true"
                            />
                          )}
                          <span className="truncate text-sm font-medium text-[var(--text-primary)]">
                            {item.kind === 'team' ? item.team.name : agent.name}
                          </span>
                        </span>
                        <span className="line-clamp-2 text-xs text-[var(--text-muted)]">
                          {item.kind === 'team'
                            ? `Chat with ${item.lead.name}${
                                item.team.memberIds.length > 0
                                  ? `, who may ask ${item.team.memberIds.length} ${
                                      item.team.memberIds.length === 1 ? 'member' : 'members'
                                    }`
                                  : ''
                              }`
                            : agent.description || agentKindLabel(agent)}
                        </span>
                      </span>
                      {isSelected && (
                        <Check className="mt-1 size-4 shrink-0 text-[var(--accent-bright)]" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="border-t border-[var(--border-subtle)] p-1.5">
          <Link
            to="/settings/agents"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]"
          >
            <Plus className="size-4" aria-hidden="true" />
            Make or manage your agents
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
});

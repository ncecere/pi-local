import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { type Agent, type AgentMcpServer, errorMessage, type McpServer } from '~/api/client';
import { Panel, SaveBar } from '~/components/agent-manager/panel';
import { McpStatusBadge } from '~/components/mcp/server-bits';
import { ErrorNotice } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useUpdateAgent } from '~/hooks/use-agents';
import { MCP_SERVERS_KEY, useMcpServers } from '~/hooks/use-mcp';
import { needsApproval } from '~/lib/approvals';
import {
  agentMcpTools,
  chooseServer,
  pickTool,
  readAgentMcp,
  sameSelection,
  selectionProblem,
  serverStatus,
  setToolMode,
  visibleTools,
} from '~/lib/mcp';
import { cn } from '~/lib/utils';

/**
 * Settings → Agents → an agent → MCP: which MCP servers from the catalog it
 * uses, and of each, all its tools or the ones picked (docs/api.md, Phase 5).
 */
export function McpTab({ agent, onOpenTools }: { agent: Agent; onOpenTools: () => void }) {
  const servers = useMcpServers();
  if (servers.isError)
    return (
      <div className="flex flex-col items-start gap-3">
        <ErrorNotice>MCP servers could not be read: {errorMessage(servers.error)}</ErrorNotice>
        <Button type="button" variant="secondary" onClick={() => void servers.refetch()}>
          <RefreshCw />
          Try again
        </Button>
      </div>
    );
  if (!servers.data)
    return (
      <div className="py-8">
        <Spinner className="mx-auto" />
      </div>
    );
  return (
    <McpForm key={agent.revision} agent={agent} servers={servers.data} onOpenTools={onOpenTools} />
  );
}

function McpForm({
  agent,
  servers,
  onOpenTools,
}: {
  agent: Agent;
  servers: McpServer[];
  onOpenTools: () => void;
}) {
  const saved = readAgentMcp(agent);
  const [selection, setSelection] = useState<AgentMcpServer[]>(saved);
  const update = useUpdateAgent();
  const queryClient = useQueryClient();
  const dirty = !sameSelection(selection, saved);
  const unknown = selection.filter(
    (choice) => !servers.some((server) => server.slug === choice.server),
  );
  const tools = agentMcpTools(selection, servers);
  const problem = selectionProblem(selection, servers);
  const patterns = agent.approvals?.tools ?? [];

  const save = () =>
    update.mutate(
      { id: agent.id, mcp: selection },
      {
        onSuccess: () => {
          toast(`${agent.name}'s MCP servers saved.`);
          // "Used by" in Settings → MCP.
          void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_KEY });
        },
      },
    );

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="MCP servers"
        description={
          <>
            Which servers from{' '}
            <Link to="/settings/mcp" className="text-[var(--accent-bright)] hover:underline">
              Settings → MCP
            </Link>{' '}
            {agent.name} uses: each with all its tools, or the ones you pick.
          </>
        }
      >
        {servers.length === 0 && unknown.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">
            There are no MCP servers yet. Add some in{' '}
            <Link to="/settings/mcp" className="text-[var(--accent-bright)] hover:underline">
              Settings → MCP
            </Link>
            .
          </p>
        ) : (
          <fieldset className="m-0 border-0 p-0">
            <legend className="sr-only">MCP servers {agent.name} uses</legend>
            <ul className="flex flex-col gap-2">
              {servers.map((server) => (
                <ServerChoice
                  key={server.slug}
                  server={server}
                  choice={selection.find((choice) => choice.server === server.slug) ?? null}
                  onChoose={(on) => setSelection((before) => chooseServer(before, server.slug, on))}
                  onMode={(mode) => setSelection((before) => setToolMode(before, server, mode))}
                  onPick={(tool, on) =>
                    setSelection((before) => pickTool(before, server, tool, on))
                  }
                />
              ))}
              {unknown.map((choice) => (
                <li
                  key={choice.server}
                  className="flex items-start gap-3 rounded-lg border border-[var(--danger)]/40 px-3 py-2.5"
                >
                  <input
                    id={`unknown-${choice.server}`}
                    type="checkbox"
                    checked
                    onChange={() =>
                      setSelection((before) => chooseServer(before, choice.server, false))
                    }
                    className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                  />
                  <label htmlFor={`unknown-${choice.server}`} className="min-w-0 text-sm">
                    <span className="font-mono">{choice.server}</span>
                    <span className="block text-xs text-[var(--danger-on-tint)]">
                      This server is no longer in Settings → MCP. Untick it to save.
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        {problem && dirty && <p className="mt-3 text-sm text-[var(--danger-on-tint)]">{problem}</p>}
        {update.error ? (
          <div className="mt-3">
            <ErrorNotice>{errorMessage(update.error)}</ErrorNotice>
          </div>
        ) : null}
        {(servers.length > 0 || unknown.length > 0) && (
          <div className="mt-4">
            <SaveBar
              dirty={dirty}
              busy={update.isPending}
              disabled={unknown.length > 0 || problem !== null}
              onSave={save}
              onReset={() => {
                setSelection(saved);
                update.reset();
              }}
            />
          </div>
        )}
      </Panel>

      <Panel
        title="Tools it gets"
        description={
          dirty
            ? 'Once you save: the names its model sees, from each server’s last test.'
            : 'The names its model sees, from each server’s last test.'
        }
      >
        {selection.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">None: it uses no MCP servers.</p>
        ) : tools.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">
            None known yet. Test its servers in Settings → MCP to list their tools.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {tools.map((tool) => {
              const asks = needsApproval(tool.name, patterns);
              return (
                <li
                  key={tool.name}
                  className="flex flex-wrap items-baseline justify-between gap-x-3"
                >
                  <span
                    className={cn(
                      'min-w-0 break-all font-mono text-xs',
                      tool.missing && 'text-[var(--text-muted)] line-through',
                    )}
                  >
                    {tool.name}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {tool.missing ? 'not listed by its last test' : asks ? 'asks first' : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-4 text-xs leading-relaxed text-[var(--text-muted)]">
          To have some of them ask you first, add them to the approvals list on the{' '}
          <button
            type="button"
            onClick={onOpenTools}
            className="text-[var(--accent-bright)] underline-offset-4 hover:underline"
          >
            Tools tab
          </button>{' '}
          (Advanced). Patterns work too, such as{' '}
          <span className="font-mono">mcp__github__create_*</span>.
        </p>
      </Panel>
    </div>
  );
}

function ServerChoice({
  server,
  choice,
  onChoose,
  onMode,
  onPick,
}: {
  server: McpServer;
  choice: AgentMcpServer | null;
  onChoose: (on: boolean) => void;
  onMode: (mode: 'all' | 'pick') => void;
  onPick: (tool: string, on: boolean) => void;
}) {
  const id = useId();
  const status = serverStatus(server);
  const visible = visibleTools(server);
  const chosen = choice !== null;
  const picked = choice?.tools ?? null;
  // Picked tools its last test no longer lists: shown, so they can be unticked.
  const stale = (picked ?? []).filter((name) => !visible.some((tool) => tool.name === name));
  return (
    <li
      className={cn(
        'rounded-lg border px-3 py-2.5 transition-colors',
        chosen ? 'border-[var(--border-strong)]' : 'border-[var(--border-subtle)]',
      )}
    >
      <div className="flex items-start gap-3">
        <input
          id={`${id}-use`}
          type="checkbox"
          checked={chosen}
          onChange={(event) => onChoose(event.target.checked)}
          aria-describedby={`${id}-about`}
          className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={`${id}-use`} className="cursor-pointer text-sm font-medium">
              {server.name}{' '}
              <span className="font-mono text-xs font-normal text-[var(--text-muted)]">
                {server.slug}
              </span>
            </label>
            <McpStatusBadge server={server} />
          </div>
          <p id={`${id}-about`} className="text-xs text-[var(--text-muted)]">
            {server.description ||
              (server.transport === 'stdio' ? 'A program on this computer' : 'A remote server')}
          </p>
        </div>
      </div>

      {chosen && (
        <div className="mt-3 flex flex-col gap-3 pl-7">
          {status.id !== 'ok' && (
            <p
              role="note"
              className="flex items-start gap-2 rounded-md bg-[var(--warning)]/[0.08] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
            >
              <TriangleAlert
                className="mt-px size-3.5 shrink-0 text-[var(--warning)]"
                aria-hidden="true"
              />
              {status.forAgent}
            </p>
          )}
          <fieldset className="m-0 flex flex-wrap gap-x-5 gap-y-1 border-0 p-0">
            <legend className="sr-only">Which tools of {server.name}</legend>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-mode`}
                checked={picked === null}
                onChange={() => onMode('all')}
                className="size-4 accent-[var(--accent)]"
              />
              All tools
              <span className="text-xs text-[var(--text-muted)]">
                {server.testedAt === null && server.tools.length === 0
                  ? '(whatever it offers)'
                  : `(${visible.length})`}
              </span>
            </label>
            <label
              className={cn(
                'flex items-center gap-2 text-sm',
                visible.length === 0 && picked === null
                  ? 'cursor-not-allowed text-[var(--text-muted)]'
                  : 'cursor-pointer',
              )}
            >
              <input
                type="radio"
                name={`${id}-mode`}
                checked={picked !== null}
                disabled={visible.length === 0 && picked === null}
                onChange={() => onMode('pick')}
                className="size-4 accent-[var(--accent)]"
              />
              Pick tools
              {picked !== null && (
                <span className="text-xs text-[var(--text-muted)]">
                  ({picked.length} of {visible.length})
                </span>
              )}
            </label>
          </fieldset>
          {visible.length === 0 && picked === null && (
            <p className="-mt-1 text-xs text-[var(--text-muted)]">
              Test it in Settings → MCP to choose among its tools.
            </p>
          )}
          {picked !== null && (
            <fieldset className="m-0 border-0 p-0">
              <legend className="sr-only">Tools of {server.name} it gets</legend>
              {picked.length === 0 && (
                <p className="mb-1 text-xs text-[var(--warning)]">
                  None picked: it gets no tools from {server.name}.
                </p>
              )}
              <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                {visible.map((tool) => (
                  <li key={tool.name}>
                    <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1 hover:bg-[var(--bg-control)]">
                      <input
                        type="checkbox"
                        checked={picked.includes(tool.name)}
                        onChange={(event) => onPick(tool.name, event.target.checked)}
                        className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                      />
                      <span className="min-w-0">
                        <span className="block font-mono text-xs">{tool.name}</span>
                        {(tool.description || tool.title) && (
                          <span className="line-clamp-2 block text-xs text-[var(--text-muted)]">
                            {tool.description || tool.title}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
                {stale.map((name) => (
                  <li key={name}>
                    <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1 hover:bg-[var(--bg-control)]">
                      <input
                        type="checkbox"
                        checked
                        onChange={() => onPick(name, false)}
                        className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                      />
                      <span className="min-w-0">
                        <span className="block font-mono text-xs text-[var(--text-muted)]">
                          {name}
                        </span>
                        <span className="block text-xs text-[var(--text-muted)]">
                          Not listed by its last test
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
        </div>
      )}
    </li>
  );
}

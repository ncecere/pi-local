import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalendarDays, GitFork, Layers, ListChecks, Mail, Notebook, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '~/api/client';
import { ErrorNotice } from '~/components/models/fields';
import { SettingsSection } from '~/components/settings/settings-layout';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { useAgents, useUpdateAgent } from '~/hooks/use-agents';
import {
  CONNECTIONS_KEY,
  type Connection,
  useConnectionAction,
  useConnections,
} from '~/hooks/use-connections';
import { MCP_SERVERS_KEY } from '~/hooks/use-mcp';
import { usePageTitle } from '~/lib/document-title';
import { chooseServer, readAgentMcp } from '~/lib/mcp';

const icons = {
  calendar: CalendarDays,
  github: GitFork,
  layers: Layers,
  'list-checks': ListChecks,
  mail: Mail,
  notebook: Notebook,
  workflow: Workflow,
};
const labels = {
  not_connected: 'Not connected',
  connected: 'Connected',
  needs_sign_in: 'Needs sign-in',
  error: 'Needs attention',
};

export function ConnectionAgents({
  connection,
  onClose,
}: {
  connection: Connection;
  onClose: () => void;
}) {
  const agents = useAgents();
  const update = useUpdateAgent();
  const client = useQueryClient();
  const slug = connection.server?.slug;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Use {connection.name} with agents</DialogTitle>
          <DialogDescription>
            Each change saves immediately. Your other connections and tool choices stay unchanged.
          </DialogDescription>
        </DialogHeader>
        {agents.isPending && <Spinner />}
        {agents.error && <ErrorNotice>{errorMessage(agents.error)}</ErrorNotice>}
        {agents.data?.length === 0 && <p>No agents yet. Make one in Settings → Agents.</p>}
        <div className="flex max-h-80 flex-col gap-3 overflow-y-auto">
          {agents.data?.map((agent) => {
            const selection = readAgentMcp(agent);
            const selected = selection.some((c) => c.server === slug);
            return (
              <label key={agent.id} className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={
                    !slug || update.isPending || (connection.state !== 'connected' && !selected)
                  }
                  onChange={(event) => {
                    if (slug)
                      update.mutate(
                        { id: agent.id, mcp: chooseServer(selection, slug, event.target.checked) },
                        {
                          onSettled: () => {
                            void client.invalidateQueries({ queryKey: CONNECTIONS_KEY });
                            void client.invalidateQueries({ queryKey: MCP_SERVERS_KEY });
                          },
                        },
                      );
                  }}
                />
                {agent.name}
              </label>
            );
          })}
        </div>
        {update.error && <ErrorNotice>{errorMessage(update.error)}</ErrorNotice>}
        {connection.state !== 'connected' && (
          <p className="mt-3 text-sm text-[var(--text-muted)]">
            Reconnect before adding agents. You can still remove access.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ConnectionCard({ connection: c }: { connection: Connection }) {
  const action = useConnectionAction();
  const [picking, setPicking] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const Icon = icons[c.icon as keyof typeof icons] ?? Notebook;
  useEffect(() => {
    if (!waiting) return;
    if (c.state === 'connected') {
      setWaiting(null);
      return;
    }
    const timer = setTimeout(() => setWaiting(null), 6 * 60_000);
    return () => clearTimeout(timer);
  }, [waiting, c.state]);
  // A completed sign-in has a new test result. Never infer success from opening the browser.
  const signing = waiting !== null && c.state !== 'connected';
  const connect = () => {
    setWaiting(null);
    action.mutate(
      { id: c.id },
      {
        onSuccess: (result) => {
          if ('authorizeUrl' in result && result.authorizeUrl) setWaiting(result.authorizeUrl);
        },
      },
    );
  };
  return (
    <article
      aria-label={c.name}
      className="flex flex-col gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-4"
    >
      <div className="flex items-center gap-3">
        <Icon className="size-6 shrink-0" aria-hidden />
        <h3 className="font-semibold">{c.name}</h3>
        {c.advanced && <span className="text-xs text-[var(--text-muted)]">Advanced</span>}
      </div>
      <p className="text-sm text-[var(--text-secondary)]">{c.description}</p>
      <p role="status" className="text-sm">
        {signing ? 'Finish signing in in your browser…' : labels[c.state]}
      </p>
      {c.auth === 'macos-permission' && (
        <p className="text-xs text-[var(--text-muted)]">
          {c.automatic
            ? 'macOS permission on first use. Connected means tools are ready, not that permission was verified.'
            : 'Coming to Windows and Linux.'}
        </p>
      )}
      {c.problem && <ErrorNotice>{c.problem}</ErrorNotice>}
      {action.error && <ErrorNotice>{errorMessage(action.error)}</ErrorNotice>}
      {signing && (
        <p className="text-sm">
          <a
            href={waiting!}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--accent-bright)] underline"
          >
            Open sign-in page
          </a>{' '}
          · Waiting for confirmation, up to 6 minutes.
        </p>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer">
          {c.advanced ? 'Setup steps' : 'How it connects'}
        </summary>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-[var(--text-secondary)]">
          {c.setup.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {c.url && <p className="mt-2 break-all font-mono text-xs">{c.url}</p>}
        <a
          href={c.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-[var(--accent-bright)] underline"
        >
          Setup guide
        </a>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Sources checked {c.checkedAt}.{' '}
          {c.auth === 'oauth'
            ? 'Browser OAuth.'
            : c.auth === 'oauth-app-or-token'
              ? 'OAuth app or a token, not automatic sign-in.'
              : ''}
        </p>
      </details>
      {c.usedBy.length > 0 ? (
        <p className="text-xs">
          Used by{' '}
          {c.usedBy.map((agent, i) => (
            <span key={agent.id}>
              {i > 0 && ', '}
              <Link
                to="/settings/agents/$agentId"
                params={{ agentId: agent.id }}
                search={{ tab: 'mcp' }}
                className="text-[var(--accent-bright)] underline"
              >
                {agent.name}
              </Link>
            </span>
          ))}
        </p>
      ) : (
        <p className="text-xs text-[var(--text-muted)]">No agents use this yet.</p>
      )}
      <div className="mt-auto flex flex-wrap gap-2 pt-2">
        {c.automatic && (
          <Button
            size="sm"
            variant="secondary"
            disabled={action.isPending || signing}
            onClick={connect}
          >
            {action.isPending ? (
              <>
                <Spinner className="size-3" /> Working…
              </>
            ) : c.state === 'connected' ? (
              'Test connection'
            ) : c.server ? (
              'Reconnect'
            ) : (
              'Connect'
            )}
          </Button>
        )}
        {c.server && (
          <>
            <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>
              Use with agents
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={action.isPending || c.usedBy.length > 0 || signing}
              onClick={() => {
                if (
                  window.confirm(
                    `Disconnect ${c.name}? Its saved sign-in will be removed. macOS permissions and provider-side grants are not revoked.`,
                  )
                )
                  action.mutate({ id: c.id, disconnect: true });
              }}
            >
              Disconnect
            </Button>
          </>
        )}
        {!c.automatic && c.advanced && (
          <Button size="sm" variant="secondary" asChild>
            <Link to="/settings/mcp">Custom setup</Link>
          </Button>
        )}
      </div>
      {c.usedBy.length > 0 && (
        <p className="text-xs text-[var(--text-muted)]">
          To disconnect, remove access under Use with agents first.
        </p>
      )}
      {picking && <ConnectionAgents connection={c} onClose={() => setPicking(false)} />}
    </article>
  );
}

export function SettingsConnectionsPage() {
  usePageTitle('Connections');
  const connections = useConnections();
  return (
    <SettingsSection title="Connections">
      <p className="mb-3 text-sm text-[var(--text-secondary)]">
        Connect your apps, then choose which agents can use them. Nothing gets access until you
        choose it.
      </p>
      <p className="mb-5 text-sm">
        Need another app?{' '}
        <Link to="/settings/mcp" className="text-[var(--accent-bright)] underline">
          Custom connections (MCP)
        </Link>
      </p>
      {connections.isPending && <Spinner />}
      {connections.error && (
        <ErrorNotice>
          {errorMessage(connections.error)}{' '}
          <button type="button" onClick={() => void connections.refetch()}>
            Try again
          </button>
        </ErrorNotice>
      )}
      {(
        [
          ['apps', 'Work apps'],
          ['mail', 'Mail, calendar and files'],
          ['computer', 'On this computer'],
        ] as const
      ).map(([group, title]) => (
        <section key={group} aria-label={title} className="mb-8">
          <h2 className="mb-3 text-base font-semibold">{title}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {connections.data
              ?.filter((c) => c.group === group)
              .map((c) => (
                <ConnectionCard key={c.id} connection={c} />
              ))}
          </div>
          {group === 'computer' && (
            <p className="mt-3 text-sm text-[var(--text-muted)]">
              Files already use each agent’s workspace tools. No extra connection is needed.
            </p>
          )}
        </section>
      ))}
    </SettingsSection>
  );
}

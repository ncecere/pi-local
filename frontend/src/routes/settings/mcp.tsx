import { Link } from '@tanstack/react-router';
import {
  ChevronRight,
  Download,
  ExternalLink,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, type McpServer } from '~/api/client';
import { ImportDialog } from '~/components/mcp/import-dialog';
import { McpLoginDialog } from '~/components/mcp/login-dialog';
import { McpStatusBadge, McpTestResult } from '~/components/mcp/server-bits';
import {
  AddServerDialog,
  DeleteServerDialog,
  EditServerDialog,
} from '~/components/mcp/server-dialogs';
import { ErrorNotice } from '~/components/models/fields';
import { SettingsSection } from '~/components/settings/settings-layout';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import {
  useMcpServers,
  useSignInMcpServer,
  useSignOutMcpServer,
  useTestMcpServer,
  useUpdateMcpServer,
} from '~/hooks/use-mcp';
import { usePageTitle } from '~/lib/document-title';
import {
  commandLine,
  hasLoginCommand,
  importSourceName,
  needsSignIn,
  serverStatus,
  signInOutcome,
  visibleTools,
  WORKSPACE_VAR,
} from '~/lib/mcp';
import { cn, plural } from '~/lib/utils';

/** A sign-in waiting for the browser: the server as it was, and the link to open by hand. */
interface SignIn {
  before: McpServer;
  authorizeUrl: string | null;
}

/** How long a sign-in may take (the backend gives up after 5 minutes). */
const SIGN_IN_MS = 5 * 60_000;

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 py-1.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
      <dd className="min-w-0 text-xs text-[var(--text-primary)]">{children}</dd>
    </div>
  );
}

const Names = ({ names }: { names: string[] }) =>
  names.length === 0 ? (
    <span className="text-[var(--text-muted)]">None</span>
  ) : (
    <span className="font-mono">{names.join(', ')}</span>
  );

function ServerDetails({ server }: { server: McpServer }) {
  return (
    <dl className="divide-y divide-[var(--border-subtle)]">
      {server.transport === 'stdio' ? (
        <>
          <Detail label="Command">
            <span className="whitespace-pre-wrap break-all font-mono">
              {commandLine(server.command, server.args)}
            </span>
          </Detail>
          {hasLoginCommand(server) && (
            <Detail label="Sign-in command">
              <span className="whitespace-pre-wrap break-all font-mono">
                {commandLine(server.command, server.loginArgs)}
              </span>
            </Detail>
          )}
          <Detail label="Working directory">
            <span className="break-all font-mono">{server.cwd || WORKSPACE_VAR}</span>
          </Detail>
          <Detail label="Environment">
            <Names names={server.envNames} />
          </Detail>
        </>
      ) : (
        <>
          <Detail label="URL">
            <span className="break-all font-mono">{server.url}</span>
          </Detail>
          <Detail label="Headers">
            <Names names={server.headerNames} />
          </Detail>
          <Detail label="OAuth">
            {server.oauth ? (server.signedIn ? 'Signed in' : 'Not signed in') : 'Not used'}
          </Detail>
        </>
      )}
      {server.importedFrom && (
        <Detail label="Imported from">{importSourceName(server.importedFrom)}</Detail>
      )}
      <Detail label="Used by">
        {server.usedBy.length === 0 ? (
          <span className="text-[var(--text-muted)]">No agents yet</span>
        ) : (
          <span className="flex flex-wrap gap-x-2 gap-y-1">
            {server.usedBy.map((agent) => (
              <Link
                key={agent.id}
                to="/settings/agents/$agentId"
                params={{ agentId: agent.id }}
                search={{ tab: 'mcp' }}
                className="text-[var(--accent-bright)] underline-offset-4 hover:underline"
              >
                {agent.name}
              </Link>
            ))}
          </span>
        )}
      </Detail>
    </dl>
  );
}

function SignInNotice({ signIn, onCancel }: { signIn: SignIn; onCancel: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)]/50 px-3 py-2.5 text-sm"
    >
      <p className="flex items-center gap-2">
        <Spinner className="size-4" />
        Finish signing in in your browser…
      </p>
      <p className="text-xs text-[var(--text-muted)]">
        {signIn.authorizeUrl ? (
          <>
            If no browser window opened,{' '}
            <a
              href={signIn.authorizeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[var(--accent-bright)] underline-offset-4 hover:underline"
            >
              open the sign-in page
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
            .{' '}
          </>
        ) : (
          'Starting the sign-in… '
        )}
        <button
          type="button"
          onClick={onCancel}
          className="text-[var(--text-secondary)] underline-offset-4 hover:underline"
        >
          Stop waiting
        </button>
      </p>
    </div>
  );
}

function ServerCard({
  server,
  expanded,
  onToggle,
  signIn,
  onSignIn,
  onCancelSignIn,
  onLogin,
  onEdit,
  onDelete,
}: {
  server: McpServer;
  expanded: boolean;
  onToggle: (open?: boolean) => void;
  signIn: SignIn | undefined;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  /** Run its own sign-in command (a stdio server with `loginArgs`). */
  onLogin: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const id = useId();
  const update = useUpdateMcpServer();
  const test = useTestMcpServer();
  const signOut = useSignOutMcpServer();
  const status = serverStatus(server);
  const visible = visibleTools(server).length;
  const runTest = () => {
    onToggle(true);
    test.mutate(server.slug, {
      onSuccess: (tested) => {
        if (tested.lastError) toast.error(`${tested.name}: the test failed.`);
        else toast(`${tested.name}: ${plural(visibleTools(tested).length, 'tool')} found.`);
      },
      onError: (error) => toast.error(errorMessage(error, 'The test could not run.')),
    });
  };
  return (
    <li>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`${id}-details`}
          onClick={() => onToggle()}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-bright)]"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'size-4 shrink-0 text-[var(--text-muted)] transition-transform motion-reduce:transition-none',
              expanded && 'rotate-90',
            )}
          />
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block truncate text-sm font-medium',
                !server.enabled && 'text-[var(--text-muted)]',
              )}
            >
              {server.name}
              <span className="sr-only">, {status.label}</span>
            </span>
            <span className="block truncate text-xs text-[var(--text-muted)]">
              <span className="font-mono">{server.slug}</span> ·{' '}
              {server.transport === 'stdio' ? 'stdio' : 'http'} ·{' '}
              {server.transport === 'stdio' ? commandLine(server.command, server.args) : server.url}
            </span>
            <span className="block truncate text-xs text-[var(--text-muted)]">
              {server.usedBy.length === 0
                ? 'Not used by any agent'
                : `Used by ${plural(server.usedBy.length, 'agent')}`}
            </span>
          </span>
        </button>
        {test.isPending ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <Spinner className="size-3.5" /> Testing…
          </span>
        ) : signIn ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <Spinner className="size-3.5" /> Signing in…
          </span>
        ) : (
          <McpStatusBadge server={server} />
        )}
        <Switch
          checked={server.enabled}
          disabled={update.isPending}
          aria-label={`Use ${server.name}`}
          onCheckedChange={(enabled) =>
            update.mutate(
              { slug: server.slug, enabled },
              {
                onSuccess: () => {
                  if (!enabled && server.usedBy.length > 0)
                    toast(
                      `${server.name} is off. ${plural(server.usedBy.length, 'agent')} using it ${server.usedBy.length === 1 ? 'restarts' : 'restart'} without it.`,
                    );
                },
                onError: (error) => toast.error(errorMessage(error, 'Not changed.')),
              },
            )
          }
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit ${server.name}`}
          title="Edit"
          onClick={onEdit}
        >
          <Pencil />
        </Button>
      </div>
      <section
        id={`${id}-details`}
        aria-label={`${server.name} details`}
        hidden={!expanded}
        className="border-t border-[var(--border-subtle)] bg-[var(--bg-inset)]/40"
      >
        {expanded && (
          <div className="flex flex-col gap-4 px-4 py-3">
            {server.description && (
              <p className="text-sm text-[var(--text-secondary)]">{server.description}</p>
            )}
            <ServerDetails server={server} />
            {signIn && <SignInNotice signIn={signIn} onCancel={onCancelSignIn} />}
            <div aria-live="polite">
              {test.isPending ? (
                <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                  <Spinner className="size-4" />
                  {server.transport === 'stdio'
                    ? 'Starting it and listing its tools (up to a minute)…'
                    : 'Connecting and listing its tools (up to a minute)…'}
                </p>
              ) : (
                <>
                  <h3 className="mb-2 text-sm font-semibold">
                    Tools
                    {server.tools.length > 0 && (
                      <span className="font-normal text-[var(--text-muted)]">
                        {' '}
                        · agents see them as{' '}
                        <span className="font-mono text-xs">mcp__{server.slug}__…</span>
                      </span>
                    )}
                  </h3>
                  <McpTestResult server={server} />
                  {status.id === 'ok' && visible === 0 && server.tools.length > 0 && (
                    <p className="mt-2 text-xs text-[var(--text-muted)]">
                      All its tools are hidden from the model: agents get none.
                    </p>
                  )}
                </>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={test.isPending}
                onClick={runTest}
              >
                <RefreshCw />
                Test
              </Button>
              {hasLoginCommand(server) && (
                <Button type="button" variant="secondary" size="sm" onClick={onLogin}>
                  <LogIn />
                  Sign in
                </Button>
              )}
              {server.transport === 'http' && server.oauth && (
                <>
                  {(needsSignIn(server) || !server.signedIn) && (
                    <Button
                      type="button"
                      variant={signIn ? 'secondary' : 'primary'}
                      size="sm"
                      disabled={Boolean(signIn)}
                      onClick={onSignIn}
                    >
                      <LogIn />
                      Sign in
                    </Button>
                  )}
                  {server.signedIn && (
                    <>
                      {needsSignIn(server) ? null : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={Boolean(signIn)}
                          onClick={onSignIn}
                        >
                          <LogIn />
                          Sign in again
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={signOut.isPending}
                        onClick={() =>
                          signOut.mutate(server.slug, {
                            onSuccess: (out) => toast(`Signed out of ${out.name}.`),
                            onError: (error) => toast.error(errorMessage(error, 'Not signed out.')),
                          })
                        }
                      >
                        {signOut.isPending ? <Spinner className="size-4" /> : <LogOut />}
                        Sign out
                      </Button>
                    </>
                  )}
                </>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
                <Pencil />
                Edit
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={onDelete}>
                <Trash2 />
                Delete
              </Button>
            </div>
          </div>
        )}
      </section>
    </li>
  );
}

type Open =
  | { kind: 'add' }
  | { kind: 'import' }
  | { kind: 'edit'; slug: string }
  | { kind: 'delete'; slug: string }
  | { kind: 'login'; slug: string };

/**
 * Settings → MCP: the catalog of MCP servers agents may use (docs/api.md,
 * Phase 5): each one's state (tested and its tools, an error, a sign-in
 * needed, off), adding, importing, testing, signing in, and which agents use it.
 */
export function SettingsMcpPage() {
  usePageTitle('MCP · Settings');
  const servers = useMcpServers();
  const startSignIn = useSignInMcpServer();
  const [open, setOpen] = useState<Open | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [signIns, setSignIns] = useState<Record<string, SignIn>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const close = () => setOpen(null);
  const list = servers.data;

  const stopWaiting = (slug: string) => {
    clearTimeout(timers.current.get(slug));
    timers.current.delete(slug);
    setSignIns(({ [slug]: _gone, ...rest }) => rest);
  };

  // Each sign-in ends when the `mcp` live event says how it went.
  useEffect(() => {
    if (!list) return;
    for (const [slug, signIn] of Object.entries(signIns)) {
      const now = list.find((server) => server.slug === slug);
      const outcome = signInOutcome(signIn.before, now);
      if (outcome === 'waiting') continue;
      clearTimeout(timers.current.get(slug));
      timers.current.delete(slug);
      setSignIns(({ [slug]: _done, ...rest }) => rest);
      if (outcome === 'signed-in' && now)
        toast(
          `Signed in to ${now.name}.${now.lastError ? '' : ` ${plural(visibleTools(now).length, 'tool')} found.`}`,
        );
      else if (outcome === 'failed' && now) toast.error(`Signing in to ${now.name} didn’t work.`);
    }
  }, [list, signIns]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  const setOpenCard = (slug: string, on: boolean) =>
    setExpanded((before) => {
      const next = new Set(before);
      if (on) next.add(slug);
      else next.delete(slug);
      return next;
    });

  const signIn = (server: McpServer) => {
    setOpenCard(server.slug, true);
    setSignIns((before) => ({ ...before, [server.slug]: { before: server, authorizeUrl: null } }));
    clearTimeout(timers.current.get(server.slug));
    timers.current.set(
      server.slug,
      setTimeout(() => {
        stopWaiting(server.slug);
        toast.error(`The sign-in to ${server.name} timed out. Try again.`);
      }, SIGN_IN_MS),
    );
    startSignIn.mutate(server.slug, {
      onSuccess: ({ authorizeUrl }) =>
        setSignIns((before) =>
          before[server.slug]
            ? { ...before, [server.slug]: { ...before[server.slug]!, authorizeUrl } }
            : before,
        ),
      onError: (error) => {
        stopWaiting(server.slug);
        toast.error(errorMessage(error, 'The sign-in could not start.'));
      },
    });
  };

  if (servers.isError)
    return (
      <SettingsSection title="MCP servers" first>
        <ErrorNotice>MCP servers could not be read: {errorMessage(servers.error)}</ErrorNotice>
        <div>
          <Button type="button" variant="secondary" onClick={() => void servers.refetch()}>
            <RefreshCw />
            Try again
          </Button>
        </div>
      </SettingsSection>
    );
  if (!list)
    return (
      <div className="py-12">
        <Spinner className="mx-auto" />
      </div>
    );

  // The dialogs follow the live data: a server deleted meanwhile closes its dialog.
  const current = open && 'slug' in open ? list.find((s) => s.slug === open.slug) : undefined;

  return (
    <>
      <SettingsSection title="MCP servers" first>
        <p className="-mt-2 text-sm text-[var(--text-muted)]">
          Tools for your agents from MCP servers: programs on this computer, or remote servers. Each
          agent chooses which it uses on its MCP tab (Settings → Agents). Secrets are kept in the
          system keychain.
        </p>
        {list.length > 0 ? (
          <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
            {list.map((server) => (
              <ServerCard
                key={server.slug}
                server={server}
                expanded={expanded.has(server.slug)}
                onToggle={(on) => setOpenCard(server.slug, on ?? !expanded.has(server.slug))}
                signIn={signIns[server.slug]}
                onSignIn={() => signIn(server)}
                onCancelSignIn={() => stopWaiting(server.slug)}
                onLogin={() => setOpen({ kind: 'login', slug: server.slug })}
                onEdit={() => setOpen({ kind: 'edit', slug: server.slug })}
                onDelete={() => setOpen({ kind: 'delete', slug: server.slug })}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">
            None yet. Add one, or import the ones Claude Desktop, Cursor or VS Code use.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="primary" onClick={() => setOpen({ kind: 'add' })}>
            <Plus />
            Add server
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen({ kind: 'import' })}>
            <Download />
            Import
          </Button>
        </div>
      </SettingsSection>

      {open?.kind === 'add' && (
        <AddServerDialog
          onClose={close}
          onSignIn={(server) => {
            signIn(server);
          }}
          onLogin={(server) => {
            setOpenCard(server.slug, true);
            setOpen({ kind: 'login', slug: server.slug });
          }}
        />
      )}
      {open?.kind === 'import' && <ImportDialog onClose={close} />}
      {open?.kind === 'edit' && current && <EditServerDialog server={current} onClose={close} />}
      {open?.kind === 'delete' && current && (
        <DeleteServerDialog server={current} onClose={close} />
      )}
      {open?.kind === 'login' && current && <McpLoginDialog server={current} onClose={close} />}
    </>
  );
}

import { CircleAlert, CircleCheck, EyeOff, KeyRound } from 'lucide-react';
import type { ReactNode } from 'react';
import type { McpServer } from '~/api/client';
import { type McpStatusId, needsSignIn, serverStatus, visibleTools } from '~/lib/mcp';
import { cn, formatRelativeTime, plural } from '~/lib/utils';

const STATUS_TONE: Record<McpStatusId, string> = {
  ok: 'bg-[var(--success)]/15 text-[var(--success)]',
  error: 'bg-[var(--danger)]/15 text-[var(--danger-on-tint)]',
  'needs-sign-in': 'bg-[var(--warning)]/15 text-[var(--warning)]',
  untested: 'bg-[var(--bg-control)] text-[var(--text-secondary)]',
  off: 'bg-[var(--bg-control)] text-[var(--text-muted)]',
};

/** A server's state in a word or two: "12 tools", "Error", "Needs sign-in", "Off". */
export function McpStatusBadge({ server, className }: { server: McpServer; className?: string }) {
  const status = serverStatus(server);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums',
        STATUS_TONE[status.id],
        className,
      )}
    >
      {status.label}
    </span>
  );
}

/** A monospace block for an error's text (stderr's tail included), scrolled when long. */
export function ErrorText({ children, label }: { children: string; label?: string }) {
  return (
    <section
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolled region must be reachable by keyboard
      tabIndex={0}
      aria-label={label}
      className="max-h-56 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2"
    >
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-[var(--text-primary)]">
        {children}
      </pre>
    </section>
  );
}

/** A server's tools: name, title, what it does; the ones hidden from the model marked. */
export function McpToolList({ server }: { server: McpServer }) {
  if (server.tools.length === 0)
    return <p className="text-sm text-[var(--text-muted)]">It offers no tools.</p>;
  return (
    <ul className="flex flex-col divide-y divide-[var(--border-subtle)]">
      {server.tools.map((tool) => (
        <li key={tool.name} className="py-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span
              className={cn(
                'font-mono text-xs font-medium',
                !tool.modelVisible && 'text-[var(--text-muted)]',
              )}
            >
              {tool.name}
            </span>
            {tool.title && tool.title !== tool.name && (
              <span className="text-xs text-[var(--text-secondary)]">{tool.title}</span>
            )}
            {!tool.modelVisible && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-control)] px-2 py-0.5 text-[0.6875rem] text-[var(--text-muted)]">
                <EyeOff className="size-3" aria-hidden="true" />
                Hidden from the model
              </span>
            )}
          </div>
          {tool.description && (
            <p className="mt-0.5 line-clamp-3 text-xs text-[var(--text-muted)]">
              {tool.description}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A needs-sign-in error without its code and the "Choose Sign in." the button says already. */
const signInDetail = (error: string) =>
  error
    .replace(/^\s*needs_sign_in:?\s*/, '')
    .replace(/\s*Choose Sign in\.\s*/, ' ')
    .trim();

/** What the last test found: its tools, or why it failed. */
export function McpTestResult({
  server,
  showTools = true,
}: {
  server: McpServer;
  showTools?: boolean;
}) {
  if (needsSignIn(server))
    return (
      <div className="flex flex-col gap-2">
        <p className="flex items-start gap-2 text-sm">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" aria-hidden="true" />
          <span>
            {server.name} needs you to sign in before its tools can be listed.
            {server.signedIn ? ' Your sign-in may have expired.' : ''}
          </span>
        </p>
        {server.lastError && signInDetail(server.lastError) && (
          <ErrorText label="Details">{signInDetail(server.lastError)}</ErrorText>
        )}
      </div>
    );
  if (server.lastError)
    return (
      <div className="flex flex-col gap-2">
        <p className="flex items-start gap-2 text-sm">
          <CircleAlert
            className="mt-0.5 size-4 shrink-0 text-[var(--danger-on-tint)]"
            aria-hidden="true"
          />
          <span>
            The last test failed
            {server.testedAt ? ` (${formatRelativeTime(new Date(server.testedAt))})` : ''}:
          </span>
        </p>
        <ErrorText label="Error">{server.lastError}</ErrorText>
      </div>
    );
  if (server.testedAt === null)
    return <p className="text-sm text-[var(--text-muted)]">Not tested yet.</p>;
  const visible = visibleTools(server).length;
  const hidden = server.tools.length - visible;
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-start gap-2 text-sm">
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-[var(--success)]" aria-hidden="true" />
        <span>
          Connected {formatRelativeTime(new Date(server.testedAt))}: {plural(visible, 'tool')}
          {hidden > 0 && ` for the model, ${hidden} hidden`}.
        </span>
      </p>
      {showTools && <McpToolList server={server} />}
    </div>
  );
}

/** "It runs on this computer as you": shown wherever a command is added. */
export function TrustWarning({ children }: { children?: ReactNode }) {
  return (
    <div
      role="note"
      className="flex gap-2.5 rounded-lg border border-[var(--warning)]/45 bg-[var(--warning)]/[0.08] px-3 py-2.5 text-sm text-[var(--text-primary)]"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" aria-hidden="true" />
      <p>
        {children ?? (
          <>
            It runs on this computer as you — only add commands you trust.{' '}
            <span className="text-[var(--text-secondary)]">
              It can read and change anything you can, whatever an agent's other settings are.
            </span>
          </>
        )}
      </p>
    </div>
  );
}

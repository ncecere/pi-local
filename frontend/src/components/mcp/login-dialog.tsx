import { CircleAlert, CircleCheck, CircleSlash, RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';
import { errorMessage, type McpLoginStatus, type McpServer } from '~/api/client';
import { McpTestResult } from '~/components/mcp/server-bits';
import { ErrorNotice } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { isLoginRunning, useCancelMcpLogin, useMcpLogin, useStartMcpLogin } from '~/hooks/use-mcp';
import { commandLine, linkParts, visibleTools } from '~/lib/mcp';
import { plural } from '~/lib/utils';

/** The command's output, its web addresses clickable; it follows the end unless scrolled up. */
function LoginOutput({ output }: { output: string }) {
  const box = useRef<HTMLElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const element = box.current;
    if (element && output && atEnd.current) element.scrollTop = element.scrollHeight;
  }, [output]);
  let offset = 0;
  return (
    <section
      ref={box}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolled region must be reachable by keyboard
      tabIndex={0}
      aria-label="Output"
      onScroll={(event) => {
        const element = event.currentTarget;
        atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      className="max-h-72 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2"
    >
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-[var(--text-primary)]">
        {linkParts(output).map((part) => {
          const key = offset;
          offset += part.text.length;
          return part.url ? (
            // In the desktop app a new-tab link opens in the system browser.
            <a
              key={key}
              href={part.url}
              target="_blank"
              rel="noreferrer"
              className="break-all text-[var(--accent-bright)] underline underline-offset-2"
            >
              {part.text}
            </a>
          ) : (
            <span key={key}>{part.text}</span>
          );
        })}
      </pre>
    </section>
  );
}

const Line = ({ icon, children }: { icon: ReactNode; children: ReactNode }) => (
  <p className="flex items-center gap-2 text-sm">
    {icon}
    <span>{children}</span>
  </p>
);

/** Where the run is: running, signed in (and the test after it), failed, cancelled. */
function LoginState({ status, server }: { status: McpLoginStatus; server: McpServer }) {
  switch (status.state) {
    case 'running':
      return <Line icon={<Spinner className="size-4" />}>Running…</Line>;
    case 'succeeded': {
      const check = (
        <CircleCheck className="size-4 shrink-0 text-[var(--success)]" aria-hidden="true" />
      );
      // The backend tests it again by itself; the `mcp` event brings the result.
      const retested =
        server.testedAt !== null &&
        status.finishedAt !== null &&
        server.testedAt >= status.finishedAt;
      if (!retested) return <Line icon={check}>Signed in. Testing the server again…</Line>;
      if (server.lastError)
        return (
          <div className="flex flex-col gap-2">
            <Line icon={check}>Signed in.</Line>
            <McpTestResult server={server} showTools={false} />
          </div>
        );
      return (
        <Line icon={check}>Signed in. {plural(visibleTools(server).length, 'tool')} found.</Line>
      );
    }
    case 'failed':
      return (
        <Line
          icon={
            <CircleAlert
              className="size-4 shrink-0 text-[var(--danger-on-tint)]"
              aria-hidden="true"
            />
          }
        >
          {status.exitCode === null ? 'Failed' : `Failed (exit ${status.exitCode})`}
        </Line>
      );
    case 'cancelled':
      return (
        <Line
          icon={
            <CircleSlash className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
          }
        >
          Cancelled
        </Line>
      );
    default:
      return <Line icon={null}>Not started.</Line>;
  }
}

/**
 * Signing in to a local server with its own command (`loginArgs`): it starts
 * the command when it opens, then shows its output as it comes (`mcp-login`
 * live events), with its links clickable, and how it ended. One already
 * running (`409 login_running`) is shown instead. Closing it leaves a run
 * going; Cancel stops it.
 */
export function McpLoginDialog({ server, onClose }: { server: McpServer; onClose: () => void }) {
  const start = useStartMcpLogin();
  const cancel = useCancelMcpLogin();
  const { mutate: startLogin } = start;
  const slug = server.slug;
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    startLogin(slug);
  }, [startLogin, slug]);

  const starting = start.isIdle || start.isPending;
  // Read once the start has answered: a run older than it must not show meanwhile.
  const login = useMcpLogin(slug, !starting);
  const startError = start.error && !isLoginRunning(start.error) ? start.error : null;
  const status = starting || startError ? undefined : login.data;
  const running = status?.state === 'running';
  const done = status !== undefined && !running;
  const again = startError !== null || (done && status.state !== 'succeeded');

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Sign in to {server.name}</DialogTitle>
          <DialogDescription>
            Its sign-in command runs on this computer. A browser may open, or it may show a code or
            a link to open.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="break-all font-mono text-xs text-[var(--text-muted)]">
            {commandLine(server.command, server.loginArgs)}
          </p>
          <div role="status" aria-live="polite">
            {startError ? null : status ? (
              <LoginState status={status} server={server} />
            ) : (
              <Line icon={<Spinner className="size-4" />}>Starting…</Line>
            )}
          </div>
          {startError && (
            <ErrorNotice>{errorMessage(startError, 'The sign-in could not start.')}</ErrorNotice>
          )}
          {status &&
            (status.output ? (
              <LoginOutput output={status.output} />
            ) : (
              running && <p className="text-xs text-[var(--text-muted)]">Nothing printed yet.</p>
            ))}
          {cancel.error ? (
            <ErrorNotice>{errorMessage(cancel.error, 'It could not be cancelled.')}</ErrorNotice>
          ) : null}
        </div>
        <DialogFooter className="mt-4">
          {running ? (
            <Button
              type="button"
              variant="secondary"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(slug)}
            >
              {cancel.isPending && <Spinner className="size-4 text-current" />}
              Cancel
            </Button>
          ) : (
            <>
              {again && (
                <Button type="button" variant="secondary" onClick={() => startLogin(slug)}>
                  <RefreshCw />
                  Try again
                </Button>
              )}
              <Button
                type="button"
                variant={done && !again ? 'primary' : 'secondary'}
                onClick={onClose}
              >
                Close
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

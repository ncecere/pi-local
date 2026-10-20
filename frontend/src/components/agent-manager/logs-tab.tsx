import { RefreshCw } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { type Agent, errorMessage } from '~/api/client';
import { Panel } from '~/components/agent-manager/panel';
import { ErrorNotice } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useAgentLogs } from '~/hooks/use-agent-manager';
import { cn } from '~/lib/utils';

/** How close to the end counts as "at the end" (the view follows new lines from there). */
const FOLLOW_SLACK_PX = 24;

/**
 * The last 300 lines of the agent's runtime log, newest at the bottom; read
 * again every 3 s while it is awake (and the page is visible).
 */
export function LogsTab({ agent }: { agent: Agent }) {
  const live = agent.status === 'awake' || agent.status === 'starting';
  const logs = useAgentLogs(agent.id, { live });
  const scroller = useRef<HTMLElement>(null);
  const following = useRef(true);
  const lines = logs.data?.lines;

  // New lines keep the view at the end, unless someone scrolled up to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the lines change
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [lines]);

  return (
    <Panel
      title="Logs"
      description={
        logs.data?.path ? (
          <code className="break-all font-mono text-xs">{logs.data.path}</code>
        ) : (
          'Its runtime log.'
        )
      }
      actions={
        <>
          {live && (
            <span className="text-xs text-[var(--text-muted)]" title="Read again every 3 seconds">
              Live
            </span>
          )}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={logs.isFetching}
            onClick={() => {
              following.current = true;
              void logs.refetch();
            }}
          >
            {logs.isFetching ? <Spinner className="size-3.5 text-current" /> : <RefreshCw />}
            Refresh
          </Button>
        </>
      }
    >
      {logs.isPending ? (
        <div className="py-12">
          <Spinner className="mx-auto" />
        </div>
      ) : logs.isError && !logs.data ? (
        <ErrorNotice>{errorMessage(logs.error, 'The log could not be read.')}</ErrorNotice>
      ) : (
        <section
          ref={scroller}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the log scrolls, so keyboards must reach it
          tabIndex={0}
          aria-label="Log lines, newest last"
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_SLACK_PX;
          }}
          className={cn(
            'max-h-[32rem] min-h-48 overflow-auto rounded-lg bg-[var(--bg-inset)] px-3 py-2.5 font-mono text-[0.75rem] leading-relaxed whitespace-pre text-[var(--text-secondary)]',
            'border border-[var(--border-subtle)]',
          )}
        >
          {lines && lines.length > 0 ? (
            lines.join('\n')
          ) : (
            <span className="text-[var(--text-muted)]">Nothing logged yet.</span>
          )}
        </section>
      )}
    </Panel>
  );
}

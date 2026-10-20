import type { Agent } from '~/api/client';
import { cn } from '~/lib/utils';

const STATUS_LABEL: Record<Agent['status'], string> = {
  asleep: 'asleep',
  starting: 'waking',
  awake: 'awake',
  error: 'error',
};

/** The agent's runtime process, subtly: asleep, waking, awake, or why it failed to start. */
export function AgentStatus({
  agent,
  className,
}: {
  agent: Pick<Agent, 'status' | 'lastError'>;
  className?: string;
}) {
  const label = STATUS_LABEL[agent.status] ?? agent.status;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1',
        agent.status === 'error' && 'text-[var(--danger-on-tint)]',
        className,
      )}
      title={agent.status === 'error' && agent.lastError ? agent.lastError : undefined}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full',
          agent.status === 'awake' && 'bg-[var(--success,#22c55e)]',
          agent.status === 'starting' && 'bg-[var(--warning)] motion-safe:animate-pulse',
          agent.status === 'error' && 'bg-[var(--danger)]',
          agent.status === 'asleep' && 'bg-[var(--text-muted)] opacity-60',
        )}
      />
      {label}
    </span>
  );
}

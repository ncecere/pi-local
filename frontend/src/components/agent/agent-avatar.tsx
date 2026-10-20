import type { Agent } from '~/api/client';
import { useAgentAvatarState } from '~/components/agent/avatar/agent-live';
import { AvatarArt, avatarHue, avatarPhase } from '~/components/agent/avatar/avatar-art';
import { useAvatarStyle } from '~/components/agent/avatar/avatar-prefs';
import type { AvatarState } from '~/components/agent/avatar/states';
import { cn } from '~/lib/utils';

const SIZES = { sm: 24, md: 30, lg: 72 } as const;

/**
 * An agent's animated avatar, in the style this person chose, drawn from the
 * agent's own hue and showing what it is doing now (see avatar/states.ts).
 * Decorative: wherever it appears, the agent's name and status are text beside it.
 */
export function AgentAvatar({
  agent,
  size = 'md',
  state,
  frozen = false,
  className,
}: {
  agent: Pick<Agent, 'id' | 'enabled' | 'running'>;
  size?: keyof typeof SIZES | number;
  /** Show this state instead of the agent's own (an earlier reply, at rest). */
  state?: AvatarState;
  /** No motion: for the many avatars of a long conversation, only the latest moves. */
  frozen?: boolean;
  className?: string;
}) {
  const style = useAvatarStyle();
  const own = useAgentAvatarState(agent);
  return (
    <AvatarArt
      style={style}
      state={state ?? own}
      hue={avatarHue(agent.id)}
      phase={avatarPhase(agent.id)}
      size={typeof size === 'number' ? size : SIZES[size]}
      off={!agent.enabled}
      className={cn(frozen && 'av-frozen', className)}
    />
  );
}

/** Its runtime's state (awake, asleep, waking, failed) or "Disabled", for labels and tooltips. */
export function agentStatusLabel(
  agent: Pick<Agent, 'running' | 'enabled'> & Partial<Pick<Agent, 'status' | 'lastError'>>,
): string {
  if (!agent.enabled) return 'Disabled';
  if (agent.status === 'error')
    return agent.lastError ? `Couldn't start: ${agent.lastError}` : "Couldn't start";
  if (agent.status === 'starting') return 'Waking up';
  return agent.running ? 'Awake' : 'Asleep: wakes on your next message';
}

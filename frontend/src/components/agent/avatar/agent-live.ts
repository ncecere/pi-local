import { useSyncExternalStore } from 'react';
import { useInboxMetas } from '~/hooks/use-inbox';
import { isWorking } from '~/lib/inbox';
import { type AvatarSignals, type AvatarState, avatarStateOf, useDoneFlash } from './states';

/**
 * What the open conversation says about its agent right now. The conversation
 * on screen is the only one with a live stream, so it publishes here and every
 * avatar of that agent (sidebar, picker, replies) shows the same state. Agents
 * without an open conversation show what the platform's list says: awake or
 * asleep.
 */
export interface AgentLive {
  /** The stream is up, so the agent is awake whatever the (slower) list says. */
  connected: boolean;
  busy: boolean;
  runningTool: boolean;
  reconnecting: boolean;
  failed: boolean;
}

const live = new Map<string, AgentLive>();
const listeners = new Set<() => void>();

const same = (a: AgentLive, b: AgentLive) =>
  a.connected === b.connected &&
  a.busy === b.busy &&
  a.runningTool === b.runningTool &&
  a.reconnecting === b.reconnecting &&
  a.failed === b.failed;

/** Publish an agent's live state; `null` when its conversation is closed. */
export function publishAgentLive(agentId: string, value: AgentLive | null) {
  const before = live.get(agentId);
  if (value === null) {
    if (before === undefined) return;
    live.delete(agentId);
  } else if (before && same(before, value)) {
    return;
  } else {
    live.set(agentId, value);
  }
  for (const listener of listeners) listener();
}

/** For tests and non-React readers: call `listener` on every change; returns how to stop. */
export function subscribeAgentLive(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const readAgentLive = (agentId: string): AgentLive | undefined => live.get(agentId);

export function useAgentLive(agentId: string): AgentLive | undefined {
  return useSyncExternalStore(
    subscribeAgentLive,
    () => readAgentLive(agentId),
    () => undefined,
  );
}

/** The avatar signals for an agent: the platform's list, refined by its live conversation. */
export function signalsFor(
  agent: { enabled: boolean; running: boolean },
  state?: AgentLive,
): AvatarSignals {
  return {
    enabled: agent.enabled,
    running: agent.running || Boolean(state?.connected),
    busy: state?.busy,
    runningTool: state?.runningTool,
    reconnecting: state?.reconnecting,
    failed: state?.failed,
  };
}

/** An agent's avatar state, with a moment of "done" when it finishes work. */
export function useAgentAvatarState(agent: {
  id: string;
  enabled: boolean;
  running: boolean;
}): AvatarState {
  const state = useAgentLive(agent.id);
  // A conversation left while its reply is still being written keeps the agent
  // "working" (the inbox follows it), so leaving is not mistaken for finishing.
  const metas = useInboxMetas();
  const prefix = `${agent.id}/`;
  const now = Date.now();
  const elsewhere = Object.entries(metas).some(
    ([key, meta]) => key.startsWith(prefix) && isWorking(meta, now),
  );
  const signals = signalsFor(agent, state);
  if (elsewhere && !signals.busy) Object.assign(signals, { busy: true, running: true });
  return useDoneFlash(avatarStateOf(signals));
}

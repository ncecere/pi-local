import { useEffect, useRef, useState } from 'react';

/**
 * What an agent is doing, as its avatar shows it.
 *
 * - asleep: its runtime is hibernating; it wakes on the next message
 * - idle: awake and ready
 * - thinking: reasoning about a message
 * - working: a tool is running
 * - waiting: reconnecting to the agent (a dropped or stalled stream)
 * - attention: it replied and the reply has not been seen
 * - done: just finished a reply (a short flash, then back to rest)
 * - error: the last reply failed
 */
export const AVATAR_STATES = [
  'idle',
  'thinking',
  'working',
  'waiting',
  'attention',
  'done',
  'error',
  'asleep',
] as const;
export type AvatarState = (typeof AVATAR_STATES)[number];

export const STATE_INFO: Record<AvatarState, { label: string; short: string; when: string }> = {
  idle: { label: 'Idle', short: 'Ready', when: 'Awake and ready for your next message.' },
  thinking: {
    label: 'Thinking',
    short: 'Thinking…',
    when: 'Reasoning about your message, before or between tool calls.',
  },
  working: {
    label: 'Working',
    short: 'Working',
    when: 'A tool is running: a command, a file, a search.',
  },
  waiting: {
    label: 'Waiting',
    short: 'Reconnecting…',
    when: 'The connection to the agent dropped and is being restored.',
  },
  attention: {
    label: 'Needs you',
    short: 'Reply waiting',
    when: 'It replied while you were elsewhere, or it needs an approval.',
  },
  done: {
    label: 'Done',
    short: 'Done',
    when: 'It just finished a reply. A moment of pleasure, then rest.',
  },
  error: { label: 'Error', short: 'Failed', when: 'The last reply failed or was interrupted.' },
  asleep: {
    label: 'Asleep',
    short: 'Asleep',
    when: 'Hibernating to save resources. It wakes on your next message.',
  },
};

/** What the app knows about an agent right now. */
export interface AvatarSignals {
  /** The platform has not disabled the agent. */
  enabled: boolean;
  /** Its runtime is up (the platform hibernates idle agents). */
  running: boolean;
  /** A reply is being written in the conversation on screen. */
  busy?: boolean;
  /** A tool is running now. */
  runningTool?: boolean;
  /** Following the conversation dropped and is being retried. */
  reconnecting?: boolean;
  /** The last reply failed. */
  failed?: boolean;
  /** A finished reply has not been seen. */
  unread?: boolean;
}

/** The avatar's state, in order of how much it matters. */
export function avatarStateOf(signals: AvatarSignals): AvatarState {
  if (signals.failed) return 'error';
  if (signals.reconnecting) return 'waiting';
  if (signals.busy) return signals.runningTool ? 'working' : 'thinking';
  if (signals.unread) return 'attention';
  if (!signals.enabled || !signals.running) return 'asleep';
  return 'idle';
}

/** How long the "done" flash shows after a reply finishes. */
export const DONE_MS = 2600;

/** Whether the agent has just stopped working: busy, then at rest (or waiting for you). */
export function finishedWork(previous: AvatarState, next: AvatarState): boolean {
  return (
    (previous === 'thinking' || previous === 'working') &&
    (next === 'idle' || next === 'attention' || next === 'asleep')
  );
}

/** The state, with a moment of "done" when work ends. */
export function useDoneFlash(state: AvatarState): AvatarState {
  const previous = useRef(state);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const was = previous.current;
    previous.current = state;
    if (!finishedWork(was, state)) {
      setFlash(false);
      return;
    }
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), DONE_MS);
    return () => clearTimeout(timer);
  }, [state]);
  return flash ? 'done' : state;
}

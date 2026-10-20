import { useSyncExternalStore } from 'react';

/**
 * Whether the platform's event stream is connected (use-platform-events.ts).
 * While it is, the inbox hears replies start and end; when it is not, the
 * tracker in use-inbox.ts checks on them instead.
 */
let live = false;
const listeners = new Set<() => void>();

export function setEventsLive(value: boolean) {
  if (live === value) return;
  live = value;
  for (const listener of listeners) listener();
}

export const isEventsLive = () => live;

export function useEventsLive(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => live,
  );
}

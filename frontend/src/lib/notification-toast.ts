import { toast } from 'sonner';
import type { NotificationEvent } from '~/api/types';

/** The conversation's address. */
export const threadPathOf = (agentId: string, threadId: string) =>
  `/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}`;

/**
 * An agent's `notify_person` (a `notification` live event): a toast, "Ada:
 * Report ready", with the message under it and an Open button to the
 * conversation it came from. Nothing when that conversation is on screen:
 * the person is looking at it already. Returns whether a toast was shown.
 */
export function showNotification(
  data: string,
  {
    pathname,
    open,
  }: {
    /** The page now showing. */
    pathname: string;
    open: (agentId: string, threadId: string) => void;
  },
): boolean {
  let event: NotificationEvent;
  try {
    event = JSON.parse(data) as NotificationEvent;
  } catch {
    return false;
  }
  if (!event || typeof event.agentId !== 'string' || typeof event.title !== 'string') return false;
  const { agentId, threadId } = event;
  if (threadId && pathname === threadPathOf(agentId, threadId)) return false;
  const who = event.agentName || 'An agent';
  toast(`${who}: ${event.title}`, {
    duration: 10_000,
    ...(event.message ? { description: event.message } : {}),
    ...(threadId ? { action: { label: 'Open', onClick: () => open(agentId, threadId) } } : {}),
  });
  return true;
}

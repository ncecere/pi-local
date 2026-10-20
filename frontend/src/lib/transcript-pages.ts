import type { ChatMessage, ChatView } from '~/api/types';

/**
 * A long conversation opens on its latest messages (the stream's `limit`);
 * earlier ones are loaded a page at a time (`GET …/threads/{t}?limit=&before=`)
 * and kept here, before the live window the stream keeps up to date.
 */
export interface EarlierPages {
  /** Messages before the live window, oldest first. */
  messages: ChatMessage[];
  /** For the page before these (`before=`); undefined once the start is loaded. */
  cursor: string | undefined;
}

/** How many messages a page (and the stream's window) holds. */
export const TRANSCRIPT_PAGE = 100;

/** Where the next earlier page starts: before the loaded pages, else before the live window. */
export function earlierCursorOf(
  earlier: EarlierPages | null,
  view: ChatView | null,
): string | undefined {
  return earlier ? earlier.cursor : view?.earlierCursor;
}

/** The whole transcript shown: the loaded earlier pages, then the live window. */
export function withEarlier(view: ChatView | null, earlier: EarlierPages | null): ChatView | null {
  if (!view || !earlier || earlier.messages.length === 0) return view;
  return { ...view, messages: [...earlier.messages, ...view.messages] };
}

/**
 * A page loaded: put before what is held. Messages already held (the window
 * moved meanwhile) are not repeated.
 */
export function prependPage(
  earlier: EarlierPages | null,
  view: ChatView | null,
  page: Pick<ChatView, 'messages' | 'earlierCursor'>,
): EarlierPages {
  const held = new Set<string>();
  for (const message of earlier?.messages ?? []) held.add(message.id);
  for (const message of view?.messages ?? []) held.add(message.id);
  return {
    messages: [
      ...page.messages.filter((message) => !held.has(message.id)),
      ...(earlier?.messages ?? []),
    ],
    cursor: page.earlierCursor,
  };
}

/**
 * A new snapshot replaced the live window (a reconnect, or the transcript
 * changed in a way deltas can't say). What was shown before its first message
 * stays as earlier pages, so nothing the reader saw disappears; when the
 * snapshot no longer lines up with what was held (the conversation was reset
 * or compacted), the earlier pages are dropped and can be loaded again.
 */
export function rebaseEarlier(
  earlier: EarlierPages | null,
  previous: ChatView | null | undefined,
  next: ChatView,
): EarlierPages | null {
  if (next.earlierCursor === undefined) return null;
  const first = next.messages[0];
  if (!previous || !first) return null;
  const held = [...(earlier?.messages ?? []), ...previous.messages];
  const at = held.findIndex((message) => message.id === first.id);
  if (at < 0) return null;
  const cursor = earlier ? earlier.cursor : previous.earlierCursor;
  if (at === 0 && cursor === next.earlierCursor) return null;
  return { messages: held.slice(0, at), cursor };
}

import type { ChatMessage } from '~/api/types';
import { type PendingMessage, pendingIdOf } from '~/lib/chat-view';

/**
 * Editing a message and branching a conversation (docs/api.md, "Editing and
 * branching"): both make a new conversation with `POST …/fork`, which names
 * transcript messages by their IDs. On screen a message may have another
 * (lib/chat-view.ts): one sent from this tab keeps `pending-<requestId>`, and
 * a reply is `reply-<its question's on-screen id>`, made of several transcript
 * messages (its steps and tool results). These map one to the other.
 */

/** The API's limit on one message. */
const MESSAGE_MAX = 32_000;

/**
 * The transcript's ID of a user message shown with `onScreenId`; null when it
 * isn't in the transcript yet (still being sent) or isn't a user message.
 */
export function transcriptIdOf(
  onScreenId: string,
  pending: readonly Pick<PendingMessage, 'requestId' | 'matchedId'>[],
): string | null {
  if (onScreenId.startsWith('pending-')) {
    const sent = pending.find((message) => pendingIdOf(message) === onScreenId);
    return sent?.matchedId ?? null;
  }
  if (onScreenId.startsWith('reply-')) return null;
  return onScreenId;
}

/**
 * Where to branch for a reply shown as `replyId`: the transcript ID of the
 * reply's last message (its final step, or the last tool result of a reply
 * that was cut short), so the new conversation keeps the whole reply. Null
 * when the reply isn't (all) in the transcript.
 */
export function branchPointOf(
  transcript: readonly Pick<ChatMessage, 'id' | 'role'>[],
  replyId: string,
  pending: readonly Pick<PendingMessage, 'requestId' | 'matchedId'>[],
): string | null {
  if (!replyId.startsWith('reply-')) return null;
  const question = replyId.slice('reply-'.length);
  let start: number;
  if (question === 'start') start = 0;
  else {
    const questionId = transcriptIdOf(question, pending);
    if (!questionId) return null;
    const at = transcript.findIndex(
      (message) => message.role === 'user' && message.id === questionId,
    );
    if (at < 0) return null;
    start = at + 1;
  }
  let last: string | null = null;
  for (let index = start; index < transcript.length; index++) {
    const message = transcript[index]!;
    if (message.role === 'user') break;
    last = message.id;
  }
  return last;
}

/** Why an edited message can't be sent, or null. */
export function editProblem(original: string, edited: string): string | null {
  const text = edited.trim();
  if (!text) return 'Write the message.';
  if (text.length > MESSAGE_MAX)
    return `A message is at most ${MESSAGE_MAX.toLocaleString('en')} characters.`;
  if (text === original.trim()) return 'Change the message first.';
  return null;
}

// ── The composer of a branch, focused when it opens ─────────────────────────────────────────────

const FOCUS_KEY = 'pai.focus-composer';

/** Asks the conversation `threadId` to put the cursor in its message box when it opens. */
export function requestComposerFocus(threadId: string) {
  try {
    sessionStorage.setItem(FOCUS_KEY, threadId);
  } catch {
    // Storage blocked: it opens unfocused.
  }
}

/** Whether `threadId` was asked to focus its message box. */
export function peekComposerFocus(threadId: string): boolean {
  try {
    return sessionStorage.getItem(FOCUS_KEY) === threadId;
  } catch {
    return false;
  }
}

/** The request was met (or `threadId` opened without it): a reload doesn't focus again. */
export function clearComposerFocus(threadId: string) {
  try {
    if (sessionStorage.getItem(FOCUS_KEY) === threadId) sessionStorage.removeItem(FOCUS_KEY);
  } catch {
    // Nothing to clear.
  }
}

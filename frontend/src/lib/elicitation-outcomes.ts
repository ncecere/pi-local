import type { McpElicitation } from '~/api/types';

/**
 * Questions from an MCP server the person declined or dismissed. The server
 * then ends its call with an error of its own wording, and nothing in the
 * transcript says why; so the app notes the answer (it hears every
 * `elicitation` event), and a step whose call was open when the question was
 * asked reads "Declined" instead of "failed".
 *
 * Kept in this browser's storage, so a step still reads right after a reload.
 */

export interface ElicitationOutcome {
  agentId: string;
  threadId: string;
  /** The MCP server's slug. */
  server: string;
  /** The MCP tool (not prefixed), when known. */
  tool: string | null;
  /** When the question was asked (Unix ms): inside the call that waited for it. */
  askedAt: number;
}

const KEY = 'pai.elicitation-outcomes';
const KEEP = 200;
/** Clock slack between the runtime's timestamps and the app's. */
const SLACK_MS = 2_000;

let outcomes: ElicitationOutcome[] | null = null;
let version = 0;
const listeners = new Set<() => void>();

function load(): ElicitationOutcome[] {
  if (outcomes) return outcomes;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    outcomes = Array.isArray(parsed) ? (parsed as ElicitationOutcome[]) : [];
  } catch {
    outcomes = [];
  }
  return outcomes;
}

/** Notes a question the person declined or dismissed; anything else is ignored. */
export function noteElicitationAnswer(
  elicitation: Pick<
    McpElicitation,
    'state' | 'agentId' | 'threadId' | 'server' | 'tool' | 'createdAt'
  >,
) {
  if (elicitation.state !== 'declined' && elicitation.state !== 'cancelled') return;
  if (!elicitation.threadId) return;
  const list = load();
  const outcome: ElicitationOutcome = {
    agentId: elicitation.agentId,
    threadId: elicitation.threadId,
    server: elicitation.server,
    tool: elicitation.tool,
    askedAt: elicitation.createdAt,
  };
  if (
    list.some(
      (known) =>
        known.agentId === outcome.agentId &&
        known.threadId === outcome.threadId &&
        known.server === outcome.server &&
        known.askedAt === outcome.askedAt,
    )
  )
    return;
  outcomes = [...list, outcome].slice(-KEEP);
  try {
    localStorage.setItem(KEY, JSON.stringify(outcomes));
  } catch {
    // Storage full or off: the label only lasts until a reload.
  }
  version++;
  for (const listener of listeners) listener();
}

/** For useSyncExternalStore: a number that changes when an answer is noted. */
export const elicitationOutcomesVersion = () => version;
export function subscribeToElicitationOutcomes(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const NONE: readonly ElicitationOutcome[] = [];
const byThread = new Map<string, { version: number; list: readonly ElicitationOutcome[] }>();

/** The answers noted for one conversation (the same array until another is noted). */
export function elicitationOutcomesOf(agentId: string, threadId: string) {
  const key = `${agentId}/${threadId}`;
  const cached = byThread.get(key);
  if (cached && cached.version === version) return cached.list;
  const list = load().filter(
    (outcome) => outcome.agentId === agentId && outcome.threadId === threadId,
  );
  const result = list.length > 0 ? list : NONE;
  byThread.set(key, { version, list: result });
  return result;
}

/**
 * Whether a tool call (by its name and when it ran) was waiting for a
 * question that was declined or dismissed.
 */
export function waitedForDeclined(
  toolName: string,
  timing: { startedAt?: unknown; endedAt?: unknown } | undefined,
  list: readonly ElicitationOutcome[],
): boolean {
  if (list.length === 0) return false;
  const start = timing?.startedAt;
  const end = timing?.endedAt;
  if (typeof start !== 'number' || typeof end !== 'number') return false;
  return list.some((outcome) => {
    const named = outcome.tool
      ? toolName === `mcp__${outcome.server}__${outcome.tool}`
      : toolName.startsWith(`mcp__${outcome.server}__`);
    return named && outcome.askedAt >= start - SLACK_MS && outcome.askedAt <= end + SLACK_MS;
  });
}

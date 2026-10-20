import type { CalledBy } from '~/api/types';
import { toolDetailsOf, toolOutputText } from '~/lib/chat-view';

/**
 * Agents asking agents (docs/api.md, "Teams and agents asking agents"): an
 * agent's `ask_agent` and `list_agents` tool calls, and the conversations they
 * start in the asked agent, read back for the transcript and the sidebar.
 */

export const ASK_AGENT_TOOL = 'ask_agent';
export const LIST_AGENTS_TOOL = 'list_agents';

/** Where an ask went: `details` of an `ask_agent` call. */
export interface AskTarget {
  agentId: string;
  agentName: string;
  threadId: string;
}

/** An `ask_agent` call as the transcript shows it. */
export interface AskStep {
  kind: 'ask';
  /** The asked agent's name: from the result's details, else what the model passed. */
  agentName: string | null;
  /** The message sent (the call's `arguments.message`). */
  message: string | null;
  /** "new": the asked agent started fresh. */
  conversation: 'continue' | 'new' | null;
  /** The reply (the result's text), or the failure; null while it runs. */
  reply: string | null;
  /** The asked agent's conversation, when the result says. */
  target: AskTarget | null;
}

/** A `list_agents` call: who it may ask. */
export interface ListAgentsStep {
  kind: 'list';
  agents: { id: string; name: string }[] | null;
  /** The result's text. */
  text: string | null;
}

type PartLike = Record<string, unknown> & { type: string; toolMetadata?: unknown };

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** `{agentId, agentName, threadId}` from a tool's details, or null when they are not that. */
export function askTargetOf(details: unknown): AskTarget | null {
  if (!isRecord(details)) return null;
  const agentId = str(details.agentId);
  const threadId = str(details.threadId);
  if (!agentId || !threadId) return null;
  return { agentId, threadId, agentName: str(details.agentName) ?? agentId };
}

const toolNameOf = (part: PartLike) =>
  part.type === 'dynamic-tool' ? String(part.toolName ?? '') : part.type.slice('tool-'.length);

/** The ask (or list) a tool part is, or null for any other tool. */
export function askStepOf(part: PartLike): AskStep | ListAgentsStep | null {
  const name = toolNameOf(part);
  if (name === ASK_AGENT_TOOL) {
    const input = isRecord(part.input) ? part.input : {};
    const target = askTargetOf(toolDetailsOf(part));
    const running = part.state === 'input-available' || part.state === 'input-streaming';
    const conversation = input.conversation;
    return {
      kind: 'ask',
      agentName: target?.agentName ?? str(input.agent),
      message: str(input.message),
      conversation: conversation === 'new' || conversation === 'continue' ? conversation : null,
      // While it runs there is no reply yet: live output is not one.
      reply: running ? null : toolOutputText(part),
      target,
    };
  }
  if (name === LIST_AGENTS_TOOL) {
    const details = toolDetailsOf(part);
    const listed = isRecord(details) && Array.isArray(details.agents) ? details.agents : null;
    return {
      kind: 'list',
      agents: listed
        ? listed.filter(isRecord).flatMap((agent) => {
            const id = str(agent.id);
            return id ? [{ id, name: str(agent.name) ?? id }] : [];
          })
        : null,
      text: toolOutputText(part),
    };
  }
  return null;
}

/**
 * A one-line summary of an ask for the step's row and the work header:
 * "Asking Ada", "Asked Ada", "Asking Ada failed".
 */
export function askSummary(
  step: AskStep | ListAgentsStep,
  state: 'running' | 'done' | 'error' | string,
): string {
  if (step.kind === 'list')
    return state === 'running'
      ? 'Looking up agents to ask'
      : state === 'error'
        ? 'Looking up agents failed'
        : 'Looked up agents to ask';
  const who = step.agentName ?? 'an agent';
  if (state === 'running') return `Asking ${who}`;
  if (state === 'error') return `Asking ${who} failed`;
  return `Asked ${who}`;
}

/** "asked by Ada": a conversation another agent started, for the sidebar; null for a person's. */
export function calledByLabel(calledBy: CalledBy | null | undefined): string | null {
  if (!calledBy) return null;
  return `asked by ${calledBy.name || 'another agent'}`;
}

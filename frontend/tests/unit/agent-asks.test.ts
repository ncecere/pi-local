import { describe, expect, it } from 'vitest';
import type { ChatView } from '../../src/api/types.ts';
import { agentToolStep, type ToolPart } from '../../src/components/chat/tool-steps.tsx';
import { workSummary } from '../../src/components/chat/work-summary.ts';
import { askStepOf, askSummary, askTargetOf, calledByLabel } from '../../src/lib/agent-asks.ts';
import { viewToMessages } from '../../src/lib/chat-view.ts';

const askView = (result?: { text: string; isError?: boolean; details?: unknown }): ChatView => ({
  busy: !result,
  tools: result ? [] : [{ callId: 'c1', name: 'ask_agent', status: 'running' }],
  messages: [
    { id: 'u1', role: 'user', text: 'Find papers on X' },
    {
      id: 'a1',
      role: 'assistant',
      text: '',
      toolCalls: [
        {
          id: 'c1',
          name: 'ask_agent',
          arguments: { agent: 'ag_scout', message: 'Search arXiv for X', conversation: 'new' },
        },
      ],
    },
    ...(result
      ? [
          {
            id: 't1',
            role: 'tool' as const,
            toolCallId: 'c1',
            name: 'ask_agent',
            text: result.text,
            isError: result.isError ?? false,
            ...(result.details ? { details: result.details } : {}),
          },
        ]
      : []),
  ],
});

const toolPart = (view: ChatView) => {
  const reply = viewToMessages(view).find((message) => message.role === 'assistant')!;
  return reply.parts.find((part) => part.type === 'dynamic-tool') as unknown as ToolPart;
};

const DETAILS = { agentId: 'ag_scout', agentName: 'Scout', threadId: 'th-9' };

describe('ask_agent steps', () => {
  it('carries the result details to the tool part', () => {
    const part = toolPart(askView({ text: 'Three papers: …', details: DETAILS }));
    expect(askStepOf(part)).toEqual({
      kind: 'ask',
      agentName: 'Scout',
      message: 'Search arXiv for X',
      conversation: 'new',
      reply: 'Three papers: …',
      target: DETAILS,
    });
  });

  it("names the agent from the model's arguments until the result says who it was", () => {
    const step = askStepOf(toolPart(askView()));
    expect(step).toMatchObject({ kind: 'ask', agentName: 'ag_scout', reply: null, target: null });
  });

  it('keeps the timing it had with the details', () => {
    const view = askView({ text: 'ok', details: DETAILS });
    const call = view.messages[1]!;
    if (call.role === 'assistant') Object.assign(call.toolCalls![0]!, { startedAt: 1, endedAt: 5 });
    expect(toolPart(view).toolMetadata).toEqual({ startedAt: 1, endedAt: 5, details: DETAILS });
  });

  it('shows a failed ask with its reason and still links to the conversation', () => {
    const part = toolPart(
      askView({ text: 'Scout could not answer: boom', isError: true, details: DETAILS }),
    );
    expect(askStepOf(part)).toMatchObject({
      reply: 'Scout could not answer: boom',
      target: DETAILS,
    });
    expect(agentToolStep(part).summary).toBe('Asking Scout failed');
  });

  it('summarises asks in the step and the work header', () => {
    expect(agentToolStep(toolPart(askView({ text: 'ok', details: DETAILS }))).summary).toBe(
      'Asked Scout',
    );
    expect(agentToolStep(toolPart(askView())).summary).toBe('Asking ag_scout');
    const step = { toolId: 'ask_agent', label: 'ask_agent', state: 'done' as const };
    expect(workSummary({ reasoning: false, steps: [step] })).toBe('Asked an agent');
    expect(workSummary({ reasoning: true, steps: [step, step] })).toBe(
      'Thought · asked agents 2 times',
    );
  });

  it('leaves other tools alone', () => {
    expect(askStepOf({ type: 'dynamic-tool', toolName: 'bash', input: {} })).toBeNull();
  });
});

describe('list_agents steps', () => {
  it('reads who it may ask from the details', () => {
    const step = askStepOf({
      type: 'dynamic-tool',
      toolName: 'list_agents',
      state: 'output-available',
      input: {},
      output: { text: 'Agents you may ask: …' },
      toolMetadata: { details: { agents: [{ id: 'ag_a', name: 'Ada' }, { id: 7 }] } },
    });
    expect(step).toEqual({
      kind: 'list',
      agents: [{ id: 'ag_a', name: 'Ada' }],
      text: 'Agents you may ask: …',
    });
    expect(askSummary(step!, 'done')).toBe('Looked up agents to ask');
  });
});

describe('askTargetOf', () => {
  it('needs an agent and a thread', () => {
    expect(askTargetOf(DETAILS)).toEqual(DETAILS);
    expect(askTargetOf({ agentId: 'ag_a', threadId: 't' })).toEqual({
      agentId: 'ag_a',
      threadId: 't',
      agentName: 'ag_a',
    });
    expect(askTargetOf({ agentId: 'ag_a' })).toBeNull();
    expect(askTargetOf('nope')).toBeNull();
    expect(askTargetOf(null)).toBeNull();
  });
});

describe('calledByLabel', () => {
  it('says which agent asked', () => {
    expect(calledByLabel({ agentId: 'ag_a', name: 'Lead', threadId: 't' })).toBe('asked by Lead');
    expect(calledByLabel({ agentId: 'ag_a', name: '', threadId: 't' })).toBe(
      'asked by another agent',
    );
  });

  it('is null for a conversation a person started', () => {
    expect(calledByLabel(null)).toBeNull();
    expect(calledByLabel(undefined)).toBeNull();
  });
});

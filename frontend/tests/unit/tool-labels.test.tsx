// @vitest-environment happy-dom
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatView, McpElicitation } from '../../src/api/client';
import { agentToolStep, ToolStepRow, toolStepsOf } from '../../src/components/chat/tool-steps';
import { workSummary } from '../../src/components/chat/work-summary';
import { sentQuestion } from '../../src/hooks/use-chat-scroll';
import { applyElicitationData } from '../../src/hooks/use-elicitations';
import { toolOutputText, viewToMessages } from '../../src/lib/chat-view';
import { stripHarness } from '../../src/lib/diagnostics';
import { elicitationOutcomesOf, noteElicitationAnswer } from '../../src/lib/elicitation-outcomes';
import {
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

let view: Rendered | undefined;
beforeEach(() => localStorage.clear());
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const toolCall = (
  name: string,
  text: string,
  isError: boolean,
  startedAt = 1_000,
  endedAt = 5_000,
) =>
  ({
    busy: false,
    tools: [],
    messages: [
      { id: 'u1', role: 'user', text: 'Send it' },
      {
        id: 'a1',
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'c1', name, arguments: { to: 'Mehdi' }, startedAt, endedAt }],
      },
      { id: 't1', role: 'tool', toolCallId: 'c1', name, text, isError },
    ],
  }) satisfies ChatView;

const outcome = (change = {}) => ({
  agentId: 'ag_rex',
  threadId: 't1',
  server: 'crm',
  tool: 'send' as string | null,
  askedAt: 2_000,
  ...change,
});

const stepOf = (chat: ChatView, outcomes = [outcome()]) => {
  const reply = viewToMessages(chat, [], outcomes).at(-1)!;
  return toolStepsOf(reply)[0]!;
};

describe('a question the person declined', () => {
  const FAILED = toolCall('mcp__crm__send', 'not sent (decline)', true);

  it('makes the step read declined, not failed', () => {
    const { step, part } = stepOf(FAILED);
    expect(step.state).toBe('declined');
    expect(step.summary).toBe('mcp__crm__send was declined');
    expect(agentToolStep(part).state).toBe('declined');
  });

  it('still reads failed when no question was declined during the call', () => {
    expect(stepOf(FAILED, []).step.state).toBe('error');
    // A question declined at another time, or for another tool.
    expect(stepOf(FAILED, [outcome({ askedAt: 9_000 })]).step.state).toBe('error');
    expect(stepOf(FAILED, [outcome({ tool: 'delete' })]).step.state).toBe('error');
    expect(stepOf(FAILED, [outcome({ server: 'mail' })]).step.state).toBe('error');
  });

  it('matches by server alone when the question did not say which tool', () => {
    expect(stepOf(FAILED, [outcome({ tool: null })]).step.state).toBe('declined');
  });

  it('never turns a call that worked into a declined one', () => {
    expect(stepOf(toolCall('mcp__crm__send', 'sent', false)).step.state).toBe('done');
  });

  it('is noted from the answer, for declined and dismissed questions only', () => {
    const question = (state: McpElicitation['state']): McpElicitation => ({
      id: 'el_1',
      agentId: 'ag_rex',
      agentName: 'Rex',
      threadId: 't1',
      server: 'crm',
      serverName: 'CRM',
      tool: 'send',
      message: 'Send it?',
      requestedSchema: { type: 'object', properties: {} },
      state,
      createdAt: 2_000,
      expiresAt: 9_000,
    });
    const queryClient = new QueryClient();
    applyElicitationData(queryClient, JSON.stringify(question('accepted')));
    expect(elicitationOutcomesOf('ag_rex', 't1')).toHaveLength(0);
    applyElicitationData(queryClient, JSON.stringify(question('declined')));
    expect(elicitationOutcomesOf('ag_rex', 't1')).toHaveLength(1);
    noteElicitationAnswer({ ...question('cancelled'), createdAt: 3_000 });
    expect(elicitationOutcomesOf('ag_rex', 't1')).toHaveLength(2);
    // The same one again, as the event and the answer both say it.
    noteElicitationAnswer({ ...question('cancelled'), createdAt: 3_000 });
    expect(elicitationOutcomesOf('ag_rex', 't1')).toHaveLength(2);
    expect(elicitationOutcomesOf('ag_rex', 'other')).toHaveLength(0);
    // Kept for a reload.
    expect(JSON.parse(localStorage.getItem('pai.elicitation-outcomes') ?? '[]')).toHaveLength(2);
  });

  it('shows "Declined" on the step, in plain words', async () => {
    fakeBackend({ 'GET /api/agents': () => [] });
    const { part, step } = stepOf(FAILED);
    view = await renderWithQuery(<ToolStepRow part={part} step={step} />);
    await settle();
    expect(view.container.textContent).toContain('Declined');
    expect(view.container.textContent).not.toMatch(/failed/i);
  });
});

describe('the work summary', () => {
  const step = (state: 'declined' | 'denied' | 'error') => ({
    toolId: 'bash',
    label: 'bash',
    state,
  });
  it('says denied for a denied step, where it said "a step was not run"', () => {
    expect(workSummary({ reasoning: false, steps: [step('denied')] })).toBe('Denied');
    expect(workSummary({ reasoning: true, steps: [step('denied')] })).toBe('Thought · denied');
    expect(workSummary({ reasoning: false, steps: [step('denied'), step('denied')] })).toBe(
      '2 steps denied',
    );
  });
  it('says declined for a declined question', () => {
    expect(workSummary({ reasoning: false, steps: [step('declined')] })).toBe('Declined');
    expect(workSummary({ reasoning: false, steps: [step('declined'), step('declined')] })).toBe(
      '2 steps declined',
    );
  });
  it('keeps failed for what failed', () => {
    expect(workSummary({ reasoning: false, steps: [step('error')] })).toBe('A step failed');
  });
});

describe('a denied tool', () => {
  it('reads denied on its row', async () => {
    const chat: ChatView = {
      busy: false,
      tools: [],
      messages: [
        { id: 'u1', role: 'user', text: 'Clean up' },
        {
          id: 'a1',
          role: 'assistant',
          text: '',
          toolCalls: [
            {
              id: 'c1',
              name: 'bash',
              arguments: { command: 'rm -rf tmp' },
              approval: {
                id: 'ap_1',
                callId: 'c1',
                tool: 'bash',
                status: 'denied',
                requestedAt: 1,
                reason: 'not now',
              },
            },
          ],
        },
      ],
    };
    fakeBackend({ 'GET /api/agents': () => [] });
    const { part, step } = toolStepsOf(viewToMessages(chat).at(-1)!)[0]!;
    expect(step.state).toBe('denied');
    expect(step.summary).toContain('was denied');
    view = await renderWithQuery(<ToolStepRow part={part} step={step} />);
    await settle();
    expect(view.container.textContent).toContain('Denied');
    expect(view.container.textContent).not.toContain('not run');
  });
});

describe('the harness wrapper', () => {
  const WRAPPED = '<harness>\n[error] Tool call denied: bash needs approval.\n</harness>';

  it('is stripped, keeping the diagnostics’ words', () => {
    expect(stripHarness(WRAPPED)).toBe('Tool call denied: bash needs approval.');
    expect(stripHarness(`Done.\n${WRAPPED}`)).toBe('Done.\nTool call denied: bash needs approval.');
    expect(
      stripHarness('<harness>\n[warning] Output was cut.\n[info] 3 lines left out.\n</harness>'),
    ).toBe('Output was cut.\n3 lines left out.');
    expect(stripHarness('a <harness> left open')).toBe('a  left open');
    expect(stripHarness('plain text')).toBe('plain text');
  });

  it('never shows in a tool’s output, or in what is copied from it', async () => {
    const chat = toolCall('bash', `partial\n${WRAPPED}`, true);
    const { part, step } = toolStepsOf(viewToMessages(chat).at(-1)!)[0]!;
    expect(toolOutputText(part)).toBe('partial\nTool call denied: bash needs approval.');

    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fakeBackend({ 'GET /api/agents': () => [] });
    view = await renderWithQuery(<ToolStepRow part={part} step={step} />);
    await settle();
    view.container.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click();
    await settle();
    expect(view.container.textContent).toContain('Tool call denied: bash needs approval.');
    expect(view.container.textContent).not.toContain('harness');
    view.container.querySelector<HTMLButtonElement>('button[aria-label="Copy output"]')?.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith('partial\nTool call denied: bash needs approval.');
  });

  it('does not turn a result with only diagnostics into an empty one', () => {
    const chat = toolCall('bash', WRAPPED, true);
    const { part } = toolStepsOf(viewToMessages(chat).at(-1)!)[0]!;
    expect(toolOutputText(part)).toBe('Tool call denied: bash needs approval.');
  });
});

describe('steering while a reply streams', () => {
  const user = (id: string, steer = false) => ({
    id,
    role: 'user' as const,
    parts: [{ type: 'text' as const, text: id }],
    ...(steer ? { metadata: { pending: 'queued' as const, steer: true } } : {}),
  });
  const reply = { id: 'r1', role: 'assistant' as const, parts: [] };

  it('is no new question to pin to the top: the streaming reply stays in sight', () => {
    expect(sentQuestion([user('q1'), reply, user('q2', true)], 1)).toBe(false);
  });
  it('still pins a question that was sent, and queued ones', () => {
    expect(sentQuestion([user('q1'), reply, user('q2')], 1)).toBe(true);
  });
  it('is nothing when no message was added', () => {
    expect(sentQuestion([user('q1'), reply], 1)).toBe(false);
  });
});

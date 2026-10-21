// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatView } from '../../src/api/client';
import { agentToolStep, ToolStepRow, toolStepsOf } from '../../src/components/chat/tool-steps';
import { type WorkStep, workSummary } from '../../src/components/chat/work-summary';
import { viewToMessages } from '../../src/lib/chat-view';
import {
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

/** A finished tool call and its result, as the transcript carries them. */
function call(name: string, args: unknown, text: string, details?: unknown, isError = false) {
  const chat: ChatView = {
    busy: false,
    tools: [],
    messages: [
      { id: 'u1', role: 'user', text: 'Go' },
      {
        id: 'a1',
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'c1', name, arguments: args, startedAt: 1_000, endedAt: 2_000 }],
      },
      {
        id: 't1',
        role: 'tool',
        toolCallId: 'c1',
        name,
        text,
        isError,
        ...(details === undefined ? {} : { details }),
      },
    ],
  };
  return toolStepsOf(viewToMessages(chat).at(-1)!)[0]!;
}

/** A call still running: no result yet. */
function running(name: string, args: unknown) {
  const chat: ChatView = {
    busy: true,
    tools: [],
    messages: [
      { id: 'u1', role: 'user', text: 'Go' },
      {
        id: 'a1',
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'c1', name, arguments: args, startedAt: 1_000 }],
      },
    ],
  };
  return toolStepsOf(viewToMessages(chat).at(-1)!)[0]!;
}

const QUESTION = 'Which time of day?';
const choices = { question: QUESTION, choices: ['Morning', 'Evening'] };

describe('"Asked you" steps', () => {
  it('say what was asked and the answer, from the result details', () => {
    const { step } = call('ask_person', choices, 'They answered: Morning', {
      question: QUESTION,
      outcome: 'answered',
      answer: 'Morning',
    });
    expect(step.summary).toBe('Asked you: Which time of day? · Answered "Morning"');
    expect(step.state).toBe('done');
  });

  it('say yes or no for a confirmation', () => {
    const yes = call(
      'ask_person',
      { question: 'Shall I go ahead?', yes_no: true },
      'They answered: yes.',
      {
        question: 'Shall I go ahead?',
        outcome: 'answered',
        answer: true,
      },
    );
    expect(yes.step.summary).toBe('Asked you: Shall I go ahead? · Answered yes');
    const no = call(
      'ask_person',
      { question: 'Shall I go ahead?', yes_no: true },
      'They answered: no.',
      {
        question: 'Shall I go ahead?',
        outcome: 'answered',
        answer: false,
      },
    );
    expect(no.step.summary).toBe('Asked you: Shall I go ahead? · Answered no');
  });

  it('say Declined, and are declined steps for the work header too', () => {
    const { step, part } = call('ask_person', choices, 'They declined to answer.', {
      question: QUESTION,
      outcome: 'declined',
    });
    expect(step.summary).toBe('Asked you: Which time of day? · Declined');
    expect(step.state).toBe('declined');
    expect(agentToolStep(part).state).toBe('declined');
    const work: WorkStep = { toolId: step.toolId, label: step.label, state: step.state };
    expect(workSummary({ reasoning: false, steps: [work] })).toBe('Declined');
    expect(workSummary({ reasoning: true, steps: [work] })).toBe('Thought · declined');
  });

  it('say No answer when nobody answered', () => {
    const { step } = call(
      'ask_person',
      choices,
      'Nobody answered (the question expired or was dismissed).',
      {
        question: QUESTION,
        outcome: 'expired',
      },
    );
    expect(step.summary).toBe('Asked you: Which time of day? · No answer');
  });

  it('read older replies, with no details, from the result text', () => {
    expect(call('ask_person', choices, 'They answered: Evening').step.summary).toBe(
      'Asked you: Which time of day? · Answered "Evening"',
    );
    expect(
      call('ask_person', { question: 'Go on?', yes_no: true }, 'They answered: yes.').step.summary,
    ).toBe('Asked you: Go on? · Answered yes');
    const declined = call('ask_person', choices, 'They declined to answer.');
    expect(declined.step.summary).toBe('Asked you: Which time of day? · Declined');
    expect(declined.step.state).toBe('declined');
    expect(
      call('ask_person', choices, 'Nobody answered (the question expired).').step.summary,
    ).toBe('Asked you: Which time of day? · No answer');
  });

  it('read "Asking you" while the question waits', () => {
    expect(running('ask_person', choices).step.summary).toBe('Asking you: Which time of day?');
  });

  it('show on the row in plain words, never as the tool name', async () => {
    fakeBackend({ 'GET /api/agents': () => [] });
    const { part, step } = call('ask_person', choices, 'They declined to answer.', {
      question: QUESTION,
      outcome: 'declined',
    });
    view = await renderWithQuery(<ToolStepRow part={part} step={step} />);
    await settle();
    const text = view.container.textContent ?? '';
    expect(text).toContain('Asked you: Which time of day? · Declined');
    expect(text).not.toContain('ask_person');
    // Said once, not again beside it.
    expect(text.match(/Declined/g)).toHaveLength(1);
  });
});

describe("the agent's other tools", () => {
  it('read as what they did', () => {
    const summary = (name: string, args: unknown, text = 'ok') =>
      call(name, args, text).step.summary;
    expect(summary('todo', { items: [{ text: 'a', status: 'done' }] })).toBe(
      'Updated the checklist',
    );
    expect(summary('notify_person', { title: 'Report ready', message: 'Done.' })).toBe(
      'Notified you: Report ready',
    );
    expect(summary('bash', { command: 'ls -la' })).toBe('Ran ls -la');
    expect(summary('read', { path: '/work/docs/notes.md' })).toBe('Read notes.md');
    expect(summary('write', { path: 'out/plan.md', content: 'x' })).toBe('Wrote plan.md');
    expect(summary('web_search', { query: 'sea otters' })).toBe('Searched the web: sea otters');
  });

  it('keep a long command short, on one line', () => {
    const { summary } = call('bash', { command: `echo ${'a'.repeat(100)}\nrm x` }, 'ok').step;
    expect(summary.startsWith('Ran echo aaaa')).toBe(true);
    expect(summary).not.toContain('\n');
    expect(summary.length).toBeLessThanOrEqual(64);
  });

  it('read in the present while running, and say when they failed', () => {
    expect(running('bash', { command: 'make' }).step.summary).toBe('Running make');
    expect(running('web_search', { query: 'otters' }).step.summary).toBe(
      'Searching the web: otters',
    );
    expect(running('todo', { items: [] }).step.summary).toBe('Updating the checklist');
    expect(call('bash', { command: 'make' }, 'boom', undefined, true).step.summary).toBe(
      'Running make failed',
    );
  });

  it('leave any other tool as it was', () => {
    expect(call('get_time', { zone: 'Asia/Tokyo' }, '9:00').step.summary).toBe(
      'get_time · Asia/Tokyo',
    );
  });

  it('are counted in words in the work header', () => {
    const step = (toolId: string): WorkStep => ({ toolId, label: toolId, state: 'done' });
    expect(workSummary({ reasoning: false, steps: [step('todo')] })).toBe('Updated the checklist');
    expect(workSummary({ reasoning: false, steps: [step('bash'), step('bash')] })).toBe(
      'Ran 2 commands',
    );
    expect(workSummary({ reasoning: false, steps: [step('ask_person')] })).toBe(
      'Asked you a question',
    );
    expect(workSummary({ reasoning: true, steps: [step('notify_person')] })).toBe(
      'Thought · notified you',
    );
  });
});

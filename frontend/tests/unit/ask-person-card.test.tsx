// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpElicitation } from '../../src/api/client';
import { ElicitationCard } from '../../src/components/chat/elicitation-card';
import { choiceField, isAgentQuestion } from '../../src/lib/elicitations';
import {
  buttonByText,
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  typeInto,
} from './ui-test-utils';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }),
}));

const NOW = Date.now();
const ANSWER = '/api/elicitations/el_9';

/** What the agent's `ask_person` makes (runtime/src/lib/person.ts). */
function question(
  requestedSchema: McpElicitation['requestedSchema'],
  message = 'Should I overwrite the old report?',
): McpElicitation {
  return {
    id: 'el_9',
    agentId: 'ag_rex',
    agentName: 'Rex',
    threadId: 't1',
    server: 'agent',
    serverName: 'Rex',
    tool: 'ask_person',
    message,
    requestedSchema,
    state: 'pending',
    createdAt: NOW,
    expiresAt: NOW + 15 * 60_000,
  };
}

const YES_NO: McpElicitation['requestedSchema'] = {
  type: 'object',
  properties: { yes: { type: 'boolean', title: 'Yes', default: false } },
  required: ['yes'],
};
const CHOICES: McpElicitation['requestedSchema'] = {
  type: 'object',
  properties: {
    answer: { type: 'string', title: 'Your answer', enum: ['Markdown', 'Word', 'PDF'] },
  },
  required: ['answer'],
};
const TEXT: McpElicitation['requestedSchema'] = {
  type: 'object',
  properties: { answer: { type: 'string', title: 'Your answer', maxLength: 2000 } },
  required: ['answer'],
};

const posts = (backend: ReturnType<typeof fakeBackend>) =>
  backend.calls.filter((call) => call.method === 'POST' && call.path === ANSWER);
const text = () => document.body.textContent ?? '';

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

describe("An agent's question (ask_person)", () => {
  it('reads as the agent asking, without MCP wording', async () => {
    fakeBackend();
    view = await renderWithQuery(<ElicitationCard elicitation={question(YES_NO)} />);
    expect(text()).toContain('Rex asks you');
    expect(text()).toContain('Should I overwrite the old report?');
    expect(text()).not.toMatch(/server|while running|ask_person/i);
    expect(document.querySelector('section[aria-label="Rex\'s question"]')).not.toBeNull();
  });

  it('still names the server for an MCP server', async () => {
    fakeBackend();
    view = await renderWithQuery(
      <ElicitationCard
        elicitation={{
          ...question(YES_NO),
          server: 'm365',
          serverName: 'Microsoft 365',
          tool: 'send',
        }}
      />,
    );
    expect(text()).toContain('Microsoft 365 asks');
    expect(text()).toContain('while running send');
  });

  it('is told apart from an MCP server by its server and tool', () => {
    expect(isAgentQuestion(question(YES_NO))).toBe(true);
    expect(isAgentQuestion({ server: 'm365', tool: 'ask_person' })).toBe(false);
    expect(isAgentQuestion({ server: 'agent', tool: null })).toBe(false);
  });
});

describe('A yes/no question', () => {
  it('is Yes and No buttons: Yes accepts with yes true', async () => {
    const backend = fakeBackend({ [`POST ${ANSWER}`]: () => ({}) });
    view = await renderWithQuery(<ElicitationCard elicitation={question(YES_NO)} />);
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(buttonByText('Accept')).toBeUndefined();
    expect(buttonByText('Decline')).toBeUndefined();
    expect(buttonByText('Cancel')).toBeUndefined();

    await click(buttonByText('Yes'));
    expect(posts(backend).map((call) => call.body)).toEqual([
      { action: 'accept', content: { yes: true } },
    ]);
    expect(text()).toContain('Answered yes');
  });

  it('No sends decline', async () => {
    const backend = fakeBackend({ [`POST ${ANSWER}`]: () => ({}) });
    view = await renderWithQuery(<ElicitationCard elicitation={question(YES_NO)} />);
    await click(buttonByText('No'));
    expect(posts(backend).map((call) => call.body)).toEqual([{ action: 'decline' }]);
    expect(text()).toContain('Answered no');
  });
});

describe('A question with choices', () => {
  it('is one button per choice, and a choice is the answer', async () => {
    const backend = fakeBackend({ [`POST ${ANSWER}`]: () => ({}) });
    view = await renderWithQuery(
      <ElicitationCard elicitation={question(CHOICES, 'Which format do you want?')} />,
    );
    expect(document.querySelector('select')).toBeNull();
    const choices = [...document.querySelectorAll('[data-elicitation-choice]')];
    expect(choices.map((button) => button.textContent?.trim())).toEqual([
      'Markdown',
      'Word',
      'PDF',
    ]);

    await click(buttonByText('Word'));
    expect(posts(backend).map((call) => call.body)).toEqual([
      { action: 'accept', content: { answer: 'Word' } },
    ]);
    expect(text()).toContain('Sent your answer');
  });

  it('can be declined', async () => {
    const backend = fakeBackend({ [`POST ${ANSWER}`]: () => ({}) });
    view = await renderWithQuery(<ElicitationCard elicitation={question(CHOICES)} />);
    await click(buttonByText('Decline'));
    expect(posts(backend).map((call) => call.body)).toEqual([{ action: 'decline' }]);
  });

  it('reads the options of a lone choice field, with their names', () => {
    expect(choiceField(CHOICES)?.options.map((option) => option.value)).toEqual([
      'Markdown',
      'Word',
      'PDF',
    ]);
    expect(
      choiceField({
        type: 'object',
        properties: { a: { type: 'string', enum: ['x', 'y'], enumNames: ['Ex', 'Why'] } },
      })?.options,
    ).toEqual([
      { value: 'x', label: 'Ex' },
      { value: 'y', label: 'Why' },
    ]);
    expect(choiceField(TEXT)).toBeNull();
    expect(choiceField(YES_NO)).toBeNull();
  });
});

describe('An open question', () => {
  it('is a text field and Send', async () => {
    const backend = fakeBackend({ [`POST ${ANSWER}`]: () => ({}) });
    view = await renderWithQuery(
      <ElicitationCard elicitation={question(TEXT, 'What should the report be called?')} />,
    );
    expect(buttonByText('Accept')).toBeUndefined();
    await typeInto(document.querySelector('textarea, input[type="text"]'), 'Q3 summary');
    await click(buttonByText('Send'));
    expect(posts(backend).map((call) => call.body)).toEqual([
      { action: 'accept', content: { answer: 'Q3 summary' } },
    ]);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/api/types';
import { viewToMessages } from '../../src/lib/chat-view';
import {
  branchPointOf,
  clearComposerFocus,
  editProblem,
  peekComposerFocus,
  requestComposerFocus,
  transcriptIdOf,
} from '../../src/lib/fork';

const transcript: ChatMessage[] = [
  { id: 'a0', role: 'assistant', text: 'Hello, I am your helper.' },
  { id: 'u1', role: 'user', text: 'First question' },
  {
    id: 'a1',
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'c1', name: 'bash', arguments: {} }],
  },
  { id: 't1', role: 'tool', toolCallId: 'c1', name: 'bash', text: 'ok', isError: false },
  { id: 'a2', role: 'assistant', text: 'First answer' },
  { id: 'u2', role: 'user', text: 'Second question', requestId: 'req-2' },
  { id: 'a3', role: 'assistant', text: 'Second answer' },
  { id: 'u3', role: 'user', text: 'Unanswered' },
];

const pending = [{ requestId: 'req-2', matchedId: 'u2' }];

describe('transcriptIdOf', () => {
  it('is the id itself for a message from the transcript', () => {
    expect(transcriptIdOf('u1', [])).toBe('u1');
  });

  it('maps a message sent from this tab to its transcript id once it is there', () => {
    expect(transcriptIdOf('pending-req-2', pending)).toBe('u2');
    expect(transcriptIdOf('pending-req-9', [{ requestId: 'req-9' }])).toBeNull();
  });

  it('is null for a reply (not a user message)', () => {
    expect(transcriptIdOf('reply-u1', [])).toBeNull();
  });
});

describe('branchPointOf', () => {
  it('branches after the last message of the reply, steps and tool results included', () => {
    expect(branchPointOf(transcript, 'reply-u1', [])).toBe('a2');
    expect(branchPointOf(transcript, 'reply-start', [])).toBe('a0');
  });

  it('finds a reply to a message sent from this tab', () => {
    expect(branchPointOf(transcript, 'reply-pending-req-2', pending)).toBe('a3');
  });

  it('is null for what is not a finished reply in the transcript', () => {
    expect(branchPointOf(transcript, 'reply-u3', [])).toBeNull();
    expect(branchPointOf(transcript, 'reply-gone', [])).toBeNull();
    expect(branchPointOf(transcript, 'u1', [])).toBeNull();
  });

  it('agrees with the ids the chat view gives replies', () => {
    const shown = viewToMessages({ busy: false, tools: [], messages: transcript });
    const replies = shown.filter((message) => message.role === 'assistant').map((m) => m.id);
    expect(replies.map((id) => branchPointOf(transcript, id, []))).toEqual(['a0', 'a2', 'a3']);
    const users = shown.filter((message) => message.role === 'user').map((m) => m.id);
    expect(users.map((id) => transcriptIdOf(id, []))).toEqual(['u1', 'u2', 'u3']);
  });
});

describe('editProblem', () => {
  it('needs a changed, non-empty message within the limit', () => {
    expect(editProblem('Hello', 'Hello there')).toBeNull();
    expect(editProblem('Hello', '  Hello ')).toMatch(/Change/);
    expect(editProblem('Hello', '   ')).toMatch(/Write/);
    expect(editProblem('Hello', 'x'.repeat(32_001))).toMatch(/32,000/);
  });
});

describe('the composer focus of a new branch', () => {
  beforeEach(() => sessionStorage.clear());

  it('is asked for one conversation, and cleared once used', () => {
    requestComposerFocus('t-new');
    expect(peekComposerFocus('t-other')).toBe(false);
    expect(peekComposerFocus('t-new')).toBe(true);
    clearComposerFocus('t-other');
    expect(peekComposerFocus('t-new')).toBe(true);
    clearComposerFocus('t-new');
    expect(peekComposerFocus('t-new')).toBe(false);
  });
});

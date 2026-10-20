import { describe, expect, it } from 'vitest';
import type { Agent, AgentThread } from '../../src/api/client';
import { applyAgentEvent } from '../../src/hooks/use-agents';
import { applyThreadEvent } from '../../src/hooks/use-platform-events';

const thread = (threadId: string, title = threadId): AgentThread => ({
  threadId,
  title,
  createdAt: 1,
  updatedAt: 1,
  busy: false,
  visibility: 'shared',
  participants: [],
});

describe('applyThreadEvent', () => {
  const list = [thread('a'), thread('b')];

  it('replaces a conversation in place', () => {
    const next = applyThreadEvent(list, {
      threadId: 'b',
      deleted: false,
      thread: { ...thread('b'), busy: true },
    });
    expect(next?.map((t) => [t.threadId, t.busy])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  it('adds a new conversation at the top', () => {
    expect(
      applyThreadEvent(list, { threadId: 'c', deleted: false, thread: thread('c') })?.map(
        (t) => t.threadId,
      ),
    ).toEqual(['c', 'a', 'b']);
  });

  it('removes a deleted one', () => {
    expect(
      applyThreadEvent(list, { threadId: 'a', deleted: true })?.map((t) => t.threadId),
    ).toEqual(['b']);
  });

  it('leaves a list that was never loaded alone', () => {
    expect(
      applyThreadEvent(undefined, { threadId: 'a', deleted: false, thread: thread('a') }),
    ).toBeUndefined();
  });
});

describe('applyAgentEvent', () => {
  const agent = (id: string, status: Agent['status'] = 'asleep'): Agent => ({
    id,
    name: id,
    description: '',
    instructions: '',
    kind: 'personal',
    agentKind: 'assistant',
    status,
    running: status === 'awake',
    model: null,
    enabled: true,
    lastUsedAt: null,
    revision: 1,
    createdAt: '2026-10-20T00:00:00Z',
    updatedAt: '2026-10-20T00:00:00Z',
  });
  const list = [agent('ag_b'), agent('ag_a')];

  it('updates an agent in place (its status, say)', () => {
    const next = applyAgentEvent(list, 'ag_a', agent('ag_a', 'awake'));
    expect(next?.map((a) => [a.id, a.status])).toEqual([
      ['ag_b', 'asleep'],
      ['ag_a', 'awake'],
    ]);
  });

  it('adds a new agent at the top (newest first)', () => {
    expect(applyAgentEvent(list, 'ag_c', agent('ag_c'))?.map((a) => a.id)).toEqual([
      'ag_c',
      'ag_b',
      'ag_a',
    ]);
  });

  it('removes a deleted one', () => {
    expect(applyAgentEvent(list, 'ag_b', null)?.map((a) => a.id)).toEqual(['ag_a']);
  });

  it('leaves a list that was never loaded alone', () => {
    expect(applyAgentEvent(undefined, 'ag_a', agent('ag_a'))).toBeUndefined();
  });
});

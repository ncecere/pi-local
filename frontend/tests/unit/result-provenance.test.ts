import { describe, expect, it, vi } from 'vitest';
import type { ChatApproval, ChatView } from '~/api/client';
import { approvalOf, viewToMessages } from '~/lib/chat-view';
import { CallIdentityReader } from '../../../runtime/src/lib/call-identity';
import { buildView } from '../../../runtime/src/lib/view';

type Entry = Parameters<CallIdentityReader['read']>[0][number];
const assistant = (id: number, command: string): Entry =>
  ({
    id,
    conversationId: 1,
    kind: 'pi.assistant',
    byTaskId: id + 100,
    model: [
      {
        role: 'assistant',
        timestamp: id * 100,
        durationMs: 7,
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'reused', name: 'bash', arguments: { command } }],
      },
    ],
  }) as never;
const result = (id: number, text: string, task?: number): Entry =>
  ({
    id,
    conversationId: 1,
    kind: 'pi.tool-result',
    ...(task === undefined ? {} : { byTaskId: task }),
    model: [
      {
        role: 'toolResult',
        toolCallId: 'reused',
        toolName: 'bash',
        timestamp: id * 100,
        isError: false,
        content: [{ type: 'text', text }],
      },
    ],
  }) as never;
const partsOf = (view: ChatView) =>
  viewToMessages(view)
    .flatMap((m) => m.parts)
    .filter((p) => p.type === 'dynamic-tool');

for (const missing of ['byTaskId', 'getTask'] as const) {
  for (const separateReply of [false, true]) {
    it(`actual runtime reader/view: ${missing} absent, repeated IDs in ${separateReply ? 'different replies' : 'one reply'}`, async () => {
      const getTask = vi.fn(async (id: number) =>
        id === 20 || id === 22
          ? {
              kind: 'pi.tool',
              input: { kind: 'model', assistant: id === 20 ? 2 : 6, callId: 'reused' },
            }
          : undefined,
      );
      const reader = new CallIdentityReader({ getTask } as never);
      const entries: Entry[] = [
        assistant(2, 'echo A'),
        result(3, 'A done', 20),
        ...(separateReply
          ? [
              {
                id: 35,
                conversationId: 1,
                kind: 'pi.user',
                model: [{ role: 'user', content: 'Next', timestamp: 350 }],
              } as unknown as Entry,
            ]
          : []),
        assistant(4, 'echo B'),
        result(5, 'B done', missing === 'getTask' ? 21 : undefined),
        assistant(6, 'echo C'),
      ];
      const live = {
        run: { taskId: 106, inputs: [] },
        tools: [{ callId: 'reused', taskId: 22, name: 'bash', status: 'pending' }],
      } as never;
      const pending: ChatApproval = {
        id: 'ap_C',
        callId: 'reused',
        taskId: 't22',
        tool: 'bash',
        status: 'pending',
        requestedAt: 1,
        arguments: { command: 'echo C exact' },
      };
      const identities = await reader.read(entries, live);
      expect(identities.results.has('e5')).toBe(false);
      const view = buildView(
        entries,
        live,
        undefined,
        { byTask: new Map([['t22', pending]]), pending: [pending] },
        identities,
      );
      expect(view.messages.find((m) => m.id === 'e5')).not.toHaveProperty('instanceId');
      const calls = view.messages.flatMap((m) =>
        m.role === 'assistant' ? (m.toolCalls ?? []) : [],
      );
      expect(calls[1]?.instanceId).toBe('e4/tool/reused');
      const parts = partsOf(view);
      expect(parts).toHaveLength(3);
      expect(parts[0]).toMatchObject({
        state: 'output-available',
        input: { command: 'echo A' },
        output: { text: 'A done' },
      });
      expect(parts[1]).toMatchObject({
        state: 'output-available',
        input: { command: 'echo B' },
        output: { text: 'B done' },
        toolMetadata: { startedAt: 407 },
      });
      expect(approvalOf(parts[1]!)).toBeNull();
      expect(parts[2]).toMatchObject({
        state: 'approval-requested',
        approval: { id: 'ap_C' },
        input: { command: 'echo C' },
      });
      expect(approvalOf(parts[2]!)).toEqual(pending);
      expect(new Set(parts.map((p) => p.toolCallId)).size).toBe(3);
      if (missing === 'getTask') expect(getTask).toHaveBeenCalledWith(21, expect.anything());
      else expect(getTask).not.toHaveBeenCalledWith(21, expect.anything());
    });
  }
}

describe('step-local result fallback', () => {
  it('does not use an older step when the current step has no matching call', () => {
    const view: ChatView = {
      busy: false,
      tools: [],
      messages: [
        {
          id: 'e1',
          role: 'assistant',
          text: '',
          toolCalls: [
            { id: 'x', instanceId: 'e1/tool/x', name: 'bash', arguments: { command: 'old' } },
          ],
        },
        { id: 'e2', role: 'assistant', text: 'new step without tool calls' },
        { id: 'e3', role: 'tool', toolCallId: 'x', name: 'bash', text: 'unknown', isError: false },
      ],
    };
    expect(partsOf(view)).toMatchObject([
      { state: 'input-available', input: { command: 'old' } },
      { state: 'output-available', input: {} },
    ]);
  });

  it('duplicate provider IDs in the same step are ambiguous, not last-call wins', () => {
    const view: ChatView = {
      busy: false,
      tools: [],
      messages: [
        {
          id: 'e1',
          role: 'assistant',
          text: '',
          toolCalls: [
            { id: 'x', instanceId: 'first', name: 'bash', arguments: { command: 'A' } },
            { id: 'x', instanceId: 'second', name: 'bash', arguments: { command: 'B' } },
          ],
        },
        { id: 'e2', role: 'tool', toolCallId: 'x', name: 'bash', text: 'unknown', isError: false },
      ],
    };
    const parts = partsOf(view);
    expect(parts).toMatchObject([
      { state: 'input-available', input: { command: 'A' } },
      { state: 'input-available', input: { command: 'B' } },
      { state: 'output-available', input: {} },
    ]);
    expect(new Set(parts.map((p) => p.toolCallId)).size).toBe(3);
  });

  it('multiple pending keyed requests sharing one task retain the unmatched request as an orphan', () => {
    const pending: ChatApproval = {
      id: 'one',
      taskId: 't1',
      callId: 'x',
      tool: 'bash',
      status: 'pending',
      requestedAt: 1,
      arguments: { command: 'exact' },
    };
    const other = { ...pending, id: 'two' };
    const messages = viewToMessages({
      busy: true,
      tools: [],
      approvals: [pending, other],
      messages: [
        {
          id: 'e1',
          role: 'assistant',
          text: '',
          toolCalls: [
            {
              id: 'x',
              instanceId: 'e1/tool/x',
              taskId: 't1',
              name: 'bash',
              arguments: {},
              approval: pending,
            },
          ],
        },
      ],
    });
    const parts = messages.flatMap((m) => m.parts).filter((p) => p.type === 'dynamic-tool');
    expect(approvalOf(parts[0]!)).toEqual(pending);
    expect(messages.at(-1)?.metadata?.approvals).toEqual([other]);
  });
});

import { describe, expect, it } from 'vitest';
import type { ChatApproval, ChatMessage, ChatView } from '~/api/client';
import { approvalOf, viewToMessages } from '~/lib/chat-view';

const canonical = 'name: B\ninstructions: Exact second snapshot\nworkspace:\n  tools: [read]\n';
const a: ChatApproval = {
  id: 'ap_a',
  taskId: 't10',
  callId: 'call_1',
  tool: 'create_agent',
  status: 'approved',
  requestedAt: 1,
};
const b: ChatApproval = {
  id: 'ap_b',
  taskId: 't20',
  callId: 'call_1',
  tool: 'create_agent',
  status: 'pending',
  requestedAt: 2,
  arguments: { name: 'B', canonicalYaml: canonical },
};
const first: ChatMessage = {
  id: 'e2',
  role: 'assistant',
  text: '',
  toolCalls: [
    {
      id: 'call_1',
      instanceId: 'e2/tool/call_1',
      taskId: 't10',
      name: 'create_agent',
      arguments: { name: 'A' },
      startedAt: 1,
      endedAt: 2,
      approval: a,
    },
  ],
};
const result: ChatMessage = {
  id: 'e3',
  role: 'tool',
  toolCallId: 'call_1',
  instanceId: 'e2/tool/call_1',
  taskId: 't10',
  name: 'create_agent',
  text: 'Created A',
  isError: false,
};
const second: ChatMessage = {
  id: 'e5',
  role: 'assistant',
  text: '',
  toolCalls: [
    {
      id: 'call_1',
      instanceId: 'e5/tool/call_1',
      taskId: 't20',
      name: 'create_agent',
      arguments: { name: 'B' },
      approval: { ...b, arguments: undefined },
    },
  ],
};
const partsOf = (view: ChatView) =>
  viewToMessages(view)
    .flatMap((m) => m.parts)
    .filter((p) => p.type === 'dynamic-tool');

for (const singleReply of [false, true]) {
  it(`preserves completed A and shows exact pending B with repeated provider ID in ${singleReply ? 'one reply' : 'separate replies'}`, () => {
    const messages: ChatMessage[] = [
      { id: 'e1', role: 'user', text: 'A' },
      first,
      result,
      ...(!singleReply ? [{ id: 'e4', role: 'user', text: 'B' } as ChatMessage] : []),
      second,
    ];
    const view: ChatView = {
      busy: true,
      tools: [
        {
          callId: 'call_1',
          instanceId: 'e5/tool/call_1',
          taskId: 't20',
          name: 'create_agent',
          status: 'pending',
        },
      ],
      messages,
      approvals: [b],
    };
    for (const snapshot of [view, JSON.parse(JSON.stringify(view)) as ChatView]) {
      const [old, current] = partsOf(snapshot);
      expect(old).toMatchObject({
        state: 'output-available',
        input: { name: 'A' },
        output: { text: 'Created A' },
      });
      expect(approvalOf(old!)).toEqual(a);
      expect(current).toMatchObject({
        state: 'approval-requested',
        approval: { id: 'ap_b' },
        input: { name: 'B' },
      });
      expect(approvalOf(current!)).toEqual(b);
      expect(current!.toolCallId).not.toBe(old!.toolCallId);
      expect(partsOf(snapshot)).toHaveLength(2);
    }
    // Loading old pages changes neither B's identity nor its canonical decision record.
    const paged = { ...view, messages: [second] };
    expect(partsOf(paged)[0]).toEqual(partsOf(view)[1]);
  });
}

describe('unmatched approval safety', () => {
  it('keeps a pending record decidable when only an older completed occurrence is loaded', () => {
    const view: ChatView = { busy: true, tools: [], messages: [first, result], approvals: [b] };
    const messages = viewToMessages(view);
    expect(partsOf(view)[0]).toMatchObject({ state: 'output-available' });
    expect(messages.at(-1)?.metadata?.approvals).toEqual([b]);
  });

  it('never drops a pending record even if its exact task has a stale completed result', () => {
    const pending = { ...a, status: 'pending' as const, arguments: { canonicalYaml: canonical } };
    const messages = viewToMessages({
      busy: false,
      tools: [],
      messages: [first, result],
      approvals: [pending],
    });
    expect(messages.at(-1)?.metadata?.approvals).toEqual([pending]);
  });

  it('older DTOs without task identity use exact approval ID or a safe orphan card, not call ID', () => {
    const { taskId: _, ...legacy } = b;
    const messages = viewToMessages({
      busy: true,
      tools: [],
      messages: [first, result],
      approvals: [legacy],
    });
    expect(messages.at(-1)?.metadata?.approvals).toEqual([legacy]);
    const exact = partsOf({ busy: true, tools: [], messages: [second], approvals: [legacy] });
    expect(approvalOf(exact[0]!)).toEqual(b);
  });

  it('shows separate exact requests on uncommitted live slots and parallel unique IDs', () => {
    const c = { ...b, id: 'ap_c', taskId: 't30', callId: 'other', arguments: { name: 'C' } };
    const parts = partsOf({
      busy: true,
      messages: [],
      tools: [
        {
          callId: 'call_1',
          taskId: 't20',
          instanceId: 'e5/tool/call_1',
          name: 'create_agent',
          status: 'pending',
        },
        {
          callId: 'other',
          taskId: 't30',
          instanceId: 'e6/tool/other',
          name: 'create_agent',
          status: 'pending',
        },
      ],
      approvals: [b, c],
    });
    expect(parts.map((p) => approvalOf(p))).toEqual([b, c]);
    expect(parts.map((p) => p.state)).toEqual(['approval-requested', 'approval-requested']);
  });

  it('does not drop a later result reusing an interrupted step provider ID', () => {
    const interrupted = { ...first, error: 'Interrupted' } as ChatMessage;
    const done = {
      ...result,
      id: 'e6',
      instanceId: 'e5/tool/call_1',
      taskId: 't20',
      text: 'Created B',
    };
    const parts = partsOf({
      busy: false,
      tools: [],
      messages: [interrupted, result, second, done],
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ state: 'output-available', output: { text: 'Created B' } });
  });
});

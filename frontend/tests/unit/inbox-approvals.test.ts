import { describe, expect, it } from 'vitest';
import type { ChatView } from '~/api/client';
import { approvalOf, viewToMessages } from '~/lib/chat-view';
import {
  bucketOf,
  type InboxEntry,
  STATUS_LABEL,
  sectionsOf,
  statusOf,
  type ThreadMeta,
} from '~/lib/inbox';
import { summarizeToolPart } from '~/shared';

const NOW = new Date(2026, 9, 20, 10, 0).getTime();
const thread = { updatedAt: NOW - 60_000, busy: true };

describe('inbox: a conversation waiting for approval', () => {
  const working: ThreadMeta = { workingSince: NOW - 30_000 };

  it('says "Needs approval", not "Working"', () => {
    expect(statusOf(working, NOW)).toBe('working');
    expect(statusOf(working, NOW, 1)).toBe('approval');
    expect(STATUS_LABEL.approval).toBe('Needs approval');
  });

  it('says "Asks you" when only an MCP server\'s question waits', () => {
    expect(statusOf(working, NOW, 0, 1)).toBe('asks');
    expect(STATUS_LABEL.asks).toBe('Asks you');
    // A tool approval still says "Needs approval", whatever else waits.
    expect(statusOf(working, NOW, 1, 1)).toBe('approval');
    // Both are in "Needs you".
    expect(bucketOf(working, thread, NOW, 1)).toBe('approval');
  });

  it('is in "Needs you", even when pinned, snoozed or archived', () => {
    expect(bucketOf(working, thread, NOW)).toBe('working');
    expect(bucketOf(working, thread, NOW, 2)).toBe('approval');
    expect(bucketOf({ snoozedUntil: NOW + 3_600_000, snoozedAt: NOW }, thread, NOW, 1)).toBe(
      'approval',
    );
    expect(bucketOf({ archivedAt: NOW - 1 }, thread, NOW, 1)).toBe('approval');
    expect(bucketOf({ pinnedAt: NOW - 1 }, thread, NOW, 1)).toBe('approval');
  });

  it('goes back to where it was once nothing waits', () => {
    expect(bucketOf({ pinnedAt: NOW - 1 }, thread, NOW, 0)).toBe('pinned');
    expect(statusOf({}, NOW, 0)).toBeNull();
  });

  it('sorts "Needs you" into its own section', () => {
    const entry = (key: string, bucket: InboxEntry['bucket']): InboxEntry => ({
      key,
      agentId: 'ag_a',
      threadId: key,
      title: key,
      updatedAt: NOW,
      meta: {},
      bucket,
      status: bucket === 'approval' ? 'approval' : null,
    });
    const sections = sectionsOf([entry('a', 'approval'), entry('b', 'inbox')], NOW);
    expect(sections.approval.map((e) => e.key)).toEqual(['a']);
    expect(sections.inbox.map((e) => e.key)).toEqual(['b']);
    expect(sections.working).toEqual([]);
  });
});

describe('chat view: approvals on tool steps', () => {
  const pending = {
    id: 'ap_1',
    callId: 'c1',
    tool: 'bash',
    status: 'pending' as const,
    requestedAt: NOW,
    expiresAt: NOW + 3_600_000,
  };

  it('puts a waiting call in approval-requested, with the redacted arguments', () => {
    const view: ChatView = {
      busy: true,
      tools: [],
      messages: [
        { id: 'e1', role: 'user', text: 'Clean up' },
        {
          id: 'e2',
          role: 'assistant',
          text: '',
          toolCalls: [
            { id: 'c1', name: 'bash', arguments: { command: 'rm -rf tmp' }, approval: pending },
          ],
        },
      ],
      approvals: [{ ...pending, arguments: { command: 'rm -rf tmp' }, summary: 'Deletes tmp' }],
    };
    const reply = viewToMessages(view).at(-1)!;
    const part = reply.parts.find((p) => p.type === 'dynamic-tool')!;
    expect(part).toMatchObject({ state: 'approval-requested', approval: { id: 'ap_1' } });
    expect(approvalOf(part)).toMatchObject({
      status: 'pending',
      summary: 'Deletes tmp',
      arguments: { command: 'rm -rf tmp' },
    });
    expect(summarizeToolPart(part).state).toBe('awaiting-approval');
  });

  it('shows a denied call as not run, with the reason, even after its result', () => {
    const denied = { ...pending, status: 'denied' as const, reason: 'not now', decidedAt: NOW };
    const view: ChatView = {
      busy: false,
      tools: [],
      messages: [
        { id: 'e1', role: 'user', text: 'Clean up' },
        {
          id: 'e2',
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'ls' }, approval: denied }],
        },
        {
          id: 'e3',
          role: 'tool',
          toolCallId: 'c1',
          name: 'bash',
          text: 'Denied: not now',
          isError: true,
        },
      ],
    };
    const part = viewToMessages(view)
      .at(-1)!
      .parts.find((p) => p.type === 'dynamic-tool')!;
    expect(part.state).toBe('output-denied');
    const step = summarizeToolPart(part);
    expect(step.state).toBe('denied');
    expect(step.reason).toBe('not now');
    expect(approvalOf(part)?.status).toBe('denied');
  });

  it('keeps an approved call as any other, with its approval on the step', () => {
    const approved = { ...pending, status: 'approved' as const, decidedAt: NOW };
    const view: ChatView = {
      busy: false,
      tools: [],
      messages: [
        { id: 'e1', role: 'user', text: 'List' },
        {
          id: 'e2',
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'ls' }, approval: approved }],
        },
        { id: 'e3', role: 'tool', toolCallId: 'c1', name: 'bash', text: 'a', isError: false },
      ],
    };
    const part = viewToMessages(view)
      .at(-1)!
      .parts.find((p) => p.type === 'dynamic-tool')!;
    expect(part.state).toBe('output-available');
    expect(approvalOf(part)?.status).toBe('approved');
  });

  it('puts a waiting request whose call is not in the transcript on the latest reply', () => {
    const view: ChatView = {
      busy: true,
      tools: [],
      messages: [{ id: 'e1', role: 'user', text: 'Research' }],
      approvals: [{ ...pending, callId: 'sub-1', tool: 'write', arguments: { path: 'a.md' } }],
    };
    const reply = viewToMessages(view).at(-1)!;
    expect(reply.role).toBe('assistant');
    expect((reply.metadata as { approvals?: unknown[] }).approvals).toHaveLength(1);
  });
});

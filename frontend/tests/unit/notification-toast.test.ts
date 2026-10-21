import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { showNotification } from '../../src/lib/notification-toast';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }) }));

const event = (change: Record<string, unknown> = {}) =>
  JSON.stringify({
    agentId: 'ag_rex',
    agentName: 'Rex',
    threadId: 't1',
    title: 'Report ready',
    message: 'The Q3 report is in your Documents folder.',
    ...change,
  });

const open = vi.fn();
beforeEach(() => {
  vi.mocked(toast).mockClear();
  open.mockClear();
});

describe('A notification from an agent', () => {
  it('is a toast "{agent}: {title}" with the message and an Open button to its conversation', () => {
    expect(showNotification(event(), { pathname: '/', open })).toBe(true);
    expect(toast).toHaveBeenCalledTimes(1);
    const [title, options] = vi.mocked(toast).mock.calls[0] as unknown as [
      string,
      {
        description: string;
        action: { label: string; onClick: () => void };
      },
    ];
    expect(title).toBe('Rex: Report ready');
    expect(options.description).toBe('The Q3 report is in your Documents folder.');
    expect(options.action.label).toBe('Open');
    options.action.onClick();
    expect(open).toHaveBeenCalledWith('ag_rex', 't1');
  });

  it('is not shown while that conversation is on screen', () => {
    expect(showNotification(event(), { pathname: '/agents/ag_rex/threads/t1', open })).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it('is shown while another conversation, or the same id of another agent, is on screen', () => {
    expect(showNotification(event(), { pathname: '/agents/ag_rex/threads/t2', open })).toBe(true);
    expect(showNotification(event(), { pathname: '/agents/ag_ada/threads/t1', open })).toBe(true);
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it('has no Open button without a conversation', () => {
    expect(showNotification(event({ threadId: '' }), { pathname: '/', open })).toBe(true);
    const options = vi.mocked(toast).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options).not.toHaveProperty('action');
    expect(options.description).toBe('The Q3 report is in your Documents folder.');
  });

  it('ignores what it cannot read', () => {
    expect(showNotification('not json', { pathname: '/', open })).toBe(false);
    expect(showNotification('{}', { pathname: '/', open })).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });
});

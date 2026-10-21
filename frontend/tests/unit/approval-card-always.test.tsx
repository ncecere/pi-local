// @vitest-environment happy-dom

import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatApproval } from '../../src/api/client';
import { ApiError } from '../../src/api/client';
import { ApprovalCard } from '../../src/components/chat/approval-card';
import {
  buttonByText,
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
} from './ui-test-utils';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const request = (overrides: Partial<ChatApproval> = {}): ChatApproval => ({
  id: 'ap_one',
  callId: 'c1',
  tool: 'bash',
  status: 'pending',
  requestedAt: Date.now(),
  arguments: { command: 'git status --short' },
  ...overrides,
});

const decided = { id: 'ap_one', status: 'approved' };

let view: Rendered | undefined;
beforeEach(() => vi.mocked(toast).mockClear());
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const ALWAYS = 'Approve and always allow this';

describe('the approval card: Approve and always allow this', () => {
  it('shows the entire builder configuration and schedule, never Always allow', async () => {
    fakeBackend();
    const yaml = `name: Child\ninstructions: ${'x'.repeat(18_000)}\nTHE END`;
    view = await renderWithQuery(
      <ApprovalCard
        agentId="ag_rex"
        approval={request({
          tool: 'create_agent',
          arguments: { yaml, schedule: { message: 'Do the work', cron: '0 9 * * *' } },
        })}
      />,
    );
    expect(document.body.textContent).toContain(yaml);
    expect(document.body.textContent).toContain('Do the work');
    expect(document.body.textContent).toContain('Create this agent?');
    expect(buttonByText(ALWAYS)).toBeUndefined();
    expect(buttonByText('Approve')).toBeDefined();
  });

  it('adds the rule for the command, then approves, and says so', async () => {
    const backend = fakeBackend({
      'POST /api/agents/ag_rex/approval-rules': () => ({ rule: { id: 'r_1' }, rules: [] }),
      'POST /api/agents/ag_rex/approvals/ap_one': () => decided,
    });
    view = await renderWithQuery(<ApprovalCard agentId="ag_rex" approval={request()} />);
    expect(document.body.textContent).toContain('bash · command: git status *');
    await click(buttonByText(ALWAYS));

    expect(backend.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /api/agents/ag_rex/approval-rules',
      'POST /api/agents/ag_rex/approvals/ap_one',
    ]);
    expect(backend.calls[0]?.body).toEqual({ tool: 'bash', args: { command: 'git status *' } });
    expect(backend.calls[1]?.body).toEqual({ decision: 'approve' });
    expect(vi.mocked(toast).mock.calls[0]?.[0]).toBe(
      'Approved: bash will run. Always allowed: bash · command: git status *.',
    );
  });

  it('can remember only the exact command', async () => {
    const backend = fakeBackend({
      'POST /api/agents/ag_rex/approval-rules': () => ({ rule: { id: 'r_exact' }, rules: [] }),
      'POST /api/agents/ag_rex/approvals/ap_one': () => decided,
    });
    view = await renderWithQuery(<ApprovalCard agentId="ag_rex" approval={request()} />);
    await click(document.querySelector('input[type="checkbox"]'));
    await click(buttonByText(ALWAYS));
    expect(backend.calls[0]?.body).toEqual({
      tool: 'bash',
      args: { command: 'git status --short' },
    });
  });

  it('never labels a wildcard command as exact', async () => {
    fakeBackend();
    view = await renderWithQuery(
      <ApprovalCard agentId="ag_rex" approval={request({ arguments: { command: 'ls *.md' } })} />,
    );
    expect(document.body.textContent).not.toContain('Remember only this exact command');
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('for another tool, allows the tool alone', async () => {
    const backend = fakeBackend({
      'POST /api/agents/ag_rex/approval-rules': () => ({ rule: { id: 'r_1' }, rules: [] }),
      'POST /api/agents/ag_rex/approvals/ap_one': () => decided,
    });
    view = await renderWithQuery(
      <ApprovalCard
        agentId="ag_rex"
        approval={request({ tool: 'mcp__github__create_issue', arguments: { title: 'x' } })}
      />,
    );
    await click(buttonByText(ALWAYS));
    expect(backend.calls[0]?.body).toEqual({ tool: 'mcp__github__create_issue' });
  });

  it('approves nothing when the rule could not be added', async () => {
    const backend = fakeBackend({
      'POST /api/agents/ag_rex/approval-rules': () => {
        throw new ApiError(400, 'invalid_approval_rules', 'That is not a rule.');
      },
    });
    view = await renderWithQuery(<ApprovalCard agentId="ag_rex" approval={request()} />);
    await click(buttonByText(ALWAYS));
    expect(backend.calls.map((call) => call.path)).toEqual(['/api/agents/ag_rex/approval-rules']);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('That is not a rule.');
    // Plain Approve is still there.
    expect(buttonByText('Approve')?.disabled).toBe(false);
  });

  it('plain Approve adds no rule', async () => {
    const backend = fakeBackend({ 'POST /api/agents/ag_rex/approvals/ap_one': () => decided });
    view = await renderWithQuery(<ApprovalCard agentId="ag_rex" approval={request()} />);
    await click(buttonByText('Approve'));
    expect(backend.calls.map((call) => call.path)).toEqual(['/api/agents/ag_rex/approvals/ap_one']);
  });

  it('is not offered for what a built-in rule, an ask rule or the agent itself asked', async () => {
    fakeBackend();
    for (const source of ['builtin', 'rule', 'author']) {
      view = await renderWithQuery(
        <ApprovalCard agentId="ag_rex" approval={request({ source })} />,
      );
      expect(buttonByText(ALWAYS), source).toBeUndefined();
      expect(buttonByText('Approve')).toBeDefined();
      view.unmount();
      view = undefined;
    }
  });

  it('is not offered for a compound command, which no allow rule would match', async () => {
    fakeBackend();
    view = await renderWithQuery(
      <ApprovalCard
        agentId="ag_rex"
        approval={request({ arguments: { command: 'git status && rm -rf build' } })}
      />,
    );
    expect(buttonByText(ALWAYS)).toBeUndefined();
    expect(document.body.textContent).toContain('cannot be remembered as an allow rule');
  });

  it('is offered when fast judgments asked, and the card says why', async () => {
    fakeBackend();
    view = await renderWithQuery(
      <ApprovalCard
        agentId="ag_rex"
        approval={request({
          source: 'judge',
          summary: 'Asked because fast judgments thought it could be risky.',
        })}
      />,
    );
    expect(buttonByText(ALWAYS)).toBeDefined();
    expect(document.body.textContent).toContain(
      'Asked because fast judgments thought it could be risky.',
    );
  });
});

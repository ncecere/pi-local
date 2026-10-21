import { describe, expect, it } from 'vitest';
import type { Approval } from '../../src/api/types.ts';
import {
  applyApprovalEvent,
  applyPreset,
  approvalHeadline,
  approvalOutcome,
  approvalPatternsError,
  approvalsByThread,
  argumentsView,
  canAlwaysAllow,
  commandOf,
  describeRule,
  expiresIn,
  extraPatterns,
  formatTimeout,
  isCompoundCommand,
  matchesPattern,
  minutesToTimeout,
  needsApproval,
  pathOf,
  presetOf,
  readToolSettings,
  suggestRule,
  timeoutChoiceOf,
  unguardedTools,
} from '../../src/lib/approvals.ts';

describe('approval presets', () => {
  it('detects each preset from the workspace tools in the list, in any order', () => {
    expect(presetOf(['bash', 'write', 'edit'])).toBe('ask-first');
    expect(presetOf(['edit', 'bash', 'write'])).toBe('ask-first');
    expect(presetOf(['bash'])).toBe('commands');
    expect(presetOf([])).toBe('none');
  });

  it('ignores other tools (the advanced list) when detecting the preset', () => {
    expect(presetOf(['bash', 'mcp__github__create_*'])).toBe('commands');
    expect(presetOf(['mcp__github__create_*', 'remember'])).toBe('none');
    expect(presetOf(['write', 'edit', 'bash', 'mcp__*'])).toBe('ask-first');
  });

  it('is custom when the workspace tools ask in a way no preset does', () => {
    expect(presetOf(['write'])).toBe('custom');
    expect(presetOf(['bash', 'write'])).toBe('custom');
    expect(presetOf(['read', 'bash'])).toBe('custom');
    // A pattern that covers workspace tools.
    expect(presetOf(['*'])).toBe('custom');
    expect(presetOf(['b*'])).toBe('custom');
  });

  it('applies a preset, keeping the other entries', () => {
    expect(applyPreset(['bash', 'mcp__github__create_*'], 'ask-first')).toEqual([
      'bash',
      'write',
      'edit',
      'mcp__github__create_*',
    ]);
    expect(applyPreset(['bash', 'write', 'edit', 'x_*'], 'none')).toEqual(['x_*']);
    expect(applyPreset(['*', 'remember'], 'commands')).toEqual(['bash', 'remember']);
    expect(extraPatterns(['bash', 'read', 'mcp__a', 'w*'])).toEqual(['mcp__a']);
  });

  it('matches tool names against patterns with *', () => {
    expect(matchesPattern('mcp__github__create_issue', 'mcp__github__create_*')).toBe(true);
    expect(matchesPattern('mcp__github__list_issues', 'mcp__github__create_*')).toBe(false);
    expect(matchesPattern('bash', 'bash')).toBe(true);
    expect(matchesPattern('a.b', 'a.*')).toBe(true);
    expect(matchesPattern('axb', 'a.b')).toBe(false);
    expect(needsApproval('write', ['bash', 'w*'])).toBe(true);
    expect(needsApproval('read', ['bash', 'w*'])).toBe(false);
  });

  it('says why a list would be refused', () => {
    expect(approvalPatternsError(['bash', 'mcp__github__create_*', 'a.b-c'])).toBeNull();
    expect(approvalPatternsError(['has space'])).toMatch(/isn't a tool name/);
    expect(approvalPatternsError(['x'.repeat(201)])).toMatch(/isn't a tool name/);
    expect(approvalPatternsError(Array.from({ length: 101 }, (_, i) => `t${i}`))).toMatch(
      /At most 100/,
    );
  });

  it('reads an agent without Phase 4 fields as no tools, one day', () => {
    expect(readToolSettings({})).toEqual({
      tools: [],
      approvals: {
        profile: 'custom',
        tools: [],
        rules: [],
        builtinRules: [],
        timeoutSeconds: 86_400,
      },
    });
    expect(
      readToolSettings({
        workspace: { tools: ['bash', 'read'] },
        approvals: { tools: ['bash'], timeoutSeconds: 3600 },
      }).tools,
    ).toEqual(['read', 'bash']);
  });
});

describe('approval timeout', () => {
  it('maps seconds to the choices, or custom', () => {
    expect(timeoutChoiceOf(3600)).toBe('1h');
    expect(timeoutChoiceOf(86_400)).toBe('1d');
    expect(timeoutChoiceOf(604_800)).toBe('1w');
    expect(timeoutChoiceOf(5400)).toBe('custom');
  });

  it('accepts custom whole minutes from 1 minute to 30 days', () => {
    expect(minutesToTimeout('90')).toBe(5400);
    expect(minutesToTimeout('1')).toBe(60);
    expect(minutesToTimeout('43200')).toBe(30 * 86_400);
    expect(minutesToTimeout('43201')).toBeNull();
    expect(minutesToTimeout('0')).toBeNull();
    expect(minutesToTimeout('1.5')).toBeNull();
    expect(minutesToTimeout('')).toBeNull();
  });

  it('says a timeout as people do', () => {
    expect(formatTimeout(3600)).toBe('1 hour');
    expect(formatTimeout(3 * 86_400)).toBe('3 days');
    expect(formatTimeout(604_800)).toBe('1 week');
    expect(formatTimeout(5400)).toBe('90 minutes');
  });
});

describe('approval arguments', () => {
  it('shows a shell call as its command', () => {
    expect(argumentsView('bash', { command: 'rm -rf build', timeout: 30 })).toEqual({
      kind: 'command',
      command: 'rm -rf build',
      cwd: null,
      timeout: 30,
    });
    expect(commandOf({ cmd: 'ls' })).toBe('ls');
    expect(commandOf('ls')).toBeNull();
  });

  it('shows a write as its path and the start of the content', () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const view = argumentsView('write', { path: 'notes/todo.md', content });
    expect(view.kind).toBe('file');
    if (view.kind !== 'file') return;
    expect(view.path).toBe('notes/todo.md');
    expect(view.previewLabel).toBe('Content');
    expect(view.clipped).toBe(true);
    expect(view.preview?.split('\n')).toHaveLength(12);
    expect(pathOf({ file_path: 'a.txt' })).toBe('a.txt');
  });

  it("shows an edit as its path and what changes (pi's edits list, or one old/new pair)", () => {
    const view = argumentsView('edit', {
      path: 'src/app.ts',
      edits: [{ oldText: 'const a = 1;', newText: 'const a = 2;' }],
    });
    expect(view).toMatchObject({
      kind: 'file',
      path: 'src/app.ts',
      previewLabel: 'Change',
      preview: '- const a = 1;\n+ const a = 2;',
    });
    expect(argumentsView('edit', { path: 'x', oldText: 'a', newText: 'b' })).toMatchObject({
      preview: '- a\n+ b',
    });
    // A redacted body: the path still shows.
    expect(argumentsView('write', { path: 'secret.env' })).toMatchObject({
      kind: 'file',
      preview: null,
    });
  });

  it('shows other calls as fields, JSON, or nothing', () => {
    expect(argumentsView('mcp__github__create_issue', { title: 'Bug', repo: 'a/b' })).toEqual({
      kind: 'fields',
      entries: [
        ['title', 'Bug'],
        ['repo', 'a/b'],
      ],
    });
    expect(argumentsView('x', { nested: { a: 1 } }).kind).toBe('json');
    expect(argumentsView('x', {})).toEqual({ kind: 'none' });
    expect(argumentsView('x', undefined)).toEqual({ kind: 'none' });
  });

  it('names a request in one line', () => {
    expect(approvalHeadline('bash', { command: 'git   status\n' })).toBe('bash · git status');
    expect(approvalHeadline('write', { path: 'a.md', content: 'x' })).toBe('write · a.md');
    expect(approvalHeadline('mcp__x', { n: 1 })).toBe('mcp__x');
  });

  it('says how a request ended', () => {
    expect(approvalOutcome({ status: 'approved' })).toBe('Approved');
    expect(approvalOutcome({ status: 'denied', reason: ' not now ' })).toBe('Denied: not now');
    expect(approvalOutcome({ status: 'denied', reason: null })).toBe('Denied');
    expect(approvalOutcome({ status: 'timed_out' })).toBe('Timed out');
    expect(approvalOutcome({ status: 'cancelled' })).toBe('Cancelled');
    expect(approvalOutcome({ status: 'pending' })).toBe('Waiting for approval');
  });

  it('says when a request lapses', () => {
    const now = 1_000_000;
    expect(expiresIn(now + 59 * 60_000, now)).toBe('in 59 minutes');
    expect(expiresIn(now + 60_000, now)).toBe('in 1 minute');
    expect(expiresIn(now + 3 * 3_600_000, now)).toBe('in 3 hours');
    expect(expiresIn(now + 7 * 86_400_000, now)).toBe('in 7 days');
    expect(expiresIn(now + 1000, now)).toBe('now');
  });
});

describe('the pending list', () => {
  const approval = (id: string, extra: Partial<Approval> = {}): Approval => ({
    id,
    agentId: 'ag_a',
    agentName: 'A',
    threadId: 'th-1',
    tool: 'bash',
    arguments: { command: 'ls' },
    summary: null,
    status: 'pending',
    requestedAt: 1,
    expiresAt: 2,
    decidedAt: null,
    reason: null,
    ...extra,
  });

  it('adds a new request newest first, and removes a decided one', () => {
    const list = [approval('ap_1', { requestedAt: 10 })];
    const added = applyApprovalEvent(list, approval('ap_2', { requestedAt: 20 }));
    expect(added?.map((a) => a.id)).toEqual(['ap_2', 'ap_1']);
    const decided = applyApprovalEvent(added, approval('ap_2', { status: 'approved' }));
    expect(decided?.map((a) => a.id)).toEqual(['ap_1']);
    // Unknown and decided: nothing changes.
    expect(applyApprovalEvent(list, approval('ap_9', { status: 'denied' }))).toBe(list);
    expect(applyApprovalEvent(undefined, approval('ap_1'))).toBeUndefined();
  });

  it('keeps requests of different agents with the same ID apart', () => {
    const list = [approval('ap_1')];
    const next = applyApprovalEvent(list, approval('ap_1', { agentId: 'ag_b' }));
    expect(next).toHaveLength(2);
  });

  it('groups pending requests by conversation', () => {
    const map = approvalsByThread([
      approval('ap_1'),
      approval('ap_2'),
      approval('ap_3', { threadId: null }),
      approval('ap_4', { threadId: 'th-2', status: 'denied' }),
    ]);
    expect([...map.keys()]).toEqual(['ag_a/th-1']);
    expect(map.get('ag_a/th-1')).toHaveLength(2);
  });
});

describe('"Approve and always allow this"', () => {
  it('suggests the first word and subcommand of a command', () => {
    const rule = (command: string) => suggestRule('bash', { command });
    expect(rule('git status')).toEqual({ tool: 'bash', args: { command: 'git status*' } });
    expect(rule('git status --short')).toEqual({ tool: 'bash', args: { command: 'git status*' } });
    expect(rule('  npm run build -- --watch')).toEqual({
      tool: 'bash',
      args: { command: 'npm run*' },
    });
    expect(rule('ls -la')).toEqual({ tool: 'bash', args: { command: 'ls*' } });
    expect(rule('ls')).toEqual({ tool: 'bash', args: { command: 'ls*' } });
    expect(rule('cat ./notes.md')).toEqual({ tool: 'bash', args: { command: 'cat*' } });
    expect(rule('git status 2>&1')).toEqual({ tool: 'bash', args: { command: 'git status*' } });
  });

  it('suggests nothing for a command no allow rule could cover', () => {
    for (const command of [
      'git status && rm -rf ~',
      'ls; ls',
      'cat a | sh',
      'echo `id`',
      'echo $(id)',
      'ls > out',
      '',
    ]) {
      expect(suggestRule('bash', { command }), command).toBeNull();
    }
    expect(suggestRule('bash', {})).toBeNull();
    expect(suggestRule('bash', undefined)).toBeNull();
    expect(isCompoundCommand('git status')).toBe(false);
    expect(isCompoundCommand('a\nb')).toBe(true);
  });

  it('is the tool alone for any other tool', () => {
    expect(suggestRule('mcp__github__create_issue', { title: 'x' })).toEqual({
      tool: 'mcp__github__create_issue',
    });
    expect(suggestRule('write', { path: 'a.md' })).toEqual({ tool: 'write' });
  });

  it("is offered unless a built-in or ask rule, or the agent's own code, asked", () => {
    for (const source of [undefined, 'profile', 'tools', 'judge'])
      expect(canAlwaysAllow({ source }), String(source)).toBe(true);
    for (const source of ['builtin', 'rule', 'author'])
      expect(canAlwaysAllow({ source })).toBe(false);
  });
});

describe('profiles and rules', () => {
  it('says what a profile leaves unasked', () => {
    expect(unguardedTools('careful', ['read', 'write', 'bash'], [])).toEqual([]);
    expect(unguardedTools('balanced', ['read', 'write', 'bash'], [])).toEqual([]);
    expect(unguardedTools('trusting', ['read', 'write', 'bash'], [])).toEqual(['write', 'bash']);
    expect(unguardedTools('custom', ['read', 'write', 'bash'], ['bash'])).toEqual(['write']);
  });

  it('describes a rule', () => {
    expect(describeRule({ tool: 'bash', args: { command: 'git status*' } })).toBe(
      'bash · command: git status*',
    );
    expect(describeRule({ tool: 'mcp__gh__*' })).toBe('mcp__gh__*');
  });
});

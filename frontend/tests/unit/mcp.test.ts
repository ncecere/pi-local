import { describe, expect, it } from 'vitest';
import type { McpLoginStatus, McpServer, McpTool } from '../../src/api/types';
import {
  agentMcpTools,
  applyLoginStatus,
  applyMcpEvent,
  approvalSuggestions,
  chooseServer,
  commandLine,
  envFromRows,
  formatArgs,
  hasLoginCommand,
  importKey,
  importRequests,
  linkParts,
  loginArgsProblem,
  mcpServerPath,
  mcpToolName,
  parseArgs,
  pickTool,
  readAgentMcp,
  sameSelection,
  selectionProblem,
  serverStatus,
  setToolMode,
  signInOutcome,
  slugFromName,
  slugProblem,
  urlProblem,
  WORKSPACE_VAR,
} from '../../src/lib/mcp';
import { MCP_PRESETS } from '../../src/lib/mcp-presets';

const tool = (name: string, modelVisible = true): McpTool => ({
  name,
  title: null,
  description: null,
  modelVisible,
});

const server = (slug: string, extra: Partial<McpServer> = {}): McpServer => ({
  slug,
  name: slug,
  description: '',
  transport: 'stdio',
  command: 'npx',
  args: [],
  cwd: null,
  loginArgs: [],
  envNames: [],
  url: null,
  headerNames: [],
  oauth: false,
  signedIn: false,
  enabled: true,
  tools: [],
  testedAt: null,
  lastError: null,
  usedBy: [],
  importedFrom: null,
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
  ...extra,
});

describe('slugFromName', () => {
  it('lower-cases and joins words with one _', () => {
    expect(slugFromName('GitHub')).toBe('github');
    expect(slugFromName('GitHub (work)')).toBe('github_work');
    expect(slugFromName('  My  MCP -- server!  ')).toBe('my_mcp_server');
  });

  it('has no _ at either end, and nothing outside [a-z0-9_]', () => {
    expect(slugFromName('__x__')).toBe('x');
    expect(slugFromName('Café ünïcode')).toBe('caf_n_code');
    expect(slugFromName('!!!')).toBe('');
  });

  it('is cut to 32 characters, without a trailing _', () => {
    const slug = slugFromName(`${'a'.repeat(31)} bcd`);
    expect(slug.length).toBeLessThanOrEqual(32);
    expect(slug).toBe('a'.repeat(31));
    expect(slugFromName('x'.repeat(50))).toBe('x'.repeat(32));
  });

  it('always makes a slug the backend accepts (or none)', () => {
    for (const name of ['Filesystem', 'Everything (test)', '9 lives', 'a_b', 'ÄÖÜ'])
      expect([null, 'Enter a short ID, such as "github".']).toContain(
        slugProblem(slugFromName(name)),
      );
  });
});

describe('slugProblem', () => {
  it('accepts 1–32 of [a-z0-9_] without _ at either end', () => {
    expect(slugProblem('a')).toBeNull();
    expect(slugProblem('git_hub2')).toBeNull();
    expect(slugProblem('a'.repeat(32))).toBeNull();
  });

  it('refuses the rest', () => {
    expect(slugProblem('')).not.toBeNull();
    expect(slugProblem('_a')).not.toBeNull();
    expect(slugProblem('a_')).not.toBeNull();
    expect(slugProblem('Git')).not.toBeNull();
    expect(slugProblem('git-hub')).not.toBeNull();
    expect(slugProblem('a'.repeat(33))).not.toBeNull();
  });
});

describe('parseArgs', () => {
  it('takes one argument per line, spaces inside kept', () => {
    expect(parseArgs(`-y\n@modelcontextprotocol/server-filesystem\n${WORKSPACE_VAR}`)).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      WORKSPACE_VAR,
    ]);
    expect(parseArgs('--name\nmy file.txt')).toEqual(['--name', 'my file.txt']);
  });

  it('trims each line, skips blank ones, and reads CRLF', () => {
    expect(parseArgs('  -y  \r\n\r\n\n  pkg\n   \n')).toEqual(['-y', 'pkg']);
    expect(parseArgs('')).toEqual([]);
  });

  it('round-trips with formatArgs', () => {
    const args = ['-y', 'a b', '--x=1'];
    expect(parseArgs(formatArgs(args))).toEqual(args);
  });
});

describe('commandLine', () => {
  it('quotes arguments with spaces or quotes', () => {
    expect(commandLine('npx', ['-y', 'pkg', 'my dir', "it's"])).toBe(
      `npx -y pkg 'my dir' 'it'\\''s'`,
    );
    expect(commandLine('uvx', [])).toBe('uvx');
  });
});

describe('envFromRows', () => {
  it('skips empty rows and needs a name and value', () => {
    expect(
      envFromRows([
        { name: 'TOKEN', value: 'x' },
        { name: '', value: '' },
      ]),
    ).toEqual({ env: { TOKEN: 'x' } });
    expect(envFromRows([{ name: '', value: 'x' }]).error).toBeDefined();
    expect(envFromRows([{ name: 'TOKEN', value: '' }]).error).toBeDefined();
    expect(envFromRows([{ name: '1X', value: 'v' }]).error).toBeDefined();
    expect(
      envFromRows([
        { name: 'A', value: '1' },
        { name: 'A', value: '2' },
      ]).error,
    ).toBeDefined();
  });
});

describe('urlProblem', () => {
  it('takes https anywhere, http only on this computer or network', () => {
    expect(urlProblem('https://mcp.example.com/mcp')).toBeNull();
    expect(urlProblem('http://localhost:3000/mcp')).toBeNull();
    expect(urlProblem('http://192.168.1.4/mcp')).toBeNull();
    expect(urlProblem('http://example.com/mcp')).not.toBeNull();
    expect(urlProblem('ftp://example.com')).not.toBeNull();
    expect(urlProblem('example.com')).not.toBeNull();
  });
});

describe('mcpToolName', () => {
  it('is mcp__<slug>__<tool>', () => {
    expect(mcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
  });

  it('makes every character outside [A-Za-z0-9_-] a _', () => {
    expect(mcpToolName('fs', 'read.file/v2 now')).toBe('mcp__fs__read_file_v2_now');
    expect(mcpToolName('x', 'Get-Thing')).toBe('mcp__x__Get-Thing');
    expect(mcpToolName('x', 'café')).toBe('mcp__x__caf_');
  });

  it('is cut to 64 characters', () => {
    const name = mcpToolName('server', 't'.repeat(100));
    expect(name).toHaveLength(64);
    expect(name.startsWith('mcp__server__ttt')).toBe(true);
  });
});

describe('serverStatus', () => {
  it('reads off, sign-in, error, untested and ok in that order', () => {
    expect(serverStatus(server('a', { enabled: false, lastError: 'x' })).id).toBe('off');
    expect(serverStatus(server('a', { transport: 'http', oauth: true, signedIn: false })).id).toBe(
      'needs-sign-in',
    );
    expect(
      serverStatus(server('a', { lastError: 'needs_sign_in: sign in. Choose Sign in.' })).id,
    ).toBe('needs-sign-in');
    expect(serverStatus(server('a', { lastError: 'spawn npx ENOENT', testedAt: 1 })).id).toBe(
      'error',
    );
    expect(serverStatus(server('a')).id).toBe('untested');
    const ok = serverStatus(server('a', { testedAt: 1, tools: [tool('x'), tool('y', false)] }));
    expect(ok).toMatchObject({ id: 'ok', label: '1 tool' });
  });
});

describe('applyMcpEvent', () => {
  const list = [server('a'), server('b')];
  it('replaces, adds at the end, removes', () => {
    expect(applyMcpEvent(list, 'b', server('b', { name: 'B' }))?.map((s) => s.name)).toEqual([
      'a',
      'B',
    ]);
    expect(applyMcpEvent(list, 'c', server('c'))?.map((s) => s.slug)).toEqual(['a', 'b', 'c']);
    expect(applyMcpEvent(list, 'a', null)?.map((s) => s.slug)).toEqual(['b']);
    expect(applyMcpEvent(undefined, 'a', server('a'))).toBeUndefined();
  });
});

describe('signInOutcome', () => {
  const before = server('a', {
    transport: 'http',
    oauth: true,
    lastError: 'needs_sign_in: x',
    updatedAt: 't1',
  });
  it('waits until the server says how it went', () => {
    expect(signInOutcome(before, before)).toBe('waiting');
    expect(signInOutcome(before, { ...before, updatedAt: 't2' })).toBe('waiting');
  });
  it('is signed in once tokens are stored', () => {
    expect(signInOutcome(before, { ...before, signedIn: true, lastError: null, testedAt: 5 })).toBe(
      'signed-in',
    );
  });
  it('failed: a new error without a sign-in', () => {
    expect(signInOutcome(before, { ...before, lastError: 'access denied' })).toBe('failed');
  });
  it('gone: the server was deleted', () => {
    expect(signInOutcome(before, undefined)).toBe('gone');
  });
});

describe('an agent’s MCP choice', () => {
  const github = server('github', {
    testedAt: 1,
    tools: [tool('create_issue'), tool('get_issue'), tool('ui_panel', false)],
  });
  const fs = server('fs', { testedAt: 1, tools: [tool('read'), tool('write')] });
  const servers = [github, fs];

  it('reads an older agent without mcp as none', () => {
    expect(readAgentMcp({})).toEqual([]);
    expect(readAgentMcp({ mcp: [{ server: 'fs', tools: null }] })).toEqual([
      { server: 'fs', tools: null },
    ]);
  });

  it('choosing a server gives all its tools; unchoosing drops it', () => {
    const one = chooseServer([], 'github', true);
    expect(one).toEqual([{ server: 'github', tools: null }]);
    expect(chooseServer(one, 'github', true)).toEqual(one);
    expect(chooseServer(one, 'github', false)).toEqual([]);
  });

  it('picking starts from every model-visible tool, and All goes back to null', () => {
    const picked = setToolMode([{ server: 'github', tools: null }], github, 'pick');
    expect(picked).toEqual([{ server: 'github', tools: ['create_issue', 'get_issue'] }]);
    expect(setToolMode(picked, github, 'all')).toEqual([{ server: 'github', tools: null }]);
  });

  it('ticks and unticks tools in the server’s order', () => {
    let selection = [{ server: 'github', tools: [] as string[] | null }];
    selection = pickTool(selection, github, 'get_issue', true);
    selection = pickTool(selection, github, 'create_issue', true);
    expect(selection[0]!.tools).toEqual(['create_issue', 'get_issue']);
    selection = pickTool(selection, github, 'create_issue', false);
    expect(selection[0]!.tools).toEqual(['get_issue']);
  });

  it('refuses a server with nothing picked', () => {
    expect(selectionProblem([{ server: 'github', tools: [] }], servers)).toMatch(/github/);
    expect(selectionProblem([{ server: 'github', tools: null }], servers)).toBeNull();
  });

  it('compares choices regardless of order', () => {
    expect(
      sameSelection(
        [
          { server: 'a', tools: ['x', 'y'] },
          { server: 'b', tools: null },
        ],
        [
          { server: 'b', tools: null },
          { server: 'a', tools: ['y', 'x'] },
        ],
      ),
    ).toBe(true);
    expect(sameSelection([{ server: 'a', tools: null }], [{ server: 'a', tools: [] }])).toBe(false);
  });

  it('lists the tools the agent gets, by their model names', () => {
    const tools = agentMcpTools(
      [
        { server: 'github', tools: null },
        { server: 'fs', tools: ['read', 'gone'] },
        { server: 'unknown', tools: null },
      ],
      servers,
    );
    expect(tools.map((t) => [t.name, t.missing])).toEqual([
      ['mcp__github__create_issue', false],
      ['mcp__github__get_issue', false],
      ['mcp__fs__read', false],
      ['mcp__fs__gone', true],
    ]);
  });

  it('suggests a pattern per server and each tool for approvals', () => {
    expect(approvalSuggestions([{ server: 'fs', tools: null }], servers)).toEqual([
      'mcp__fs__*',
      'mcp__fs__read',
      'mcp__fs__write',
    ]);
  });
});

describe('importRequests', () => {
  it('groups picked servers by source', () => {
    const picked = new Set([
      importKey('claude', 'github'),
      importKey('cursor', 'fs'),
      importKey('claude', 'memory'),
    ]);
    expect(importRequests(picked)).toEqual([
      { source: 'claude', names: ['github', 'memory'] },
      { source: 'cursor', names: ['fs'] },
    ]);
  });
});

describe('mcpServerPath', () => {
  it('encodes the slug', () => {
    expect(mcpServerPath('github', '/test')).toBe('/api/mcp/servers/github/test');
  });
});

describe('MCP_PRESETS', () => {
  it('are well-formed', () => {
    const ids = new Set<string>();
    const slugs = new Set<string>();
    for (const preset of MCP_PRESETS) {
      expect(preset.id).toMatch(/^[a-z0-9-]+$/);
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
      expect(slugProblem(preset.slug)).toBeNull();
      expect(slugs.has(preset.slug)).toBe(false);
      slugs.add(preset.slug);
      expect(preset.name.trim().length).toBeGreaterThan(0);
      expect(preset.name.length).toBeLessThanOrEqual(60);
      expect(preset.description.length).toBeGreaterThan(0);
      expect(preset.command).toMatch(/^[a-z]+$/);
      for (const arg of preset.args) expect(arg).toBe(arg.trim());
      // Each argument survives the one-per-line field.
      expect(parseArgs(formatArgs(preset.args))).toEqual(preset.args);
      expect(envFromRows(preset.env.map((name) => ({ name, value: 'v' }))).error).toBeUndefined();
      if (preset.command === 'npx') {
        expect(preset.args[0]).toBe('-y');
        expect(preset.args[1]).toMatch(/^@modelcontextprotocol\/server-[a-z]+$/);
      }
    }
  });

  it('has the quick starts people expect', () => {
    const byId = Object.fromEntries(MCP_PRESETS.map((preset) => [preset.id, preset]));
    expect(byId.filesystem?.args).toContain(WORKSPACE_VAR);
    expect(byId.fetch).toMatchObject({ command: 'uvx', args: ['mcp-server-fetch'] });
    expect(byId.github?.env).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN']);
    expect(byId.memory?.args).toContain('@modelcontextprotocol/server-memory');
    expect(byId.everything?.args).toContain('@modelcontextprotocol/server-everything');
    expect(WORKSPACE_VAR).toBe(['$', '{workspace}'].join(''));
  });
});

describe('a server’s own sign-in command', () => {
  it('has a Sign in button only for stdio with loginArgs', () => {
    expect(hasLoginCommand(server('a', { loginArgs: ['login'] }))).toBe(true);
    expect(hasLoginCommand(server('a', { loginArgs: [] }))).toBe(false);
    expect(hasLoginCommand(server('a', { transport: 'http', loginArgs: ['login'] }))).toBe(false);
  });

  it('refuses the per-agent placeholders', () => {
    expect(loginArgsProblem(['login'])).toBeNull();
    expect(loginArgsProblem(['login', `--dir=${WORKSPACE_VAR}`])).toContain('can’t use');
    expect(loginArgsProblem([`${'$'}{agentDir}/x`])).toContain('can’t use');
  });

  it('links the web addresses in output, without the punctuation after them', () => {
    expect(linkParts('Open https://example.com/device, then enter ABC.')).toEqual([
      { text: 'Open ' },
      { text: 'https://example.com/device', url: 'https://example.com/device' },
      { text: ', then enter ABC.' },
    ]);
    expect(linkParts('(see https://a.example/x?y=1).\nhttp://localhost:3000/cb')).toEqual([
      { text: '(see ' },
      { text: 'https://a.example/x?y=1', url: 'https://a.example/x?y=1' },
      { text: ').\n' },
      { text: 'http://localhost:3000/cb', url: 'http://localhost:3000/cb' },
    ]);
    expect(linkParts('https://en.wikipedia.org/wiki/Foo_(bar)')[0]?.url).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    );
    expect(linkParts('no links, just https:// here')).toEqual([
      { text: 'no links, just https:// here' },
    ]);
    expect(linkParts('')).toEqual([]);
  });

  it('keeps the newer status when answers and events cross', () => {
    const status = (extra: Partial<McpLoginStatus>): McpLoginStatus => ({
      slug: 'a',
      state: 'running',
      output: '',
      exitCode: null,
      startedAt: 10,
      finishedAt: null,
      ...extra,
    });
    const more = status({ output: 'abc' });
    expect(applyLoginStatus(undefined, more)).toBe(more);
    // Output only grows; an earlier burst arriving late is ignored.
    expect(applyLoginStatus(more, status({ output: 'a' }))).toBe(more);
    const done = status({ state: 'failed', exitCode: 1, finishedAt: 20 });
    expect(applyLoginStatus(more, done)).toBe(done);
    // The same run never goes back to running.
    expect(applyLoginStatus(done, more)).toBe(done);
    // An older run never replaces a newer one; a newer one always does.
    const newer = status({ startedAt: 30 });
    expect(applyLoginStatus(newer, done)).toBe(newer);
    expect(applyLoginStatus(done, newer)).toBe(newer);
    const idle = status({ state: 'idle', startedAt: null });
    expect(applyLoginStatus(done, idle)).toBe(idle);
  });
});

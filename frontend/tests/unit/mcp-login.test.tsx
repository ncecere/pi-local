// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type McpLoginStatus, type McpServer } from '../../src/api/client';
import { McpLoginDialog } from '../../src/components/mcp/login-dialog';
import { EditServerDialog } from '../../src/components/mcp/server-dialogs';
import { MCP_SERVERS_KEY, putMcpLogin } from '../../src/hooks/use-mcp';
import { applyMcpEvent } from '../../src/lib/mcp';
import { SettingsMcpPage } from '../../src/routes/settings/mcp';
import {
  buttonByText,
  click,
  fakeBackend,
  fieldByLabel,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
  typeInto,
} from './ui-test-utils';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    slug: 'm365',
    name: 'Microsoft 365',
    description: '',
    transport: 'stdio',
    command: 'node',
    args: ['/opt/m365-mcp.mjs'],
    cwd: null,
    loginArgs: ['/opt/m365-mcp.mjs', 'login'],
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
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function login(overrides: Partial<McpLoginStatus> = {}): McpLoginStatus {
  return {
    slug: 'm365',
    state: 'running',
    output: '',
    exitCode: null,
    startedAt: 1_000,
    finishedAt: null,
    ...overrides,
  };
}

const DEVICE_OUTPUT =
  'To sign in, open https://microsoft.com/devicelogin and enter the code ABCD-1234.\n';

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const LOGIN = '/api/mcp/servers/m365/login';
const calls = (backend: ReturnType<typeof fakeBackend>, method: string) =>
  backend.calls.filter((call) => call.method === method && call.path === LOGIN);

describe('Editing an MCP server: sign-in arguments', () => {
  it('sends loginArgs, one per line, when they change', async () => {
    const backend = fakeBackend({ 'PATCH /api/mcp/servers/m365': () => server() });
    view = await renderWithQuery(
      <EditServerDialog server={server({ loginArgs: [] })} onClose={() => {}} />,
    );
    const field = fieldByLabel('Sign-in arguments') as HTMLTextAreaElement;
    expect(field.value).toBe('');
    await typeInto(field, '/opt/m365-mcp.mjs\n  login  \n\n');
    await click(buttonByText('Save'));
    expect(backend.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      loginArgs: ['/opt/m365-mcp.mjs', 'login'],
    });
  });

  it('clears them with an empty field, and leaves them out when unchanged', async () => {
    const backend = fakeBackend({ 'PATCH /api/mcp/servers/m365': () => server() });
    view = await renderWithQuery(<EditServerDialog server={server()} onClose={() => {}} />);
    const field = fieldByLabel('Sign-in arguments') as HTMLTextAreaElement;
    expect(field.value).toBe('/opt/m365-mcp.mjs\nlogin');
    await typeInto(fieldByLabel('Name'), 'M365');
    await click(buttonByText('Save'));
    expect(backend.calls.at(-1)?.body).toEqual({ name: 'M365' });

    view.unmount();
    view = await renderWithQuery(<EditServerDialog server={server()} onClose={() => {}} />);
    await typeInto(fieldByLabel('Sign-in arguments'), '');
    await click(buttonByText('Save'));
    expect(backend.calls.at(-1)?.body).toEqual({ loginArgs: [] });
  });

  it('refuses the workspace placeholder in them before sending', async () => {
    const backend = fakeBackend({ 'PATCH /api/mcp/servers/m365': () => server() });
    view = await renderWithQuery(<EditServerDialog server={server()} onClose={() => {}} />);
    await typeInto(fieldByLabel('Sign-in arguments'), `login\n--dir=${'$'}{workspace}`);
    await click(buttonByText('Save'));
    expect(document.body.textContent).toContain('Sign-in arguments can’t use');
    expect(backend.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
});

describe('MCP settings: Sign in with its own command', () => {
  it('shows Sign in only for stdio servers with loginArgs, starts it, and links the output', async () => {
    const backend = fakeBackend({
      'GET /api/mcp/servers': () => [
        server(),
        server({ slug: 'files', name: 'Files', loginArgs: [] }),
        server({
          slug: 'remote',
          name: 'Remote',
          transport: 'http',
          command: null,
          args: [],
          url: 'https://example.com/mcp',
          loginArgs: ['login'],
        }),
      ],
      [`POST ${LOGIN}`]: () => login({ output: DEVICE_OUTPUT }),
    });
    view = await renderWithQuery(<SettingsMcpPage />);
    await settle();
    for (const toggle of document.querySelectorAll('button[aria-expanded]')) await click(toggle);

    const signIns = [...document.querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === 'Sign in',
    );
    expect(signIns).toHaveLength(1);
    expect(signIns[0]?.closest('section')?.getAttribute('aria-label')).toBe(
      'Microsoft 365 details',
    );
    expect(document.body.textContent).toContain('node /opt/m365-mcp.mjs login');

    await click(signIns[0]);
    expect(calls(backend, 'POST')).toHaveLength(1);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Sign in to Microsoft 365');
    expect(dialog?.textContent).toContain('Running…');
    expect(dialog?.textContent).toContain('enter the code ABCD-1234.');
    const link = dialog?.querySelector('a[href="https://microsoft.com/devicelogin"]');
    expect(link?.textContent).toBe('https://microsoft.com/devicelogin');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noreferrer');
    expect(buttonByText('Cancel')).toBeDefined();

    // The `mcp-login` event says it ended well: the backend tests the server again.
    await act(async () =>
      putMcpLogin(
        view!.queryClient,
        login({
          state: 'succeeded',
          output: `${DEVICE_OUTPUT}Signed in.\n`,
          exitCode: 0,
          finishedAt: 2_000,
        }),
      ),
    );
    await settle();
    expect(dialog?.textContent).toContain('Signed in. Testing the server again…');
    expect(buttonByText('Cancel')).toBeUndefined();
    expect(buttonByText('Try again')).toBeUndefined();
    expect(buttonByText('Close')).toBeDefined();

    // Then the `mcp` event brings the new test.
    const tool = { name: 'mail', title: null, description: null, modelVisible: true };
    await act(async () =>
      view!.queryClient.setQueryData<McpServer[]>(MCP_SERVERS_KEY, (list) =>
        applyMcpEvent(list, 'm365', server({ testedAt: 3_000, tools: [tool] })),
      ),
    );
    await settle();
    expect(dialog?.textContent).toContain('Signed in. 1 tool found.');
  });
});

describe('The sign-in dialog', () => {
  it('cancels a running sign-in with DELETE', async () => {
    const backend = fakeBackend({
      [`POST ${LOGIN}`]: () => login({ output: 'Opening your browser…\n' }),
      [`DELETE ${LOGIN}`]: () =>
        login({ state: 'cancelled', output: 'Opening your browser…\n', finishedAt: 1_500 }),
    });
    view = await renderWithQuery(<McpLoginDialog server={server()} onClose={() => {}} />);
    await settle();
    expect(document.body.textContent).toContain('Opening your browser…');
    await click(buttonByText('Cancel'));
    expect(calls(backend, 'DELETE')).toHaveLength(1);
    expect(document.body.textContent).toContain('Cancelled');
    expect(buttonByText('Try again')).toBeDefined();
  });

  it('shows a failure with its exit code, and tries again', async () => {
    let runs = 0;
    const backend = fakeBackend({
      [`POST ${LOGIN}`]: () => {
        runs += 1;
        return runs === 1
          ? login({ state: 'failed', output: 'Error: no token\n', exitCode: 3, finishedAt: 1_200 })
          : login({ startedAt: 5_000, output: 'Trying again\n' });
      },
    });
    view = await renderWithQuery(<McpLoginDialog server={server()} onClose={() => {}} />);
    await settle();
    expect(document.body.textContent).toContain('Failed (exit 3)');
    expect(document.body.textContent).toContain('Error: no token');
    await click(buttonByText('Try again'));
    expect(calls(backend, 'POST')).toHaveLength(2);
    expect(document.body.textContent).toContain('Running…');
    expect(document.body.textContent).toContain('Trying again');
    expect(document.body.textContent).not.toContain('Failed (exit 3)');
  });

  it('shows the one already running when the start answers 409 login_running', async () => {
    const backend = fakeBackend({
      [`POST ${LOGIN}`]: () => {
        throw new ApiError(409, 'login_running', 'A sign-in is already running.');
      },
      [`GET ${LOGIN}`]: () => login({ output: 'Go to https://login.example.com/device now' }),
    });
    view = await renderWithQuery(<McpLoginDialog server={server()} onClose={() => {}} />);
    await settle();
    expect(calls(backend, 'GET')).toHaveLength(1);
    expect(document.body.textContent).toContain('Running…');
    expect(document.body.textContent).not.toContain('already running');
    expect(document.querySelector('a[href="https://login.example.com/device"]')?.textContent).toBe(
      'https://login.example.com/device',
    );
  });

  it('says why it could not start', async () => {
    fakeBackend({
      [`POST ${LOGIN}`]: () => {
        throw new ApiError(400, 'no_login', 'This server has no sign-in command.');
      },
    });
    view = await renderWithQuery(<McpLoginDialog server={server()} onClose={() => {}} />);
    await settle();
    expect(document.body.textContent).toContain('This server has no sign-in command.');
    expect(buttonByText('Try again')).toBeDefined();
  });
});

describe('The sign-in dialog: the command', () => {
  async function open(loginArgs: string[], command: string | null = 'node') {
    fakeBackend({
      [`POST ${LOGIN}`]: () => login({ output: '' }),
      [`GET ${LOGIN}`]: () => login(),
    });
    view = await renderWithQuery(
      <McpLoginDialog server={server({ command, loginArgs })} onClose={() => {}} />,
    );
    await settle();
    return [...document.querySelectorAll('[aria-label="Sign-in command"] > div')].map((row) => ({
      label: row.querySelector('dt')?.textContent,
      value: row.querySelector('dd')?.textContent,
    }));
  }

  it('shows the program, then one row per argument', async () => {
    expect(await open(['/opt/m365-mcp.mjs', 'login'])).toEqual([
      { label: 'Program', value: 'node' },
      { label: 'Argument 1', value: '/opt/m365-mcp.mjs' },
      { label: 'Argument 2', value: 'login' },
    ]);
  });

  it('shows arguments as they are, with no shell quoting', async () => {
    const rows = await open(['--name', "Ada's laptop", 'a "b" c', '--note=x y']);
    expect(rows.map((row) => row.value)).toEqual([
      'node',
      '--name',
      "Ada's laptop",
      'a "b" c',
      '--note=x y',
    ]);
    // Monospace, one `dd` each.
    const cells = document.querySelectorAll('[aria-label="Sign-in command"]');
    expect(cells[0]?.className).toContain('font-mono');
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("'\\''");
  });

  it('says so for an empty argument, and lists no rows for none', async () => {
    expect((await open(['login', ''])).map((row) => row.value)).toEqual([
      'node',
      'login',
      '(empty)',
    ]);
    view?.unmount();
    expect(await open([])).toEqual([{ label: 'Program', value: 'node' }]);
  });
});

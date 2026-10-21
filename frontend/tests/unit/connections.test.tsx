// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type McpServer } from '../../src/api/client';
import { CONNECTIONS_KEY, type Connection } from '../../src/hooks/use-connections';
import { ConnectionCard, SettingsConnectionsPage } from '../../src/routes/settings/connections';
import {
  buttonByText,
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('~/components/settings/settings-layout', () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

function server(): McpServer {
  return {
    slug: 'notion',
    name: 'Notion',
    description: '',
    transport: 'http',
    command: null,
    args: [],
    cwd: null,
    loginArgs: [],
    envNames: [],
    url: 'https://mcp.notion.com/mcp',
    headerNames: [],
    oauth: true,
    signedIn: true,
    enabled: true,
    tools: [],
    testedAt: 1,
    lastError: null,
    usedBy: [],
    importedFrom: null,
    createdAt: '',
    updatedAt: '',
  };
}
function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'notion',
    name: 'Notion',
    icon: 'notebook',
    group: 'apps',
    description: 'Read your pages.',
    transport: 'http',
    auth: 'oauth',
    docsUrl: 'https://developers.notion.com/docs/get-started-with-mcp',
    advanced: false,
    automatic: true,
    setup: ['Sign in in your browser.'],
    checkedAt: '2026-10-21',
    state: 'not_connected',
    server: null,
    usedBy: [],
    ...overrides,
  };
}
let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('Connections gallery', () => {
  it('groups curated apps and links to advanced custom connections', async () => {
    fakeBackend({
      'GET /api/connections': () => [
        connection(),
        connection({
          id: 'google',
          name: 'Google Workspace',
          group: 'mail',
          advanced: true,
          automatic: false,
        }),
        connection({
          id: 'apple_calendar',
          name: 'Apple Calendar',
          group: 'computer',
          auth: 'macos-permission',
          automatic: false,
        }),
      ],
    });
    view = await renderWithQuery(<SettingsConnectionsPage />);
    await settle();
    expect(document.body.textContent).toContain('Mail, calendar and files');
    expect(document.body.textContent).toContain('On this computer');
    expect(document.body.textContent).toContain('Coming to Windows and Linux');
    expect(document.querySelector('a[href="/settings/mcp"]')?.textContent).toBe(
      'Custom connections (MCP)',
    );
    const google = document.querySelector('article[aria-label="Google Workspace"]');
    expect(google?.textContent).toContain('Advanced');
    expect(google?.textContent).not.toMatch(/\bConnect\b/);
  });
  it('does not claim connected just because the OAuth browser was opened', async () => {
    const backend = fakeBackend({
      'POST /api/connections/notion/connect': () => ({
        connection: connection({ state: 'needs_sign_in' }),
        authorizeUrl: 'https://auth.example.test/authorize',
      }),
    });
    view = await renderWithQuery(<ConnectionCard connection={connection()} />);
    await click(buttonByText('Connect'));
    expect(document.body.textContent).toContain('Finish signing in in your browser');
    expect(document.querySelector('a[href="https://auth.example.test/authorize"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Connected');
    expect(backend.calls[0]?.path).toBe('/api/connections/notion/connect');
  });
  it('updates from OAuth completion and does not keep an old sign-in banner after sign-out', async () => {
    let current = connection();
    fakeBackend({
      'GET /api/connections': () => [current],
      'POST /api/connections/notion/connect': () => {
        current = connection({ state: 'needs_sign_in', server: { ...server(), signedIn: false } });
        return { connection: current, authorizeUrl: 'https://auth.example.test/authorize' };
      },
    });
    view = await renderWithQuery(<SettingsConnectionsPage />);
    await settle();
    await click(buttonByText('Connect'));
    expect(document.body.textContent).toContain('Finish signing in');
    await act(async () =>
      view!.queryClient.setQueryData(CONNECTIONS_KEY, [
        connection({ state: 'connected', server: server() }),
      ]),
    );
    await settle();
    expect(document.querySelector('article [role="status"]')?.textContent).toBe('Connected');
    await act(async () =>
      view!.queryClient.setQueryData(CONNECTIONS_KEY, [
        connection({ state: 'needs_sign_in', server: { ...server(), signedIn: false } }),
      ]),
    );
    await settle();
    expect(document.querySelector('article [role="status"]')?.textContent).toBe('Needs sign-in');
  });
  it('shows connect errors, not a success toast', async () => {
    fakeBackend({
      'POST /api/connections/notion/connect': () => {
        throw new ApiError(502, 'oauth_failed', 'Registration failed.');
      },
    });
    view = await renderWithQuery(<ConnectionCard connection={connection()} />);
    await click(buttonByText('Connect'));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Registration failed.');
    expect(document.body.textContent).not.toContain('Finish signing in');
  });
  it('shows state and agents and prevents disconnecting a connection still in use', async () => {
    view = await renderWithQuery(
      <ConnectionCard
        connection={connection({
          state: 'connected',
          server: server(),
          usedBy: [{ id: 'ag_ada', name: 'Ada' }],
        })}
      />,
    );
    expect(document.body.textContent).toContain('Used by Ada');
    expect(buttonByText('Disconnect')?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Use with agents first');
  });
  it('saves agent access without losing other connections or tool choices', async () => {
    const backend = fakeBackend({
      'GET /api/agents': () => [
        {
          id: 'ag_ada',
          name: 'Ada',
          mcp: [{ server: 'other', tools: ['read_only'] }],
          revision: 1,
        },
      ],
      'PATCH /api/agents/ag_ada': (body) => ({ id: 'ag_ada', name: 'Ada', ...(body as object) }),
    });
    view = await renderWithQuery(
      <ConnectionCard connection={connection({ state: 'connected', server: server() })} />,
    );
    await click(buttonByText('Use with agents'));
    await click(document.querySelector('input[type="checkbox"]'));
    const patch = backend.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({
      mcp: [
        { server: 'other', tools: ['read_only'] },
        { server: 'notion', tools: null },
      ],
    });
  });
  it('allows removing agent access even when the connection is broken', async () => {
    const backend = fakeBackend({
      'GET /api/agents': () => [
        { id: 'ag_ada', name: 'Ada', mcp: [{ server: 'notion', tools: ['search'] }] },
      ],
      'PATCH /api/agents/ag_ada': () => ({ id: 'ag_ada', mcp: [] }),
    });
    view = await renderWithQuery(
      <ConnectionCard
        connection={connection({ state: 'error', server: server(), problem: 'Connection failed.' })}
      />,
    );
    await click(buttonByText('Use with agents'));
    expect((document.querySelector('input') as HTMLInputElement).disabled).toBe(false);
    await click(document.querySelector('input'));
    expect(backend.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ mcp: [] });
  });
  it('disconnects only after confirmation', async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    const backend = fakeBackend({ 'DELETE /api/connections/notion': () => ({ ok: true }) });
    view = await renderWithQuery(
      <ConnectionCard connection={connection({ state: 'connected', server: server() })} />,
    );
    await click(buttonByText('Disconnect'));
    expect(backend.calls).toHaveLength(0);
    confirm.mockReturnValue(true);
    await click(buttonByText('Disconnect'));
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]?.method).toBe('DELETE');
  });
  it('explains error and sign-in states instead of hiding them', async () => {
    view = await renderWithQuery(
      <ConnectionCard
        connection={connection({ state: 'error', server: server(), problem: 'Permission denied.' })}
      />,
    );
    expect(document.body.textContent).toContain('Needs attention');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Permission denied.');
    expect(buttonByText('Reconnect')).toBeDefined();
  });
});

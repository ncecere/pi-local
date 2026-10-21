// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type McpServer } from '../../src/api/client';
import { DeleteServerDialog, EditServerDialog } from '../../src/components/mcp/server-dialogs';
import {
  buttonByText,
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
} from './ui-test-utils';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
// The in-use note links each agent to its MCP tab; no router here.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    slug: 'github',
    name: 'GitHub',
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
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

describe('Deleting an MCP server', () => {
  it("can't be pressed while agents use it, and says who", async () => {
    const backend = fakeBackend();
    view = await renderWithQuery(
      <EditServerDialog
        server={server({ usedBy: [{ id: 'ag_rex', name: 'Rex' }] })}
        onClose={() => {}}
      />,
    );
    await click(buttonByText('Delete'));
    expect(buttonByText('Delete server')?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Rex uses it. Remove it on that agent’s MCP tab');
    expect(backend.calls).toEqual([]);
  });

  it('shows the API error in the dialog when the delete fails', async () => {
    fakeBackend({
      // In use by an agent the list didn't know of yet, without the names.
      'DELETE /api/mcp/servers/github': () => {
        throw new ApiError(409, 'in_use', '1 agent(s) use this server. Remove it from them first.');
      },
    });
    const onClose = vi.fn();
    view = await renderWithQuery(<DeleteServerDialog server={server()} onClose={onClose} />);
    await click(buttonByText('Delete server'));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      '1 agent(s) use this server. Remove it from them first.',
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('names the agents a 409 in_use lists', async () => {
    fakeBackend({
      'DELETE /api/mcp/servers/github': () => {
        throw new ApiError(409, 'in_use', 'In use.', { agents: [{ id: 'ag_ada', name: 'Ada' }] });
      },
    });
    view = await renderWithQuery(<DeleteServerDialog server={server()} onClose={() => {}} />);
    await click(buttonByText('Delete server'));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Ada uses it.');
  });

  it('says a server error, too', async () => {
    fakeBackend({
      'DELETE /api/mcp/servers/github': () => {
        throw new ApiError(500, 'internal', 'The keychain could not be reached.');
      },
    });
    view = await renderWithQuery(<DeleteServerDialog server={server()} onClose={() => {}} />);
    await click(buttonByText('Delete server'));
    expect(document.body.textContent).toContain('The keychain could not be reached.');
  });
});

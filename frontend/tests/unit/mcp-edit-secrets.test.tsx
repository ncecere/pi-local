// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '../../src/api/client';
import { EditServerDialog } from '../../src/components/mcp/server-dialogs';
import {
  buttonByText,
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  typeInto,
} from './ui-test-utils';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    slug: 'tdx',
    name: 'TeamDynamix',
    description: '',
    transport: 'stdio',
    command: 'node',
    args: ['main.ts'],
    cwd: null,
    envNames: ['TDX_ALLOW_TICKET_UPDATES', 'TDX_TOKEN'],
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

const valueField = (name: string) =>
  document.querySelector(`input[aria-label="${name} value"]`) as HTMLInputElement;
const button = (label: string) =>
  document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

describe('Editing an MCP server: env values one at a time', () => {
  it('changes one value, removes one, adds one; the others are kept', async () => {
    const backend = fakeBackend({
      'PATCH /api/mcp/servers/tdx': () => server(),
    });
    view = await renderWithQuery(
      <EditServerDialog server={server({ envNames: ['A', 'B', 'C'] })} onClose={() => {}} />,
    );
    await typeInto(valueField('A'), 'new-a');
    await click(button('Remove B'));
    expect(valueField('B').disabled).toBe(true);
    await click(buttonByText('Add variable'));
    const added = document.querySelectorAll('input[aria-label^="Variable 1"]');
    await typeInto(added[0]!, 'D');
    await typeInto(added[1]!, 'dee');
    await click(buttonByText('Save'));
    const patch = backend.calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toEqual({ envSet: { A: 'new-a', D: 'dee' }, envRemove: ['B'] });
  });

  it('shows a stored value on request, and sends nothing for a value only looked at', async () => {
    const backend = fakeBackend({
      'POST /api/mcp/servers/tdx/reveal': (body) => {
        expect(body).toEqual({ kind: 'env', name: 'TDX_ALLOW_TICKET_UPDATES' });
        return { value: 'false' };
      },
      'PATCH /api/mcp/servers/tdx': () => server(),
    });
    view = await renderWithQuery(<EditServerDialog server={server()} onClose={() => {}} />);
    expect(valueField('TDX_TOKEN').value).toBe('');
    expect(valueField('TDX_ALLOW_TICKET_UPDATES').type).toBe('password');
    await click(button('Show TDX_ALLOW_TICKET_UPDATES'));
    expect(valueField('TDX_ALLOW_TICKET_UPDATES').type).toBe('text');
    expect(valueField('TDX_ALLOW_TICKET_UPDATES').value).toBe('false');
    // Nothing changed yet: Save stays off.
    expect(buttonByText('Save')?.disabled).toBe(true);
    await typeInto(valueField('TDX_ALLOW_TICKET_UPDATES'), 'true');
    await click(buttonByText('Save'));
    expect(backend.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      envSet: { TDX_ALLOW_TICKET_UPDATES: 'true' },
    });
  });

  it('refuses adding a name that is already set', async () => {
    const backend = fakeBackend({ 'PATCH /api/mcp/servers/tdx': () => server() });
    view = await renderWithQuery(<EditServerDialog server={server()} onClose={() => {}} />);
    await click(buttonByText('Add variable'));
    const added = document.querySelectorAll('input[aria-label^="Variable 1"]');
    await typeInto(added[0]!, 'TDX_TOKEN');
    await typeInto(added[1]!, 'x');
    await click(buttonByText('Save'));
    expect(document.body.textContent).toContain('TDX_TOKEN is already set');
    expect(backend.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
});

// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/api/client';
import { ToolsTab } from '../../src/components/agent-manager/tools-tab';
import {
  buttonByText,
  click,
  fakeBackend,
  fieldByLabel,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  typeInto,
} from './ui-test-utils';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const PRIVATE = '/data/agents/ag_coder/workspace';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'ag_coder',
    name: 'Coder',
    description: '',
    instructions: '',
    kind: 'personal',
    agentKind: 'coding',
    status: 'asleep',
    running: false,
    model: null,
    enabled: true,
    lastUsedAt: null,
    revision: 3,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    kindSettings: {},
    canCall: [],
    callable: [],
    dir: '/data/agents/ag_coder',
    piDurableVersion: null,
    workspace: { tools: ['read', 'write', 'edit', 'bash'], folder: '', dir: PRIVATE },
    approvals: { tools: [], timeoutSeconds: 3600 },
    mcp: [],
    ...overrides,
  };
}

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const folderInput = () => fieldByLabel('Project folder') as HTMLInputElement;

describe('Tools tab: project folder', () => {
  it('shows where it works now, and saves a typed folder with the whole workspace', async () => {
    const backend = fakeBackend({
      'PATCH /api/agents/ag_coder': (body) => ({
        ...agent(),
        ...(body as object),
        revision: 4,
      }),
    });
    view = await renderWithQuery(<ToolsTab agent={agent()} />);
    expect(document.body.textContent).toContain(`Works in ${PRIVATE}`);
    expect(folderInput().value).toBe('');
    expect(buttonByText('Use its own folder')?.disabled).toBe(true);

    await typeInto(folderInput(), '/Users/ada/code/site');
    expect(document.body.textContent).toContain('until you save.');
    await click(buttonByText('Save'));

    expect(backend.calls).toEqual([
      {
        method: 'PATCH',
        path: '/api/agents/ag_coder',
        body: {
          workspace: { tools: ['read', 'write', 'edit', 'bash'], folder: '/Users/ada/code/site' },
          approvals: { tools: [], timeoutSeconds: 3600 },
        },
      },
    ]);
  });

  it('goes back to its own folder with "Use its own folder"', async () => {
    const backend = fakeBackend({ 'PATCH /api/agents/ag_coder': () => agent({ revision: 5 }) });
    const project = agent({
      workspace: { tools: ['read'], folder: '/Users/ada/code/site', dir: '/Users/ada/code/site' },
    });
    view = await renderWithQuery(<ToolsTab agent={project} />);
    expect(folderInput().value).toBe('/Users/ada/code/site');
    expect(document.body.textContent).toContain('Works in /Users/ada/code/site');

    await click(buttonByText('Use its own folder'));
    expect(folderInput().value).toBe('');
    await click(buttonByText('Save'));
    expect(backend.calls[0]?.body).toMatchObject({ workspace: { tools: ['read'], folder: '' } });
  });

  it('picks the folder with Choose… where there is a dialog', async () => {
    const backend = fakeBackend({
      'POST /api/choose-folder': () => ({ path: '/Users/ada/code/app' }),
    });
    view = await renderWithQuery(<ToolsTab agent={agent()} />, {
      features: { folderDialog: true },
    });
    await click(buttonByText('Choose…'));
    expect(backend.calls).toEqual([
      { method: 'POST', path: '/api/choose-folder', body: undefined },
    ]);
    expect(folderInput().value).toBe('/Users/ada/code/app');
  });
});

// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Agent, ApiError, type KnowledgeInfo } from '../../src/api/client';
import { KnowledgeTab } from '../../src/components/agent-manager/knowledge-tab';
import { useAgents } from '../../src/hooks/use-agents';
import { isIndexing, knowledgeKey } from '../../src/hooks/use-knowledge';
import { agent } from './memory-fixtures';
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
let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

function Harness() {
  const current = useAgents().data?.[0];
  return current ? <KnowledgeTab agent={current} /> : null;
}
const folder = (state: 'ready' | 'indexing' | 'waiting' | 'missing' = 'ready') => ({
  path: '/docs/contracts',
  state,
  files: 2,
  passages: 8,
  problems: 1,
  tooLarge: 0,
  partial: 0,
  truncated: false,
  lastScanAt: 1_792_585_000_000,
});
function setup(folders: string[] = ['/docs/contracts']) {
  const state = {
    agent: { ...agent(), knowledge: { folders } },
    info: {
      folders: folders.map(() => folder()),
      limits: { maxFileBytes: 50 << 20, maxFiles: 10_000 },
    } as KnowledgeInfo,
  };
  const backend = fakeBackend({
    'GET /api/agents': () => [state.agent],
    'GET /api/agents/ag_rex/knowledge': () => state.info,
    'PATCH /api/agents/ag_rex': (body) => {
      state.agent = {
        ...state.agent,
        ...(body as Partial<Agent>),
        revision: state.agent.revision + 1,
      };
      return state.agent;
    },
    'POST /api/choose-folder': () => ({ path: '/docs/manuals' }),
    'POST /api/agents/ag_rex/knowledge/rescan': () => ({ ok: true }),
    'GET /api/agents/ag_rex/knowledge/problems?folder=%2Fdocs%2Fcontracts': () => [
      {
        folder: '/docs/contracts',
        path: '/docs/contracts/broken.pdf',
        rel: 'broken.pdf',
        status: 'error',
        message: 'A scanned PDF: it has no text to search.',
      },
    ],
  });
  return { backend, state };
}

describe('Knowledge tab', () => {
  it('shows counts, last update and file errors, and rescans without changing files', async () => {
    const { backend } = setup();
    view = await renderWithQuery(<Harness />);
    await settle();
    expect(document.body.textContent).toContain('2 files, 8 passages · read');
    expect(document.body.textContent).toContain("1 file couldn't be read.");
    expect(document.body.textContent).toContain('This does not allow writing');
    await click(buttonByText('Show details'));
    expect(document.body.textContent).toContain('broken.pdf: A scanned PDF');
    await click(buttonByText('Rescan'));
    expect(backend.calls.find((c) => c.path.endsWith('/rescan'))?.body).toEqual({
      path: '/docs/contracts',
    });
  });

  it('shows progress, missing folders and bounded-index warnings', async () => {
    setup();
    view = await renderWithQuery(<Harness />);
    await settle();
    const info: KnowledgeInfo = {
      folders: [{ ...folder('indexing'), progress: { done: 3, total: 10 } }],
      limits: { maxFileBytes: 50 << 20, maxFiles: 10_000 },
    };
    await act(async () => view?.queryClient.setQueryData(knowledgeKey('ag_rex'), info));
    await settle();
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Reading 3 of 10 files…');
    expect(buttonByText('Rescan')?.disabled).toBe(true);
    expect(isIndexing(info)).toBe(true);
    info.folders = [
      {
        ...folder('missing'),
        error: 'The drive is unplugged.',
        tooLarge: 2,
        partial: 1,
        truncated: true,
      },
    ];
    await act(async () => view?.queryClient.setQueryData(knowledgeKey('ag_rex'), { ...info }));
    await settle();
    expect(document.body.textContent).toContain('The drive is unplugged.');
    expect(document.body.textContent).toContain('2 files over 50 MB were skipped.');
    expect(document.body.textContent).toContain('only the first 10,000');
    expect(isIndexing(info)).toBe(false);
    expect(isIndexing(undefined)).toBe(false);
  });

  it('adds a folder with the native dialog, then removes access without deleting files', async () => {
    const { backend } = setup([]);
    view = await renderWithQuery(<Harness />, { features: { folderDialog: true } });
    await settle();
    expect(document.body.textContent).toContain('No knowledge folders yet.');
    await click(document.querySelector('[aria-label="Choose knowledge folder"]'));
    expect(backend.calls.find((c) => c.path === '/api/choose-folder')?.body).toEqual({
      title: 'Choose a knowledge folder',
    });
    await click(buttonByText('Add folder'));
    expect(backend.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      knowledge: { folders: ['/docs/manuals'] },
    });
    expect((fieldByLabel('Knowledge folder') as HTMLInputElement).value).toBe('');
    await click(document.querySelector('[aria-label="Remove /docs/manuals"]'));
    expect(backend.calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({
      knowledge: { folders: [] },
    });
    expect(backend.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('accepts a typed path without a dialog and preserves it when validation fails', async () => {
    const { backend } = setup([]);
    backend.routes['PATCH /api/agents/ag_rex'] = () => {
      throw new ApiError(400, 'invalid_knowledge_folder', 'Choose an existing folder.');
    };
    view = await renderWithQuery(<Harness />);
    await settle();
    expect(document.querySelector('[aria-label="Choose knowledge folder"]')).toBeNull();
    await typeInto(fieldByLabel('Knowledge folder'), '/missing');
    await click(buttonByText('Add folder'));
    expect(document.body.textContent).toContain('Choose an existing folder.');
    expect((fieldByLabel('Knowledge folder') as HTMLInputElement).value).toBe('/missing');
  });

  it('shows a failed status request rather than claiming the folder is ready', async () => {
    const { backend } = setup();
    backend.routes['GET /api/agents/ag_rex/knowledge'] = () => {
      throw new ApiError(500, 'internal', 'Index unavailable.');
    };
    view = await renderWithQuery(<Harness />);
    await settle();
    expect(document.body.textContent).toContain('Index unavailable.');
    expect(document.body.textContent).not.toContain('2 files, 8 passages');
  });
});

// @vitest-environment happy-dom
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import { ArtifactDraftProvider } from '../../src/components/chat/artifact-drafts';
import { DocumentsPanel } from '../../src/components/chat/documents-panel';
import { SidePanelSlotContext } from '../../src/components/layout/side-panel-slot';
import type { Artifact } from '../../src/lib/artifacts';
import {
  buttonByText,
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
  typeInto,
} from './ui-test-utils';

vi.mock('../../src/components/chat/markdown', () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
  HighlightedCode: ({ source }: { source: string }) => <pre>{source}</pre>,
}));

const first: Artifact = {
  id: 'one',
  title: 'First',
  type: 'markdown',
  content: 'Saved first',
  revision: 2,
  updatedAt: 100,
  versions: [],
};
const second: Artifact = { ...first, id: 'two', title: 'Second', content: 'Saved second' };
let view: Rendered | undefined;
let slot: HTMLDivElement;
let media: EventTarget & { matches: boolean };
let artifacts: Artifact[];

beforeEach(() => {
  artifacts = [first, second];
  media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal('matchMedia', () => media);
  slot = document.createElement('div');
  document.body.append(slot);
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
  vi.unstubAllGlobals();
});

function Harness() {
  const [context, setContext] = useState(['a', 't']);
  const [visible, setVisible] = useState(true);
  return (
    <ArtifactDraftProvider>
      <button type="button" onClick={() => setContext(['b', 't'])}>
        Other agent
      </button>
      <button type="button" onClick={() => setContext(['a', 'other'])}>
        Other thread
      </button>
      <button type="button" onClick={() => setContext(['a', 't'])}>
        Original context
      </button>
      <button type="button" onClick={() => setVisible(!visible)}>
        Navigate away/back
      </button>
      <SidePanelSlotContext.Provider value={slot}>
        {visible && (
          <DocumentsPanel
            key={JSON.stringify(context)}
            agentId={context[0]!}
            threadId={context[1]!}
            documents={{ artifacts: { revision: 'v1' } }}
          />
        )}
      </SidePanelSlotContext.Provider>
    </ArtifactDraftProvider>
  );
}

async function setup(put: (body: unknown) => unknown = () => ({})) {
  const routes = Object.fromEntries(
    [
      ['a', 't'],
      ['b', 't'],
      ['a', 'other'],
    ].map(([agent, thread]) => [
      `GET /api/agents/${agent}/threads/${thread}/documents/artifacts`,
      () => ({ kind: 'artifacts', version: 1, revision: 'v1', value: { artifacts } }),
    ]),
  );
  const backend = fakeBackend({
    ...routes,
    'GET /api/agents': () => [],
    'PUT /api/agents/a/threads/t/artifacts/one': put,
    'PUT /api/agents/a/threads/t/artifacts/two': put,
  });
  view = await renderWithQuery(<Harness />);
  await settle();
  return backend;
}

function textarea() {
  return document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Artifact content"]');
}
function labelledButton(label: string) {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}
async function resize(width: number, height: number) {
  await act(async () => {
    window.innerWidth = width;
    window.innerHeight = height;
    media.matches = width >= 1100;
    media.dispatchEvent(new Event('change'));
  });
  await settle();
}
async function select(id: string) {
  const element = document.querySelector<HTMLSelectElement>('[aria-label="Select artifact"]')!;
  await act(async () => {
    element.value = id;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function draft(text: string) {
  await click(buttonByText('Edit'));
  await typeInto(textarea(), text);
  expect(textarea()?.value).toBe(text);
}
function noWrites(backend: Awaited<ReturnType<typeof setup>>) {
  expect(backend.calls.filter((call) => call.method !== 'GET')).toEqual([]);
}

describe('window-session artifact drafts', () => {
  it('retains textarea content and selection across 1280 → 900 → 1280 responsive branches', async () => {
    const backend = await setup();
    await resize(1280, 900);
    await select('two');
    await draft('Unsaved responsive second');
    await resize(900, 700);
    await click(labelledButton('Open documents'));
    expect(textarea()?.value).toBe('Unsaved responsive second');
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Select artifact"]')?.value).toBe(
      'two',
    );
    await resize(1280, 900);
    expect(textarea()?.value).toBe('Unsaved responsive second');
    noWrites(backend);
  });

  it('keeps the actual draft through drawer Escape and explicit close/reopen', async () => {
    const backend = await setup();
    await resize(900, 700);
    await click(labelledButton('Open documents'));
    await draft('Unsaved drawer text');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(textarea()).toBeNull();
    await click(labelledButton('Open documents'));
    expect(textarea()?.value).toBe('Unsaved drawer text');
    await click(labelledButton('Close'));
    expect(textarea()).toBeNull();
    await click(labelledButton('Open documents'));
    expect(textarea()?.value).toBe('Unsaved drawer text');
    noWrites(backend);
  });

  it('keeps drafts through sidebar hide/show and section collapse/expand', async () => {
    const backend = await setup();
    await draft('Hidden draft');
    await click(labelledButton('Hide documents'));
    expect(textarea()).toBeNull();
    await click(labelledButton('Show documents'));
    expect(textarea()?.value).toBe('Hidden draft');
    await click(buttonByText('Canvas'));
    expect(textarea()).toBeNull();
    await click(buttonByText('Canvas'));
    expect(textarea()?.value).toBe('Hidden draft');
    noWrites(backend);
  });

  it('isolates artifact, agent and thread drafts and survives full conversation unmount/navigation', async () => {
    const backend = await setup();
    await draft('First draft');
    await select('two');
    expect(textarea()).toBeNull();
    await draft('Second draft');
    await click(buttonByText('Other agent'));
    expect(textarea()).toBeNull();
    await draft('Agent b draft');
    await click(buttonByText('Other thread'));
    expect(textarea()).toBeNull();
    await draft('Other thread draft');
    await click(buttonByText('Original context'));
    expect(textarea()?.value).toBe('Second draft');
    await select('one');
    expect(textarea()?.value).toBe('First draft');
    await click(buttonByText('Navigate away/back'));
    expect(textarea()).toBeNull();
    await click(buttonByText('Navigate away/back'));
    expect(textarea()?.value).toBe('First draft');
    await click(buttonByText('Other agent'));
    expect(textarea()?.value).toBe('Agent b draft');
    await click(buttonByText('Other thread'));
    expect(textarea()?.value).toBe('Other thread draft');
    noWrites(backend);
  });

  it('does not clear later edits when a save completes after an editor remount', async () => {
    let complete!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      complete = resolve;
    });
    const backend = await setup(() => pending);
    await draft('Submitted snapshot');
    await click(buttonByText('Save revision'));
    expect(textarea()?.disabled).toBe(true);
    await click(labelledButton('Hide documents'));
    await click(labelledButton('Show documents'));
    expect(textarea()?.value).toBe('Submitted snapshot');
    await typeInto(textarea(), 'Later unsaved changes');
    await act(async () => {
      complete({});
    });
    await settle();
    expect(textarea()?.value).toBe('Later unsaved changes');
    expect(backend.calls.filter((call) => call.method === 'PUT')).toMatchObject([
      { body: { content: 'Submitted snapshot', expectedRevision: 2 } },
    ]);
    await click(buttonByText('Discard draft'));
    expect(textarea()).toBeNull();
  });

  it('clears only the saved or discarded draft, and never silently rebases after conflict/refetch', async () => {
    let conflict = true;
    const backend = await setup((body) => {
      if (conflict) throw new ApiError(409, 'revision_conflict', 'Revision conflict');
      artifacts = [
        { ...first, revision: 4, content: (body as { content: string }).content },
        second,
      ];
      return artifacts[0];
    });
    await draft('Original base draft');
    await select('two');
    await draft('Keep second');
    // A concurrent model update must not change the captured base or draft text.
    artifacts = [
      { ...first, title: 'New model title', revision: 3, content: 'Concurrent saved content' },
      second,
    ];
    await act(async () => {
      await view!.queryClient.invalidateQueries({ queryKey: ['thread-document'] });
    });
    await click(labelledButton('Hide documents'));
    await click(labelledButton('Show documents'));
    await select('one');
    expect(textarea()?.value).toBe('Original base draft');
    await click(buttonByText('Save revision'));
    expect(textarea()?.value).toBe('Original base draft');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Revision conflict');
    const writes = () => backend.calls.filter((call) => call.method === 'PUT');
    expect(writes()[0]).toMatchObject({
      path: '/api/agents/a/threads/t/artifacts/one',
      body: { title: 'First', content: 'Original base draft', expectedRevision: 2 },
    });
    await resize(900, 700);
    await click(labelledButton('Open documents'));
    expect(textarea()?.value).toBe('Original base draft');
    // No automatic retry or rebase on remount, even after a 409.
    expect(writes()).toHaveLength(1);
    conflict = false;
    await click(buttonByText('Save revision'));
    expect(writes()[1]?.body).toEqual(writes()[0]?.body);
    expect(textarea()).toBeNull();
    expect(document.body.textContent).toContain('Original base draft');
    await click(buttonByText('Edit'));
    expect(textarea()?.value).toBe('Original base draft');
    await typeInto(textarea(), 'Discard this');
    await click(buttonByText('Discard draft'));
    await click(labelledButton('Close'));
    await click(labelledButton('Open documents'));
    expect(textarea()).toBeNull();
    await click(buttonByText('Edit'));
    expect(textarea()?.value).toBe('Original base draft');
    await click(buttonByText('Discard draft'));
    await select('two');
    expect(textarea()?.value).toBe('Keep second');
    expect(writes()).toHaveLength(2);
  });
});

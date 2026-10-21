// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import { ArtifactCanvas, ArtifactPreview } from '../../src/components/chat/artifact-canvas';
import { DocumentsPanel } from '../../src/components/chat/documents-panel';
import { SidePanelSlotContext } from '../../src/components/layout/side-panel-slot';
import { type Artifact, artifactHtml, csvRows } from '../../src/lib/artifacts';
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

vi.mock('../../src/hooks/use-media-query', () => ({ useMediaQuery: () => true }));
vi.mock('../../src/components/chat/markdown', () => ({
  Markdown: ({ children, skipHtml }: { children: string; skipHtml: boolean }) => (
    <div data-safe-markdown={String(skipHtml)}>{children}</div>
  ),
  HighlightedCode: ({ source, language }: { source: string; language: string }) => (
    <pre data-language={language}>{source}</pre>
  ),
}));
const artifact: Artifact = {
  id: 'art_one',
  title: 'Report',
  type: 'markdown',
  content: '# Current',
  revision: 2,
  updatedAt: 100,
  versions: [{ title: 'Report', type: 'markdown', content: '# Before', revision: 1, updatedAt: 1 }],
};
let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

describe('CSV records', () => {
  it.each([
    ['', []],
    ['""', [['']]],
    ['name\n""', [['name'], ['']]],
    ['"",""', [['', '']]],
    ['""\n""', [[''], ['']]],
    [
      'name,value\r\n"",""',
      [
        ['name', 'value'],
        ['', ''],
      ],
    ],
    ['"say ""hi""",""', [['say "hi"', '']]],
    [
      '"multi\r\nline",""\r\n"","x"',
      [
        ['multi\r\nline', ''],
        ['', 'x'],
      ],
    ],
  ] as [string, string[][]][])(
    'preserves records in %j with or without a terminal newline',
    (content, expected) => {
      expect(csvRows(content)).toEqual(expected);
      if (content) {
        expect(csvRows(`${content}\n`)).toEqual(expected);
        expect(csvRows(`${content}\r\n`)).toEqual(expected);
      }
    },
  );
});

describe('artifact canvas', () => {
  it('shares one side panel with the conversation documents', async () => {
    fakeBackend({
      'GET /api/agents': () => [],
      'GET /api/agents/ag_a/threads/t/documents/artifacts': () => ({
        kind: 'artifacts',
        version: 1,
        revision: 'a',
        value: { artifacts: [artifact] },
      }),
      'GET /api/agents/ag_a/threads/t/documents/todo': () => ({
        kind: 'todo',
        version: 1,
        revision: 'b',
        value: { items: [{ text: 'Keep the checklist', status: 'doing' }] },
      }),
    });
    const slot = document.createElement('div');
    document.body.append(slot);
    view = await renderWithQuery(
      <SidePanelSlotContext.Provider value={slot}>
        <DocumentsPanel
          agentId="ag_a"
          threadId="t"
          documents={{ artifacts: { revision: 'a' }, todo: { revision: 'b' } }}
        />
      </SidePanelSlotContext.Provider>,
    );
    await settle();
    expect(slot.querySelectorAll('aside')).toHaveLength(1);
    expect(slot.textContent).toContain('Canvas & documents');
    expect(slot.textContent).toContain('Keep the checklist');
    expect(slot.querySelector('[aria-label="Artifact canvas"]')).not.toBeNull();
    expect(buttonByText('Save to workspace')).toBeUndefined();
  });
  it('renders safe Markdown, highlighted code, and literal CSV without executing formulas or HTML', async () => {
    view = await renderWithQuery(<ArtifactPreview artifact={artifact} />);
    expect(view.container.querySelector('[data-safe-markdown="true"]')?.textContent).toBe(
      '# Current',
    );
    view.unmount();
    view = await renderWithQuery(
      <ArtifactPreview
        artifact={{
          ...artifact,
          type: 'code',
          language: 'js',
          content: 'throw new Error("never run")',
        }}
      />,
    );
    expect(view.container.querySelector('[data-language="js"]')?.textContent).toContain(
      'never run',
    );
    view.unmount();
    view = await renderWithQuery(
      <ArtifactPreview
        artifact={{
          ...artifact,
          type: 'csv',
          content: 'name,value\r\n"<img src=x>","=SUM(1,2)"\r\n"multi\nline","say ""hi"""',
        }}
      />,
    );
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.textContent).toContain('=SUM(1,2)');
    expect(csvRows('"a,b","x""y"\n1,2')).toEqual([
      ['a,b', 'x"y'],
      ['1', '2'],
    ]);
  });
  it('blocks hostile links, refresh, forms, fetches, script and navigation in HTML, in addition to iframe isolation', async () => {
    const content = `<meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test"><a href="https://evil.test" target="_top" download onclick="alert(1)">Leave</a><form action="https://evil.test"><button formaction="https://evil.test">Send</button></form><script>fetch('https://evil.test')</script><iframe src="https://evil.test"></iframe><img src="https://evil.test"><svg><a href="https://evil.test">SVG</a></svg><div onmouseover="alert(1)" style="color: red">Safe</div><style>@import url(https://evil.test);</style>`;
    view = await renderWithQuery(
      <ArtifactPreview artifact={{ ...artifact, type: 'html', content }} />,
    );
    const frame = view.container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.hasAttribute('src')).toBe(false);
    const preview = document.createElement('template');
    preview.innerHTML = frame.srcdoc;
    expect(
      preview.content.querySelector('a, form, button, base, script, iframe, img, svg'),
    ).toBeNull();
    expect(
      preview.content.querySelector(
        '[href], [src], [action], [onclick], [onmouseover], [download], [target]',
      ),
    ).toBeNull();
    expect(preview.content.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    const csp = preview.content
      .querySelector('meta[http-equiv="Content-Security-Policy"]')!
      .getAttribute('content');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).not.toContain('navigate-to');
    expect(artifactHtml('<a href="javascript:alert(1)">test</a>')).not.toContain('javascript:');
  });
  it('saves with a captured revision, preserves the draft on conflict, and reads historical versions', async () => {
    let conflict = true;
    const backend = fakeBackend({
      'GET /api/agents': () => [],
      'PUT /api/agents/ag_a/threads/t/artifacts/art_one': () => {
        if (conflict)
          throw new ApiError(409, 'revision_conflict', 'Artifact changed. Read it again.');
        return { ...artifact, revision: 3 };
      },
      'GET /api/agents/ag_a/threads/t/artifacts/art_one/history': () => artifact.versions,
    });
    view = await renderWithQuery(
      <ArtifactCanvas agentId="ag_a" threadId="t" value={{ artifacts: [artifact] }} />,
    );
    await click(buttonByText('Edit'));
    await typeInto(view.container.querySelector('textarea'), 'My draft');
    await click(buttonByText('Save revision'));
    expect(view.container.querySelector('textarea')?.value).toBe('My draft');
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Artifact changed',
    );
    expect(backend.calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
      content: 'My draft',
      expectedRevision: 2,
    });
    conflict = false;
    await click(buttonByText('Save revision'));
    expect(view.container.querySelector('textarea')).toBeNull();
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain(
      'Saved a new revision',
    );
    await click(buttonByText('History'));
    const select = view.container.querySelector<HTMLSelectElement>(
      '[aria-label="Artifact version"]',
    )!;
    await act(async () => {
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(view.container.textContent).toContain('# Before');
    expect(buttonByText('Edit')?.disabled).toBe(true);
  });
});

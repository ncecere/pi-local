// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentValue } from '../../src/components/chat/document-views';
import { agentToolStep, type ToolPart, ToolStepRow } from '../../src/components/chat/tool-steps';
import { asTodoList, documentTitle } from '../../src/lib/thread-documents';
import {
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

const ITEMS = [
  { text: 'Read the brief', status: 'done' },
  { text: 'Draft the outline', status: 'done' },
  { text: 'Write the intro', status: 'doing' },
  { text: 'Add the figures', status: 'pending' },
  { text: 'Proofread', status: 'pending' },
];

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-todo-status]')];

function expectChecklist() {
  expect(document.querySelector('[data-todo]')?.textContent).toContain('2 of 5 done');
  expect(rows().map((row) => row.getAttribute('data-todo-status'))).toEqual([
    'done',
    'done',
    'doing',
    'pending',
    'pending',
  ]);
  // Done items are struck through; the others are not.
  expect(rows().map((row) => row.querySelector('p')?.classList.contains('line-through'))).toEqual([
    true,
    true,
    false,
    false,
    false,
  ]);
  // Done: a check. Doing: a spinner. Pending: an empty circle.
  const icon = (index: number) => rows()[index]?.querySelector('svg')?.getAttribute('class') ?? '';
  expect(icon(0)).toContain('lucide-check');
  expect(icon(2)).toContain('animate-spin');
  expect(icon(3)).toContain('lucide-circle');
  expect(icon(3)).not.toContain('animate-spin');
  // Said for a screen reader too.
  expect(rows()[2]?.textContent).toContain('Doing: Write the intro');
}

describe('The checklist document', () => {
  it('is drawn as a checklist with how many are done', async () => {
    view = await renderWithQuery(<DocumentValue kind="todo" value={{ items: ITEMS }} />);
    expectChecklist();
    expect(document.querySelector('pre')).toBeNull();
  });

  it('has a name, and says when it is empty', async () => {
    expect(documentTitle('todo')).toBe('Checklist');
    view = await renderWithQuery(<DocumentValue kind="todo" value={{ items: [] }} />);
    expect(document.body.textContent).toContain('No items yet.');
  });

  it('falls back to JSON for a shape it does not know', async () => {
    expect(asTodoList({ items: [{ nope: 1 }] })).toBeNull();
    view = await renderWithQuery(<DocumentValue kind="todo" value={{ items: 'soon' }} />);
    expect(document.querySelector('pre')?.textContent).toContain('"soon"');
    expect(document.querySelector('[data-todo]')).toBeNull();
  });
});

function todoPart(over: Record<string, unknown> = {}): ToolPart {
  return {
    type: 'dynamic-tool',
    toolName: 'todo',
    toolCallId: 'call_todo',
    state: 'output-available',
    input: { items: ITEMS },
    output: { text: 'Checklist saved.' },
    toolMetadata: { details: { items: ITEMS } },
    ...over,
  };
}

async function showStep(part: ToolPart) {
  fakeBackend({ 'GET /api/agents': () => [] });
  view = await renderWithQuery(<ToolStepRow part={part} step={agentToolStep(part)} />);
  await settle();
}

describe("The todo tool's step", () => {
  it('says how far along the list is on its line', async () => {
    await showStep(todoPart());
    expect(document.querySelector('button[aria-expanded]')?.textContent).toContain('2 of 5 done');
  });

  it("shows the checklist from the call's details, not JSON", async () => {
    await showStep(todoPart());
    await click(document.querySelector('button[aria-expanded]'));
    expectChecklist();
    expect(document.querySelector('pre')).toBeNull();
    expect(document.body.textContent).not.toContain('"items"');
  });

  it('keeps the usual rows for a call that failed or has no details', async () => {
    await showStep(todoPart({ state: 'output-error', toolMetadata: undefined }));
    await click(document.querySelector('button[aria-expanded]'));
    expect(document.querySelector('[data-todo]')).toBeNull();
    expect(document.querySelector('pre')).not.toBeNull();
  });
});

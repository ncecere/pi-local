// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type LibraryPrompt } from '../../src/api/client';
import { SettingsPromptsPage } from '../../src/routes/settings/prompts';
import {
  buttonByText,
  click,
  dialogButton,
  fakeBackend,
  fieldByLabel,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
  typeInto,
} from './ui-test-utils';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
  toast.mockClear();
  toast.error.mockClear();
});

const prompt = (
  id: string,
  title: string,
  body: string,
  placeholders: string[] = [],
): LibraryPrompt => ({
  id,
  title,
  description: '',
  body,
  placeholders,
  updatedAt: '2026-10-21T00:00:00Z',
});
const summarize = prompt(
  'summarize',
  'Summarize a document',
  'Summarize {{document}} for {{audience}}.',
  ['document', 'audience'],
);

async function mount(prompts: LibraryPrompt[], routes: Parameters<typeof fakeBackend>[0] = {}) {
  const backend = fakeBackend({ 'GET /api/prompts': () => ({ prompts }), ...routes });
  view = await renderWithQuery(<SettingsPromptsPage />);
  await settle();
  return backend;
}

describe('Settings → Prompts', () => {
  it('says so when there are none', async () => {
    await mount([]);
    expect(document.body.textContent).toContain('No prompts yet.');
    expect(buttonByText('Export all')?.disabled).toBe(true);
  });

  it('lists prompts with their command and their blanks', async () => {
    await mount([summarize, prompt('plain', 'Plain', 'Just text')]);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Summarize a document');
    expect(text).toContain('/summarize');
    expect(text).toContain('{{document}}');
    expect(text).toContain('{{audience}}');
    expect(text).toContain('Just text');
  });

  it('adds a prompt, showing the blanks it found as the text is typed', async () => {
    const created = prompt('weekly-update', 'Weekly update', 'Update for {{team}}', ['team']);
    const backend = await mount([], { 'POST /api/prompts': () => created });
    await click(buttonByText('New prompt'));
    expect(buttonByText('Add prompt')?.disabled).toBe(true);
    await typeInto(fieldByLabel('Title'), 'Weekly update');
    await typeInto(fieldByLabel('Text'), 'Update for {{team}}');
    expect(document.body.textContent).toContain('Blanks to fill in: team');
    await click(buttonByText('Add prompt'));
    expect(backend.calls.find((c) => c.method === 'POST')?.body).toEqual({
      title: 'Weekly update',
      description: '',
      body: 'Update for {{team}}',
    });
    expect(toast).toHaveBeenCalledWith('Prompt added.');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('edits a prompt in place', async () => {
    const backend = await mount([summarize], { 'PUT /api/prompts/summarize': () => summarize });
    await click(document.querySelector('[aria-label="Edit Summarize a document"]'));
    expect((fieldByLabel('Title') as HTMLInputElement).value).toBe('Summarize a document');
    await typeInto(fieldByLabel('Title'), 'Summarize');
    await click(buttonByText('Save'));
    expect(backend.calls.find((c) => c.method === 'PUT')).toMatchObject({
      path: '/api/prompts/summarize',
      body: { title: 'Summarize', body: 'Summarize {{document}} for {{audience}}.' },
    });
  });

  it('keeps the dialog open and says why when the API refuses', async () => {
    await mount([], {
      'POST /api/prompts': () => {
        throw new ApiError(400, 'invalid_prompt', 'A title is at most 100 characters.');
      },
    });
    await click(buttonByText('New prompt'));
    await typeInto(fieldByLabel('Title'), 'x');
    await typeInto(fieldByLabel('Text'), 'y');
    await click(buttonByText('Add prompt'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'A title is at most 100 characters.',
    );
  });

  it('deletes after asking', async () => {
    const backend = await mount([summarize], {
      'DELETE /api/prompts/summarize': () => ({ ok: true }),
    });
    await click(document.querySelector('[aria-label="Delete Summarize a document"]'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Delete “Summarize a document”?',
    );
    await click(dialogButton('Delete'));
    expect(
      backend.calls.some((c) => c.method === 'DELETE' && c.path === '/api/prompts/summarize'),
    ).toBe(true);
  });

  async function importFile(file: File) {
    const input = document.querySelector('[data-testid="import-prompts"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  }

  it('imports a Markdown file by its bytes, naming it, and says how many came in', async () => {
    const backend = await mount([], {
      'POST /api/prompts/import?name=ideas.md': () => ({
        prompts: [prompt('ideas', 'Ideas', 'x')],
        skipped: 0,
      }),
      'POST /api/prompts/import?name=all.zip': () => ({
        prompts: [prompt('a', 'A', 'x'), prompt('b', 'B', 'y')],
        skipped: 1,
      }),
    });
    await importFile(new File(['---\ntitle: Ideas\n---\nGive me ideas'], 'ideas.md'));
    expect(String(backend.calls.find((c) => c.path.includes('ideas.md'))?.body)).toContain(
      'Give me ideas',
    );
    expect(toast).toHaveBeenCalledWith('1 prompt imported.');
    await importFile(new File(['PK'], 'all.zip'));
    expect(toast).toHaveBeenCalledWith('2 prompts imported; 1 file was skipped.');
  });

  it('shows what was wrong with a file that is not a prompt', async () => {
    await mount([], {
      'POST /api/prompts/import?name=x.md': () => {
        throw new ApiError(
          400,
          'invalid_prompt',
          'Nothing in that file is a prompt: it needs some text and a title.',
        );
      },
    });
    await importFile(new File(['   '], 'x.md'));
    expect(document.body.textContent).toContain(
      "That file can't be imported: Nothing in that file is a prompt",
    );
  });

  it('exports all through the Save dialog when there is one', async () => {
    const backend = await mount([summarize], {
      'POST /api/prompts/export-save': () => ({ path: '/Users/me/pi-local-prompts.zip' }),
    });
    await click(buttonByText('Export all'));
    expect(backend.calls.some((c) => c.path === '/api/prompts/export-save')).toBe(true);
    expect(toast).toHaveBeenCalledWith('Saved /Users/me/pi-local-prompts.zip.');
  });
});

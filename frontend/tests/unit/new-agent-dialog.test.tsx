// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import type { AgentCatalog } from '../../src/hooks/use-agents';
import { AgentDialog } from '../../src/routes/settings/agents';
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

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const CATALOG: AgentCatalog = {
  templates: [
    { id: 'assistant', name: 'Assistant', description: 'A general assistant.' },
    { id: 'researcher', name: 'Researcher', description: 'Plans research.' },
    { id: 'coding', name: 'Coding', description: 'Works in a project folder.' },
  ],
  models: [{ id: 'demo/echo', name: 'Echo' }],
  defaultModelId: 'demo/echo',
  allowModelChoice: false,
  limit: 20,
  used: 0,
};

const created = (body: unknown) => ({
  id: 'ag_new',
  name: (body as { name: string }).name,
  revision: 1,
});

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

async function openDialog(features = {}) {
  view = await renderWithQuery(<AgentDialog agent={null} catalog={CATALOG} onClose={() => {}} />, {
    features,
  });
}

const radio = (name: string) =>
  [...document.querySelectorAll('label')]
    .find((label) => label.textContent?.startsWith(name))
    ?.querySelector('input[type="radio"]');

describe('new agent dialog', () => {
  it("offers the catalog's templates, with no triage", async () => {
    fakeBackend();
    await openDialog();
    const names = [...document.querySelectorAll('fieldset label')].map(
      (label) => label.querySelector('.font-medium')?.textContent,
    );
    expect(names).toEqual(['Assistant', 'Researcher', 'Coding']);
    expect(document.body.textContent).not.toContain('Triage');
  });

  it('shows the project folder only for coding, and sends it with the coding tools', async () => {
    const backend = fakeBackend({ 'POST /api/agents': created });
    await openDialog();
    expect(fieldByLabel('Project folder')).toBeNull();

    await click(radio('Coding'));
    const folder = fieldByLabel('Project folder');
    expect(folder).not.toBeNull();
    expect(document.body.textContent).toContain(
      "It also follows the folder's AGENTS.md or CLAUDE.md.",
    );
    expect(document.body.textContent).toContain(
      'Added to the coding prompt, like an AGENTS.md of its own.',
    );
    // No dialog without the feature: the path is typed.
    expect(buttonByText('Choose…')).toBeUndefined();

    await typeInto(fieldByLabel('Name'), 'Coder');
    await typeInto(folder, '  /Users/ada/code/site ');
    await click(buttonByText('Make agent'));

    expect(backend.calls).toEqual([
      {
        method: 'POST',
        path: '/api/agents',
        body: {
          name: 'Coder',
          templateId: 'coding',
          workspace: { tools: ['read', 'write', 'edit', 'bash'], folder: '/Users/ada/code/site' },
        },
      },
    ]);
  });

  it('sends no workspace for coding without a folder, or for another kind', async () => {
    const backend = fakeBackend({ 'POST /api/agents': created });
    await openDialog();
    await click(radio('Coding'));
    await typeInto(fieldByLabel('Name'), 'Coder');
    await click(buttonByText('Make agent'));
    expect(backend.calls[0]?.body).toEqual({ name: 'Coder', templateId: 'coding' });
  });

  it("shows the server's message for a folder it refuses", async () => {
    fakeBackend({
      'POST /api/agents': () => {
        throw new ApiError(
          400,
          'invalid_workspace_folder',
          "/nope isn't a folder on this computer.",
        );
      },
    });
    await openDialog();
    await click(radio('Coding'));
    await typeInto(fieldByLabel('Name'), 'Coder');
    await typeInto(fieldByLabel('Project folder'), '/nope');
    await click(buttonByText('Make agent'));
    const folder = fieldByLabel('Project folder');
    expect(folder?.getAttribute('aria-invalid')).toBe('true');
    const hint = document.getElementById(folder?.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe("/nope isn't a folder on this computer.");
  });

  it('fills the field from the folder dialog with Choose…', async () => {
    const backend = fakeBackend({
      'POST /api/choose-folder': () => ({ path: '/Users/ada/code/app' }),
      'POST /api/agents': created,
    });
    await openDialog({ folderDialog: true });
    await click(radio('Coding'));
    await click(buttonByText('Choose…'));

    expect(backend.calls).toEqual([
      { method: 'POST', path: '/api/choose-folder', body: undefined },
    ]);
    expect((fieldByLabel('Project folder') as HTMLInputElement).value).toBe('/Users/ada/code/app');

    await typeInto(fieldByLabel('Name'), 'Coder');
    await click(buttonByText('Make agent'));
    expect(backend.calls[1]?.body).toMatchObject({
      workspace: { folder: '/Users/ada/code/app' },
    });
  });

  it('leaves the field alone when the folder dialog is cancelled', async () => {
    fakeBackend({ 'POST /api/choose-folder': () => ({ cancelled: true }) });
    await openDialog({ folderDialog: true });
    await click(radio('Coding'));
    await typeInto(fieldByLabel('Project folder'), '/Users/ada/code/old');
    await click(buttonByText('Choose…'));
    expect((fieldByLabel('Project folder') as HTMLInputElement).value).toBe('/Users/ada/code/old');
  });
});

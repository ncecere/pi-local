// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AgentSkills, ApiError } from '../../src/api/client';
import { SkillsTab } from '../../src/components/agent-manager/skills-tab';
import { agent } from './memory-fixtures';
import {
  buttonByText,
  click,
  dialogButton,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
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

const skill = (name: string, description: string, extra = {}) => ({
  name,
  description,
  fileCount: 2,
  bytes: 100,
  ...extra,
});
const listing = (change: Partial<AgentSkills> = {}): AgentSkills => ({
  own: [skill('house-style', 'Our house style for emails.')],
  shared: [
    { ...skill('release-notes', 'Write release notes from a changelog.'), enabled: true },
    { ...skill('pdf-tools', 'Fill and merge PDFs.'), enabled: false },
    {
      ...skill('handmade', '', {
        problem:
          "SKILL.md's front matter needs a description: it tells the agent when to use the skill.",
      }),
      enabled: false,
    },
  ],
  enabled: ['release-notes'],
  missing: [],
  folder: '/data/agents/ag_rex/skills',
  ...change,
});

const rex = agent({ skills: ['release-notes'], running: true });
const BASE = '/api/agents/ag_rex/skills';

async function mount(routes: Parameters<typeof fakeBackend>[0] = {}) {
  const backend = fakeBackend({ [`GET ${BASE}`]: () => listing(), ...routes });
  view = await renderWithQuery(<SkillsTab agent={rex} />);
  await settle();
  return backend;
}

/** Hands a hidden file input the files a person picked, and fires its change. */
async function pick(testId: string, files: File[]) {
  const input = document.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

describe('the Skills tab', () => {
  it('lists the agent’s own skills and the shared ones, with what is switched on', async () => {
    await mount();
    const text = document.body.textContent ?? '';
    expect(text).toContain("Rex's own skills");
    expect(text).toContain('house-style');
    expect(text).toContain('Our house style for emails.');
    expect(text).toContain('release-notes');
    const switches = [...document.querySelectorAll('[role="switch"]')] as HTMLButtonElement[];
    expect(
      switches.map((s) => [
        s.getAttribute('aria-label'),
        s.getAttribute('aria-checked'),
        s.disabled,
      ]),
    ).toEqual([
      ['Use release-notes', 'true', false],
      ['Use pdf-tools', 'false', false],
      // A skill that can't be used yet can't be switched on.
      ['Use handmade', 'false', true],
    ]);
    expect(text).toContain('Not used yet: SKILL.md');
  });

  it('switches a shared skill on and says the agent restarts', async () => {
    const backend = await mount({
      [`PUT ${BASE}`]: () => ({ ...rex, skills: ['release-notes', 'pdf-tools'], running: true }),
    });
    await click(document.querySelector('[aria-label="Use pdf-tools"]'));
    const put = backend.calls.find((c) => c.method === 'PUT');
    expect(put).toMatchObject({ path: BASE, body: { enabled: ['release-notes', 'pdf-tools'] } });
    expect(toast).toHaveBeenCalledWith('Rex saved. It restarts with the change.');
    // And off again.
    backend.routes[`PUT ${BASE}`] = () => ({ ...rex, skills: [] });
    await click(document.querySelector('[aria-label="Use release-notes"]'));
    expect(backend.calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ enabled: [] });
  });

  it('says when a skill that was switched on is gone', async () => {
    await mount({ [`GET ${BASE}`]: () => listing({ missing: ['old-skill'] }) });
    expect(document.body.textContent).toContain(
      'old-skill is switched on but not in the shared skills any more.',
    );
  });

  it('can remove missing selections without dropping valid skills', async () => {
    const backend = await mount({
      [`GET ${BASE}`]: () =>
        listing({ missing: ['old-skill'], enabled: ['old-skill', 'release-notes'] }),
      [`PUT ${BASE}`]: () => rex,
    });
    await click(buttonByText('Remove missing skills'));
    expect(backend.calls.find((c) => c.method === 'PUT')?.body).toEqual({
      enabled: ['release-notes'],
    });
  });

  it('adds an own skill from a zip: the bytes go to the agent’s skills, and it says so', async () => {
    const backend = await mount({ [`POST ${BASE}`]: () => skill('house-style', 'x') });
    await pick('zip-own', [new File(['PK\u0003\u0004zip bytes'], 'house-style.zip')]);
    const post = backend.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe(BASE);
    expect(String(post?.body)).toContain('zip bytes');
    expect(toast).toHaveBeenCalledWith('house-style added.');
  });

  it('adds a shared skill from a folder: it is zipped here with its paths, hidden files left out', async () => {
    const file = (path: string, content: string) => {
      const f = new File([content], path.split('/').pop() ?? path);
      Object.defineProperty(f, 'webkitRelativePath', { value: path });
      return f;
    };
    const backend = await mount({ 'POST /api/skills': () => skill('pdf-tools', 'x') });
    await pick('folder-shared', [
      file('pdf-tools/SKILL.md', 'the instructions'),
      file('pdf-tools/scripts/run.sh', 'echo'),
      file('pdf-tools/.DS_Store', 'junk'),
    ]);
    const body = String(backend.calls.find((c) => c.path === '/api/skills')?.body);
    expect(body.startsWith('PK')).toBe(true);
    expect(body).toContain('pdf-tools/SKILL.md');
    expect(body).toContain('pdf-tools/scripts/run.sh');
    expect(body).not.toContain('.DS_Store');
  });

  it('says plainly when a folder is not a skill, without asking the API', async () => {
    const backend = await mount();
    const f = new File(['x'], 'readme.md');
    Object.defineProperty(f, 'webkitRelativePath', { value: 'docs/readme.md' });
    await pick('folder-own', [f]);
    expect(document.body.textContent).toContain('SKILL.md at its top');
    expect(backend.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('shows what the API refused', async () => {
    await mount({
      [`POST ${BASE}`]: () => {
        throw new ApiError(400, 'invalid_skill', 'SKILL.md’s front matter needs a name.');
      },
    });
    await pick('zip-own', [new File(['PK'], 'bad.zip')]);
    expect(document.body.textContent).toContain(
      "That can't be added: SKILL.md’s front matter needs a name.",
    );
  });

  it('asks before replacing a skill that is already there, then replaces it', async () => {
    let attempts = 0;
    const backend = await mount({
      [`POST ${BASE}`]: () => {
        attempts++;
        throw new ApiError(409, 'exists', 'There is already a skill called house-style.');
      },
      [`POST ${BASE}?replace=true`]: () => skill('house-style', 'x'),
    });
    await pick('zip-own', [new File(['PK zip'], 'house-style.zip')]);
    expect(attempts).toBe(1);
    expect(document.body.textContent).toContain('There is already a skill called house-style.');
    await click(dialogButton('Replace'));
    expect(backend.calls.filter((c) => c.method === 'POST').at(-1)?.path).toBe(
      `${BASE}?replace=true`,
    );
    expect(toast).toHaveBeenCalledWith('Skill replaced.');
  });

  it('views a skill: its instructions, then a file when picked', async () => {
    await mount({
      'GET /api/skills/release-notes': () => ({
        skill: {
          ...skill('release-notes', 'Write release notes from a changelog.'),
          body: '# Release notes\n\nGroup changes by area.',
          folder: '/data/skills/release-notes',
          files: [
            { path: 'SKILL.md', size: 80 },
            { path: 'references/style.md', size: 20 },
          ],
        },
      }),
      'GET /api/skills/release-notes/file?path=references%2Fstyle.md': () => ({
        path: 'references/style.md',
        content: 'Use the past tense.',
        truncated: false,
      }),
    });
    await click(document.querySelector('[aria-label="View release-notes"]'));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Group changes by area.');
    expect(dialog?.textContent).toContain('/data/skills/release-notes');
    // SKILL.md is the instructions above, not a file in the list.
    expect(dialog?.textContent).toContain('references/style.md');
    expect(dialog?.querySelectorAll('li').length).toBe(1);
    await click(buttonByText(/references\/style\.md/));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Use the past tense.');
  });

  it('deletes a shared skill after asking, and an own one by its own path', async () => {
    const backend = await mount({
      'DELETE /api/skills/pdf-tools': () => ({ ok: true }),
      [`DELETE ${BASE}/house-style`]: () => ({ ok: true }),
    });
    await click(document.querySelector('[aria-label="Delete pdf-tools"]'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'every agent that used it stops using it',
    );
    await click(dialogButton('Delete'));
    expect(
      backend.calls.some((c) => c.method === 'DELETE' && c.path === '/api/skills/pdf-tools'),
    ).toBe(true);

    await click(document.querySelector('[aria-label="Remove house-style"]'));
    await click(dialogButton('Remove'));
    expect(
      backend.calls.some((c) => c.method === 'DELETE' && c.path === `${BASE}/house-style`),
    ).toBe(true);
  });
});

// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type UpdateStatus } from '../../src/api/client';
import { UpdatesSection, updateHeadline } from '../../src/components/settings/updates-section';
import { UPDATE_KEY } from '../../src/hooks/use-update';
import {
  buttonByText,
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
// The release notes go through the chat's Markdown renderer; here, its text is enough.
vi.mock('../../src/components/chat/markdown', () => ({
  MARKDOWN_PROSE: '',
  Markdown: ({ children }: { children: string }) => <div data-markdown>{children}</div>,
}));

const UP_TO_DATE: UpdateStatus = {
  current: '0.2.0',
  latest: {
    version: '0.2.0',
    notes: '',
    url: 'https://github.com/example/pi-local/releases/tag/v0.2.0',
    published: '2026-10-01T00:00:00Z',
  },
  available: false,
  checkedAt: Date.now() - 5 * 60_000,
  error: null,
  canInstall: true,
  installBlocked: null,
  autoCheck: true,
  stage: null,
};

const AVAILABLE: UpdateStatus = {
  ...UP_TO_DATE,
  current: '0.1.0',
  latest: {
    version: '0.2.0',
    notes: '## What changed\n\n- Coding agents',
    url: 'https://github.com/example/pi-local/releases/tag/v0.2.0',
    published: '2026-10-01T00:00:00Z',
  },
  available: true,
};

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const text = () => document.body.textContent ?? '';

async function show(status: UpdateStatus, routes = {}) {
  const backend = fakeBackend({ 'GET /api/update': () => status, ...routes });
  view = await renderWithQuery(<UpdatesSection />);
  await settle();
  return backend;
}

describe('Settings → About → Updates', () => {
  it('says it is up to date, with the version and when it last checked', async () => {
    const backend = await show(UP_TO_DATE, {
      'POST /api/update/check': () => ({ ...UP_TO_DATE, checkedAt: Date.now() }),
    });
    expect(text()).toContain('Pi Local is up to date');
    expect(text()).toContain('This is version 0.2.0.');
    expect(text()).toContain('Checked 5m ago.');
    expect(buttonByText('Install and restart')).toBeUndefined();
    expect(text()).not.toContain('Download from GitHub');

    await click(buttonByText('Check now'));
    expect(backend.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/update/check' });
    expect(text()).toContain('Checked just now.');
  });

  it('shows an update with its notes, and installs it', async () => {
    const backend = await show(AVAILABLE, {
      'POST /api/update/install': () => ({ ...AVAILABLE, stage: 'downloading' }),
    });
    expect(text()).toContain('Version 0.2.0 is available');
    expect(text()).toContain('This is version 0.1.0. The latest is 0.2.0.');
    expect(document.querySelector('[data-markdown]')?.textContent).toContain('Coding agents');

    await click(buttonByText('Install and restart'));
    expect(backend.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/update/install' });
    expect(text()).toContain('Downloading…');
    expect(buttonByText('Check now')?.disabled).toBe(true);
    expect(buttonByText('Install and restart')?.disabled).toBe(true);
  });

  it('follows the install stages, and offers a retry when it fails', async () => {
    await show({ ...AVAILABLE, stage: 'verifying' });
    expect(text()).toContain('Checking the signature…');
    // As an `update` event does (use-platform-events.ts).
    const setStatus = async (status: UpdateStatus) => {
      await act(async () => {
        view?.queryClient.setQueryData(UPDATE_KEY, status);
      });
      await settle();
    };

    await setStatus({ ...AVAILABLE, stage: 'installing' });
    expect(text()).toContain('Installing…');
    await setStatus({ ...AVAILABLE, stage: 'restarting' });
    expect(text()).toContain('Restarting…');

    await setStatus({ ...AVAILABLE, stage: 'failed', error: 'The signature did not match.' });
    expect(text()).toContain('The update failed');
    expect(text()).toContain('The signature did not match.');
    expect(buttonByText('Try again')?.disabled).toBe(false);
    expect(buttonByText('Check now')?.disabled).toBe(false);
  });

  it('links to GitHub where it cannot install, with why when the copy is blocked', async () => {
    const blocked =
      'Move Pi Local to your Applications folder (and open it from there) to update it in place.';
    await show({ ...AVAILABLE, canInstall: false, installBlocked: blocked });
    expect(buttonByText('Install and restart')).toBeUndefined();
    expect(text()).toContain(blocked);
    const link = [...document.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('Download from GitHub'),
    );
    expect(link?.getAttribute('href')).toBe(AVAILABLE.latest?.url);
  });

  it("shows the check's error as what it says", async () => {
    await show({ ...UP_TO_DATE, latest: null, checkedAt: Date.now(), error: 'no releases yet' });
    expect(text()).toContain('No releases yet');
  });

  it('turns automatic checks off', async () => {
    const backend = await show(UP_TO_DATE, {
      'PUT /api/update/settings': () => ({ ...UP_TO_DATE, autoCheck: false }),
    });
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    await click(toggle);
    expect(backend.calls.at(-1)).toEqual({
      method: 'PUT',
      path: '/api/update/settings',
      body: { autoCheck: false },
    });
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
  });

  it('is hidden where there are no updates (501)', async () => {
    fakeBackend({
      'GET /api/update': () => {
        throw new ApiError(501, 'not_supported', "Updates aren't available here.");
      },
    });
    view = await renderWithQuery(<UpdatesSection />);
    await settle();
    expect(view.container.innerHTML).toBe('');
  });

  it('puts an install stage before anything else in the headline', () => {
    expect(updateHeadline({ ...AVAILABLE, stage: 'downloading', error: 'old' })).toBe(
      'Downloading…',
    );
    expect(updateHeadline({ ...UP_TO_DATE, checkedAt: null })).toBe('Not checked yet');
  });
});

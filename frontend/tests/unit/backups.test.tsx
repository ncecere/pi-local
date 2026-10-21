// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, type Backup, type BackupList } from '../../src/api/client';
import { DiagnosticsRow } from '../../src/components/settings/diagnostics-row';
import { updateHeadline } from '../../src/components/settings/updates-section';
import * as downloads from '../../src/lib/download';
import { SettingsBackupsPage } from '../../src/routes/settings/backups';
import {
  buttonByText,
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

let view: Rendered | undefined;

/** The page, once its list has been read. */
async function page(options?: Parameters<typeof renderWithQuery>[1]) {
  const rendered = await renderWithQuery(<SettingsBackupsPage />, options);
  await settle();
  return rendered;
}
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
  toast.mockClear();
  toast.error.mockClear();
  vi.restoreAllMocks();
});

function backup(overrides: Partial<Backup> = {}): Backup {
  return {
    id: 'pi-local-2026-10-20-090000',
    file: 'pi-local-2026-10-20-090000.zip',
    path: '/data/backups/pi-local-2026-10-20-090000.zip',
    createdAt: Date.UTC(2026, 9, 20, 9, 0, 0),
    size: 52_428_800,
    bytes: 104_857_600,
    reason: 'manual',
    version: '0.3.0',
    agents: 3,
    workspaceBytes: 73_400_320,
    needsKeys: [
      { kind: 'provider', id: 'openai', name: 'OpenAI', items: ['API key'] },
      { kind: 'mcp', id: 'github', name: 'GitHub', items: ['Variable GITHUB_TOKEN'] },
    ],
    warnings: [],
    readable: true,
    ...overrides,
  };
}

function list(overrides: Partial<BackupList> = {}): BackupList {
  return {
    backups: [backup()],
    folder: '/data/backups',
    auto: true,
    keep: 7,
    running: false,
    autoError: '',
    pending: null,
    canRestart: true,
    lastRestore: null,
    ...overrides,
  };
}

describe('Settings → Backups', () => {
  it('lists backups with their size, what they hold and which keys need entering again', async () => {
    fakeBackend({
      'GET /api/backups': () =>
        list({
          backups: [
            backup(),
            backup({
              id: 'pi-local-2026-10-19-090000-auto',
              reason: 'automatic',
              size: 2_048,
              agents: 1,
              workspaceBytes: 0,
              needsKeys: [],
            }),
          ],
        }),
    });
    view = await page();
    const text = document.body.textContent ?? '';
    // The size, and that workspaces are in it.
    expect(text).toContain('50.0 MB · 3 agents · workspace files 70.0 MB before compression');
    expect(text).toContain('2.0 KB · 1 agent');
    expect(text).toContain('Workspaces can be large');
    expect(text).toContain('Made by you');
    expect(text).toContain('Daily backup');
    expect(text).toContain('enter them again for OpenAI and GitHub');
    expect(text).toContain('/data/backups');
  });

  it('says so when there are none', async () => {
    fakeBackend({ 'GET /api/backups': () => list({ backups: [] }) });
    view = await page();
    expect(document.body.textContent).toContain('No backups yet.');
  });

  it('backs up now, and reads the list again', async () => {
    let backups = [] as Backup[];
    const backend = fakeBackend({
      'GET /api/backups': () => list({ backups }),
      'POST /api/backups': () => {
        backups = [backup({ id: 'pi-local-new' })];
        return backups[0];
      },
    });
    view = await page();
    await click(buttonByText('Back up now'));
    await settle();
    expect(backend.calls.filter((call) => call.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/backups', body: undefined },
    ]);
    expect(toast).toHaveBeenCalledWith('Backed up.');
    expect(document.body.textContent).toContain('50.0 MB · 3 agents');
  });

  it('says why a backup failed', async () => {
    fakeBackend({
      'GET /api/backups': () => list({ backups: [] }),
      'POST /api/backups': () => {
        throw new ApiError(
          500,
          'backup_failed',
          "There isn't enough free space on this disk for the backup.",
        );
      },
    });
    view = await page();
    await click(buttonByText('Back up now'));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('enough free space');
  });

  it('offers a folder of your choice only where there is a folder dialog', async () => {
    const backend = fakeBackend({
      'GET /api/backups': () => list({ backups: [] }),
      'POST /api/choose-folder': () => ({ path: '/Volumes/Disk/backups' }),
      'POST /api/backups': () => backup({ path: '/Volumes/Disk/backups/x.zip' }),
    });
    view = await page();
    expect(buttonByText('Back up to a folder…')).toBeUndefined();
    view.unmount();

    view = await page({ features: { folderDialog: true } });
    await click(buttonByText('Back up to a folder…'));
    await settle();
    expect(
      backend.calls.filter((call) => call.method === 'POST' && call.path === '/api/backups'),
    ).toEqual([
      { method: 'POST', path: '/api/backups', body: { folder: '/Volumes/Disk/backups' } },
    ]);
  });

  it('turns the daily backup off and on', async () => {
    let auto = true;
    const backend = fakeBackend({
      'GET /api/backups': () => list({ auto }),
      'PUT /api/backups/settings': (body) => {
        auto = (body as { auto: boolean }).auto;
        return list({ auto });
      },
    });
    view = await page();
    const toggle = () => document.querySelector<HTMLElement>('button[role="switch"]');
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(document.body.textContent).toContain('keeping the last 7');
    await click(toggle());
    expect(backend.calls.filter((call) => call.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/api/backups/settings', body: { auto: false } },
    ]);
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  });

  it('restores only after asking, and says it restarts', async () => {
    const backend = fakeBackend({
      'GET /api/backups': () => list(),
      'POST /api/backups/pi-local-2026-10-20-090000/restore': () => ({ restarting: true }),
    });
    view = await page();
    await click(buttonByText('Restore…'));
    // Nothing has happened yet; the dialog says what will.
    expect(backend.calls.some((call) => call.path.endsWith('/restore'))).toBe(false);
    const dialog = document.body.textContent ?? '';
    expect(dialog).toContain('is moved to a before-restore folder');
    expect(dialog).toContain('Pi Local quits and opens again');
    expect(dialog).toContain('type again the keys for OpenAI and GitHub');

    await click(buttonByText('Restore and restart'));
    expect(backend.calls.filter((call) => call.path.endsWith('/restore'))).toEqual([
      {
        method: 'POST',
        path: '/api/backups/pi-local-2026-10-20-090000/restore',
        body: { confirm: 'restore' },
      },
    ]);
    expect(document.body.textContent).toContain('Pi Local is restarting');
  });

  it('asks to quit and open the app when it cannot restart itself', async () => {
    fakeBackend({
      'GET /api/backups': () => list({ canRestart: false }),
      'POST /api/backups/pi-local-2026-10-20-090000/restore': () => ({ restarting: false }),
    });
    view = await page();
    await click(buttonByText('Restore…'));
    expect(document.body.textContent).toContain('has to be quit and opened again');
    await click(buttonByText('Restore'));
    expect(document.body.textContent).toContain('Quit Pi Local and open it again to finish it.');
    expect(buttonByText('Restore and restart')).toBeUndefined();
  });

  it("can't restore a file that isn't a backup", async () => {
    fakeBackend({
      'GET /api/backups': () =>
        list({
          backups: [
            backup({
              readable: false,
              warnings: ["This file couldn't be read as a Pi Local backup."],
            }),
          ],
        }),
    });
    view = await page();
    expect(buttonByText('Restore…')?.disabled).toBe(true);
    expect(document.body.textContent).toContain('can’t be read as a backup');
  });

  it('deletes after asking', async () => {
    const backend = fakeBackend({
      'GET /api/backups': () => list(),
      'DELETE /api/backups/pi-local-2026-10-20-090000': () => ({ ok: true }),
    });
    view = await page();
    await click(buttonByText('Delete'));
    expect(backend.calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(document.body.textContent).toContain('The file is deleted for good.');
    await click(buttonByText('Delete backup'));
    expect(backend.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  it('shows the file in Finder', async () => {
    const backend = fakeBackend({
      'GET /api/backups': () => list(),
      'POST /api/backups/pi-local-2026-10-20-090000/reveal': () => ({ ok: true }),
    });
    view = await page();
    await click(buttonByText('Show in Finder'));
    expect(backend.calls.some((call) => call.path.endsWith('/reveal'))).toBe(true);
    expect(toast).toHaveBeenCalledWith('Selected the backup in Finder.');
  });

  it('shows a restore waiting for a restart, and lets you take it back', async () => {
    const backend = fakeBackend({
      'GET /api/backups': () =>
        list({
          canRestart: false,
          pending: { id: 'pi-local-2026-10-20-090000', requestedAt: 1, phase: 'pending' },
        }),
      'DELETE /api/backups/pending-restore': () => ({ ok: true }),
    });
    view = await page();
    expect(document.body.textContent).toContain(
      'A restore is waiting. Quit Pi Local and open it again',
    );
    expect(document.body.textContent).toContain('Restore from pi-local-2026-10-20-090000.zip');
    await click(buttonByText('Cancel the restore'));
    expect(backend.calls.some((call) => call.method === 'DELETE')).toBe(true);
  });

  it('says how the last restore went', async () => {
    fakeBackend({
      'GET /api/backups': () =>
        list({
          lastRestore: {
            ok: true,
            at: Date.now() - 60_000,
            id: 'x',
            movedTo: '/data/before-restore-2026-10-21',
            error: '',
          },
        }),
    });
    view = await page();
    expect(document.body.textContent).toContain('/data/before-restore-2026-10-21');
    view.unmount();

    fakeBackend({
      'GET /api/backups': () =>
        list({
          lastRestore: {
            ok: false,
            at: Date.now(),
            id: 'x',
            movedTo: '',
            error: 'The backup was damaged.',
          },
        }),
    });
    view = await page();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "didn't happen. The backup was damaged.",
    );
  });

  it('dismisses a restore notice across visits and explains manual retention', async () => {
    const lastRestore = {
      ok: true,
      at: Date.now(),
      id: 'dismiss-me',
      movedTo: '/tmp/old-data',
      error: '',
    };
    fakeBackend({ 'GET /api/backups': () => list({ lastRestore }) });
    view = await page();
    expect(document.body.textContent).toContain('Manual backups are kept until you delete them.');
    expect(document.body.textContent).toContain('/tmp/old-data');
    await click(buttonByText('Dismiss restore notice'));
    expect(document.body.textContent).not.toContain('/tmp/old-data');
    view.unmount();
    view = await page();
    expect(document.body.textContent).not.toContain('/tmp/old-data');
    localStorage.clear();
  });

  it('shows why the last automatic backup failed', async () => {
    fakeBackend({ 'GET /api/backups': () => list({ autoError: 'the disk is full' }) });
    view = await page();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('the disk is full');
  });
});

describe('Settings → About → Save diagnostics…', () => {
  it('saves through the desktop Save dialog', async () => {
    const backend = fakeBackend({
      'POST /api/diagnostics': () => ({ path: '/Users/ada/Desktop/diag.zip' }),
    });
    view = await renderWithQuery(<DiagnosticsRow />);
    expect(document.body.textContent).toContain('Keys, tokens and passwords are removed.');
    await click(buttonByText('Save diagnostics…'));
    expect(backend.calls).toEqual([{ method: 'POST', path: '/api/diagnostics', body: undefined }]);
    expect(toast).toHaveBeenCalledWith('Saved /Users/ada/Desktop/diag.zip.');
  });

  it('identifies browser Downloads after the desktop endpoint is unavailable', async () => {
    fakeBackend({
      'POST /api/diagnostics': () => {
        throw new ApiError(501, 'not_supported', 'Browser');
      },
    });
    vi.spyOn(api, 'download').mockResolvedValue({
      blob: new Blob(['zip']),
      contentDisposition: 'attachment; filename="diag.zip"',
    });
    const save = vi.spyOn(downloads, 'saveBlob').mockImplementation(() => undefined);
    view = await renderWithQuery(<DiagnosticsRow />);
    await click(buttonByText('Save diagnostics…'));
    expect(save).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Saved diag.zip to browser Downloads.');
  });

  it('says nothing when the dialog is cancelled', async () => {
    fakeBackend({ 'POST /api/diagnostics': () => ({ cancelled: true }) });
    view = await renderWithQuery(<DiagnosticsRow />);
    await click(buttonByText('Save diagnostics…'));
    expect(toast).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says what went wrong', async () => {
    fakeBackend({
      'POST /api/diagnostics': () => {
        throw new ApiError(500, 'internal', "The diagnostics couldn't be made: no space");
      },
    });
    view = await renderWithQuery(<DiagnosticsRow />);
    await click(buttonByText('Save diagnostics…'));
    expect(toast.error).toHaveBeenCalledWith("The diagnostics couldn't be made: no space");
  });
});

describe('An update', () => {
  it('says it is backing up first', () => {
    expect(
      updateHeadline({
        current: '0.3.0',
        latest: null,
        available: true,
        checkedAt: 1,
        error: null,
        canInstall: true,
        autoCheck: true,
        stage: 'backing-up',
      }),
    ).toBe('Backing up your data…');
  });
});

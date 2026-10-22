// @vitest-environment happy-dom
import { act } from 'react';
import { toast } from 'sonner';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, type DesktopSettings } from '../../src/api/client';
import { DESKTOP_KEY } from '../../src/hooks/use-desktop';
import { SettingsAccountPage } from '../../src/routes/settings/account';
import {
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
// Startup tests exercise the full About page but not the independent update UI.
vi.mock('../../src/components/settings/updates-section', () => ({
  UpdatesSection: () => <h2>Updates fixture</h2>,
}));

const SUPPORTED: DesktopSettings = {
  available: true,
  launchAtLogin: false,
  capabilities: {
    launchAtLogin: { available: true, reason: 'macOS LaunchAgent startup is implemented.' },
  },
};
const UNSUPPORTED: DesktopSettings = {
  available: true,
  // Even a stale true value must not render as an enabled operation.
  launchAtLogin: true,
  capabilities: {
    launchAtLogin: { available: false, reason: 'No startup adapter on this test platform.' },
  },
};
const ABSENT: DesktopSettings = {
  available: false,
  launchAtLogin: false,
  capabilities: {
    launchAtLogin: { available: false, reason: 'Launching at login needs the desktop app.' },
  },
};

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
  vi.clearAllMocks();
});

const toggle = () =>
  document.querySelector<HTMLButtonElement>('[aria-labelledby="launch-at-login-label"]');
const text = () => document.body.textContent ?? '';

// unknown deliberately models older/malformed wire payloads without type casts.
async function show(payload: unknown, put: (body: unknown) => unknown = () => SUPPORTED) {
  const backend = fakeBackend({
    'GET /api/settings/desktop': () => payload,
    'PUT /api/settings/desktop': put,
    'GET /api/agents': () => [],
    'GET /api/about': () => ({ version: 'test-version', agents: 0, dataDir: '/synthetic/data' }),
  });
  view = await renderWithQuery(<SettingsAccountPage />);
  await settle();
  return backend;
}

it('preserves supported macOS toggles, labels, focus, and the rest of About', async () => {
  const backend = await show(SUPPORTED, (body) => ({ ...SUPPORTED, ...(body as object) }));
  const control = toggle();
  expect(control?.disabled).toBe(false);
  expect(control?.getAttribute('aria-checked')).toBe('false');
  expect(control?.getAttribute('aria-describedby')).toBe('launch-at-login-description');
  expect(document.getElementById('launch-at-login-label')?.textContent).toContain(
    'Open Pi Local when you log in',
  );
  expect(document.getElementById('launch-at-login-description')?.textContent).toContain('menu bar');
  control?.focus();
  expect(document.activeElement).toBe(control);
  for (const label of ['Ada', 'test-version', '/synthetic/data', 'Runtime', 'Save diagnostics…']) {
    expect(text()).toContain(label);
  }
  await click(control);
  expect(control?.getAttribute('aria-checked')).toBe('true');
  await click(control);
  expect(control?.getAttribute('aria-checked')).toBe('false');
  expect(backend.calls.filter((call) => call.method === 'PUT')).toEqual([
    { method: 'PUT', path: '/api/settings/desktop', body: { launchAtLogin: true } },
    { method: 'PUT', path: '/api/settings/desktop', body: { launchAtLogin: false } },
  ]);
});

it('keeps pending controls focusable, blocks repeat mutations, and rolls back errors', async () => {
  let reject: ((error: Error) => void) | undefined;
  const backend = await show(
    SUPPORTED,
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  toggle()?.focus();
  const focused = toggle();
  await click(toggle());
  // Native disabled would blur the browser button. aria-disabled announces the
  // busy control while preserving focus; both switch and handler guard repeats.
  expect(toggle()?.disabled).toBe(false);
  expect(toggle()?.getAttribute('aria-disabled')).toBe('true');
  expect(toggle()?.getAttribute('aria-busy')).toBe('true');
  expect(document.activeElement).toBe(focused);
  expect(toggle()?.getAttribute('aria-checked')).toBe('true');
  await click(toggle());
  expect(backend.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  await act(async () => reject?.(new ApiError(500, 'internal', 'Synthetic startup failure.')));
  await settle();
  expect(toggle()?.disabled).toBe(false);
  expect(toggle()?.getAttribute('aria-disabled')).toBe('false');
  expect(toggle()?.getAttribute('aria-busy')).toBe('false');
  expect(document.activeElement).toBe(focused);
  expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  expect(toast.error).toHaveBeenCalledWith('Synthetic startup failure.');
});

const unavailableCases: [string, unknown, string | undefined][] = [
  ['unsupported', UNSUPPORTED, UNSUPPORTED.capabilities.launchAtLogin.reason],
  ...[null, 42, {}, '   '].map<[string, unknown, undefined]>((reason) => [
    `malformed reason ${JSON.stringify(reason)}`,
    {
      available: true,
      launchAtLogin: true,
      capabilities: { launchAtLogin: { available: false, reason } },
    },
    undefined,
  ]),
  ['missing capabilities', { available: true, launchAtLogin: true }, undefined],
  ['missing operation', { available: true, launchAtLogin: true, capabilities: {} }, undefined],
  [
    'unknown operation',
    { available: true, launchAtLogin: true, capabilities: { unknown: { available: true } } },
    undefined,
  ],
  [
    'unknown availability',
    { available: true, launchAtLogin: true, capabilities: { launchAtLogin: { available: 'yes' } } },
    undefined,
  ],
];

it.each(unavailableCases)(
  'fails closed for %s without mutating',
  async (_name, payload, reason) => {
    const backend = await show(payload, () => {
      throw new Error('disabled mutation touched');
    });
    const before = view?.queryClient.getQueryData(DESKTOP_KEY);
    expect(toggle()?.disabled).toBe(true);
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(text()).toContain(reason ?? 'Launching at login is not supported on this platform.');
    expect(text()).not.toContain('menu bar');
    await click(toggle());
    expect(backend.calls.filter((call) => call.method === 'PUT')).toEqual([]);
    expect(view?.queryClient.getQueryData(DESKTOP_KEY)).toEqual(before);
  },
);

it('hides desktop settings when no desktop is present', async () => {
  const backend = await show(ABSENT);
  expect(toggle()).toBeNull();
  expect(text()).not.toContain('menu bar');
  expect(text()).toContain('Runtime');
  expect(backend.calls.filter((call) => call.method === 'PUT')).toEqual([]);
});

// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Fact } from '../../src/api/client';
import { UserMenu } from '../../src/components/layout/user-menu';
import { SettingsLayout } from '../../src/components/settings/settings-layout';
import { YOU_KEY } from '../../src/hooks/use-memory';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { fact } from './memory-fixtures';
import {
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  Outlet: () => null,
  useLocation: () => ({ pathname: '/settings' }),
  useNavigate: () => vi.fn(),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const SUGGESTED = '/api/you/memories?status=suggested';
const suggestion = (id: string) => fact({ id, status: 'suggested', trust: 'inferred' });

function backend(facts: () => Fact[]) {
  return fakeBackend({ [`GET ${SUGGESTED}`]: facts });
}
const youTab = () =>
  [...document.querySelectorAll('nav[aria-label="Settings sections"] a')].find((a) =>
    a.textContent?.startsWith('You'),
  );

async function showSettings() {
  view = await renderWithQuery(
    <ThemeProvider>
      <SettingsLayout />
    </ThemeProvider>,
  );
  await settle();
}

describe('Suggestions waiting, outside Settings → You', () => {
  it('shows their count on the You tab', async () => {
    const calls = backend(() => [suggestion('um_1'), suggestion('um_2')]);
    await showSettings();
    expect(calls.calls.map((call) => call.path)).toContain(SUGGESTED);
    expect(youTab()?.querySelector('[data-suggestions-badge]')?.textContent).toBe('2');
    expect(youTab()?.textContent).toContain('2 suggestions waiting');
    // The other tabs have none.
    expect(document.querySelectorAll('[data-suggestions-badge]')).toHaveLength(1);
    // And the phone's list says it too.
    const option = [
      ...document.querySelectorAll('select[aria-label="Settings section"] option'),
    ].find((o) => o.textContent?.startsWith('You'));
    expect(option?.textContent).toBe('You (2)');
  });

  it('shows nothing when there are none', async () => {
    backend(() => []);
    await showSettings();
    expect(youTab()).toBeDefined();
    expect(document.querySelector('[data-suggestions-badge]')).toBeNull();
  });

  it('follows the memory live event, which refreshes what is known about the person', async () => {
    let facts: Fact[] = [];
    backend(() => facts);
    await showSettings();
    expect(document.querySelector('[data-suggestions-badge]')).toBeNull();

    facts = [suggestion('um_1')];
    // What the `memory` event does (hooks/use-platform-events.ts).
    await view?.queryClient.invalidateQueries({ queryKey: YOU_KEY });
    await settle();
    expect(youTab()?.querySelector('[data-suggestions-badge]')?.textContent).toBe('1');
    expect(youTab()?.textContent).toContain('1 suggestion waiting');
  });

  it('puts a dot on the user menu, with a way to the suggestions', async () => {
    backend(() => [suggestion('um_1')]);
    view = await renderWithQuery(<UserMenu />);
    await settle();
    expect(document.querySelector('[data-suggestions-dot]')).not.toBeNull();
  });

  it('puts no dot there when nothing waits', async () => {
    backend(() => []);
    view = await renderWithQuery(<UserMenu />);
    await settle();
    expect(document.querySelector('[data-suggestions-dot]')).toBeNull();
  });
});

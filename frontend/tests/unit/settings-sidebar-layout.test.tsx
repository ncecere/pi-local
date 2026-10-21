// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from '../../src/components/layout/top-bar';
import { SettingsLayout } from '../../src/components/settings/settings-layout';
import { FOCUS_RING } from '../../src/components/ui/focus-ring';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { fact } from './memory-fixtures';
import {
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

const route = vi.hoisted(() => ({ pathname: '/settings', navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    activeOptions: _activeOptions,
    ...props
  }: ComponentProps<'a'> & { to: string; activeOptions?: { exact: boolean } }) => (
    <a href={to} {...props} />
  ),
  Outlet: () => <h1>Section content</h1>,
  useLocation: () => ({ pathname: route.pathname }),
  useNavigate: () => route.navigate,
  useParams: () => ({}),
}));
vi.mock('../../src/hooks/use-agents', () => ({ useAgent: () => undefined }));

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
  route.pathname = '/settings';
  route.navigate.mockClear();
});

async function settings(pathname = '/settings') {
  route.pathname = pathname;
  fakeBackend({
    'GET /api/you/memories?status=suggested': () => [
      fact({ id: 'um_layout', status: 'suggested', trust: 'inferred' }),
    ],
  });
  view = await renderWithQuery(
    <ThemeProvider>
      <SettingsLayout />
    </ThemeProvider>,
  );
  await settle();
  return document.querySelector('nav[aria-label="Settings sections"]')!;
}

describe('Settings section navigation', () => {
  it('is a flat wrapping set of real links, with an underline instead of nested pills', async () => {
    const nav = await settings();
    const track = nav.firstElementChild!;
    expect(track.classList.contains('flex-wrap')).toBe(true);
    expect(track.className).not.toMatch(/rounded-|bg-|(?:^|\s)p-1(?:\s|$)/);
    const links = [...nav.querySelectorAll('a')];
    expect(links).toHaveLength(14);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      [...nav.querySelectorAll('option')].map((option) => option.value),
    );
    const current = nav.querySelector('a[aria-current="page"]')!;
    expect(current.getAttribute('href')).toBe('/settings');
    expect(current.className).toContain('border-[var(--accent-bright)]');
    expect(current.className).toContain('font-semibold');
    for (const link of links) {
      expect(link.className).not.toMatch(/rounded-|bg-/);
      expect(link.className).toContain('border-b-2');
      expect(link.className).toContain('px-2.5');
      for (const token of FOCUS_RING.split(' ')) expect(link.classList.contains(token)).toBe(true);
    }
  });

  it('keeps active-page semantics on nested routes and badges on both responsive navigators', async () => {
    const nav = await settings('/settings/you/details');
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    const current = nav.querySelector('a[aria-current="page"]')!;
    expect(current.getAttribute('href')).toBe('/settings/you');
    expect(current.textContent).toContain('1 suggestion waiting');
    expect(current.querySelector('[data-suggestions-badge]')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    const select = nav.querySelector('select')!;
    expect(select.value).toBe('/settings/you');
    expect(select.selectedOptions[0]?.textContent).toBe('You (1)');
    expect(select.className).toContain('sm:hidden');
    await act(async () => {
      select.value = '/settings/backups';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(route.navigate).toHaveBeenCalledWith({ to: '/settings/backups' });
  });
});

describe('Native chat titlebar contract', () => {
  it('keeps the collapsed controls functional and removes only those on expansion', async () => {
    const open = vi.fn();
    const search = vi.fn();
    const bar = (sidebarOpen: boolean) => (
      <ThemeProvider>
        <TopBar sidebarOpen={sidebarOpen} onOpenSidebar={open} onOpenCommandPalette={search} />
      </ThemeProvider>
    );
    view = await renderWithQuery(bar(false));
    expect(document.querySelector('[data-chat-titlebar]')?.getAttribute('data-sidebar')).toBe(
      'closed',
    );
    const left = document.querySelector('[data-floating-controls="left"]')!;
    expect(left.querySelectorAll('button, a')).toHaveLength(3);
    for (const control of document.querySelectorAll(
      '[data-floating-controls] button, [data-floating-controls] a',
    )) {
      expect(control.classList.contains('size-8')).toBe(true);
    }
    await click(document.querySelector('[aria-label="Open sidebar"]'));
    await click(document.querySelector('[aria-label="Search commands and agents"]'));
    expect(open).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledOnce();
    expect(left.querySelector('a')?.getAttribute('href')).toBe('/');
    await act(async () => view?.root.render(bar(true)));
    expect(document.querySelector('[data-floating-controls="left"]')).toBeNull();
    expect(document.querySelector('[aria-label="Appearance settings"]')).not.toBeNull();
  });

  it('shares the measured native chrome row, without mistaking the drag region for traffic-light height', () => {
    const css = readFileSync(resolve('src/styles/global.css'), 'utf8');
    const mac = 'html[data-shell="desktop-mac"]';
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      expect(start, `missing rule ${selector}`).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf('}', start) + 1);
    };
    expect(rule(mac)).toContain('--native-titlebar-height: 54px;');
    const row = rule(`${mac} :is([data-titlebar], [data-chat-titlebar])`);
    expect(row).toContain('height: var(--native-titlebar-height);');
    expect(row).toContain('flex-shrink: 0;');
    expect(row).toContain('--wails-draggable: drag;');
    // Conversation Documents/Activity buttons share this marker but own their offsets and surface styles.
    const anyFloating = rule(`${mac} [data-floating-controls]`);
    expect(anyFloating).toContain('--wails-draggable: no-drag;');
    expect(anyFloating).not.toMatch(/(?:top|padding|border|background|box-shadow):/);
    const floating = rule(`${mac} [data-chat-titlebar] [data-floating-controls]`);
    for (const declaration of [
      'top: 11px;',
      'padding: 0;',
      'border: 0;',
      'background: none;',
      'box-shadow: none;',
      '--wails-draggable: no-drag;',
    ]) {
      expect(floating).toContain(declaration);
    }
    expect(rule(`${mac} [data-titlebar]`)).toContain('padding-left: 80px;');
    expect(rule(`${mac} [data-chat-titlebar] [data-floating-controls="left"]`)).toContain(
      'left: 80px;',
    );
    expect(rule(`${mac} [data-titlebar] :is(a, button)`)).toContain('--wails-draggable: no-drag;');
    expect(rule(`${mac} [data-banners]`)).toContain('padding-top: 0;');
    // This remains a separate drag-region setting, not the measured chrome height.
    const native = readFileSync(resolve('../cmd/pi-local/main.go'), 'utf8');
    expect(native).toMatch(/InvisibleTitleBarHeight:\s+40/);
  });
});

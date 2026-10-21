// @vitest-environment happy-dom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { SettingsLayout } from '../../src/components/settings/settings-layout';
import { ThemeProvider } from '../../src/providers/theme-provider';
import {
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  restoreTransport();
});

it('marks only the actual settings section current with TanStack Link, not its About ancestor', async () => {
  fakeBackend({ 'GET /api/you/memories?status=suggested': () => [] });
  const root = createRootRoute({ component: SettingsLayout });
  const children = ['/settings', '/settings/you', '/settings/backups'].map((path) =>
    createRoute({ getParentRoute: () => root, path, component: () => <h1>Section</h1> }),
  );
  const router = createRouter({
    routeTree: root.addChildren(children),
    history: createMemoryHistory({ initialEntries: ['/settings/you'] }),
  });
  view = await renderWithQuery(
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>,
  );
  await act(async () => router.load());
  await settle();
  const current = () =>
    [
      ...document.querySelectorAll('nav[aria-label="Settings sections"] a[aria-current="page"]'),
    ].map((link) => link.getAttribute('href'));
  expect(current()).toEqual(['/settings/you']);
  await act(async () => router.navigate({ to: '/settings/backups' }));
  await settle();
  expect(current()).toEqual(['/settings/backups']);
  await act(async () => router.navigate({ to: '/settings' }));
  await settle();
  expect(current()).toEqual(['/settings']);
});

import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from '~/components/layout/app-shell';
import { NotFoundPage } from '~/components/ui/not-found-page';
import { RouteLoadError } from '~/components/ui/route-load-error';
import { FullPageSpinner } from '~/components/ui/spinner';
import { useNewChatKey } from '~/hooks/use-new-chat-key';
import { ChatHomePage } from '~/routes/chat/home';
import { ChatThreadPage } from '~/routes/chat/thread';

/** Pi Local has one local user: no sign-in, no session guard. */
const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => (
    <main className="h-dvh">
      <NotFoundPage />
    </main>
  ),
});

/**
 * A review page for the avatar styles. Development only: in a production build
 * the condition is constant, so the page is not even in the bundle.
 */
const avatarsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/avatars',
  component: import.meta.env.DEV
    ? lazyRouteComponent(() => import('~/routes/demo/avatars'), 'AvatarsDemoPage')
    : () => <NotFoundPage />,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
  pendingComponent: FullPageSpinner,
});

const chatHomeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): { agent?: string } =>
    typeof search.agent === 'string' && search.agent ? { agent: search.agent } : {},
  component: function ChatHomeRoute() {
    const { agent } = chatHomeRoute.useSearch();
    // A fresh page for each New Chat.
    const fresh = useNewChatKey();
    return <ChatHomePage key={fresh} agentId={agent} />;
  },
});

const agentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/agents/$agentId',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/', search: { agent: params.agentId } });
  },
});

const threadRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/agents/$agentId/threads/$threadId',
  component: function ThreadRoute() {
    const { agentId, threadId } = threadRoute.useParams();
    return <ChatThreadPage agentId={agentId} threadId={threadId} />;
  },
});

/** Settings: a page of its own (no chat sidebar), as in Open Chat Interface. */
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'settings',
  component: () => <SettingsLayout />,
  pendingComponent: FullPageSpinner,
});

const settingsPage = <P extends string>(
  path: P,
  component: ReturnType<typeof lazyRouteComponent>,
) => createRoute({ getParentRoute: () => settingsRoute, path, component });

const settingsChildren = [
  settingsPage(
    '/settings',
    lazyRouteComponent(() => import('~/routes/settings/account'), 'SettingsAccountPage'),
  ),
  settingsPage(
    '/settings/customization',
    lazyRouteComponent(
      () => import('~/routes/settings/customization'),
      'SettingsCustomizationPage',
    ),
  ),
  settingsPage(
    '/settings/agents',
    lazyRouteComponent(() => import('~/routes/settings/agents'), 'SettingsAgentsPage'),
  ),
  settingsPage(
    '/settings/models',
    lazyRouteComponent(() => import('~/routes/settings/models'), 'SettingsModelsPage'),
  ),
  settingsPage(
    '/settings/usage',
    lazyRouteComponent(() => import('~/routes/settings/usage'), 'SettingsUsagePage'),
  ),
  settingsPage(
    '/settings/conversations',
    lazyRouteComponent(
      () => import('~/routes/settings/conversations'),
      'SettingsConversationsPage',
    ),
  ),
];

const SettingsLayout = lazyRouteComponent(
  () => import('~/components/settings/settings-layout'),
  'SettingsLayout',
);

const routeTree = rootRoute.addChildren([
  avatarsRoute,
  appRoute.addChildren([chatHomeRoute, agentRoute, threadRoute]),
  settingsRoute.addChildren(settingsChildren),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: FullPageSpinner,
  defaultErrorComponent: RouteLoadError,
  defaultNotFoundComponent: () => <NotFoundPage />,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

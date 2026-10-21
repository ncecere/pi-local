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
import { usePlatformEvents } from '~/hooks/use-platform-events';
import { ChatHomePage } from '~/routes/chat/home';
import { ChatThreadPage } from '~/routes/chat/thread';

/** Pi Local has one local user: no sign-in, no session guard. */
/** Live events (/api/events) for every page: the chat and Settings alike follow agents, threads and teams. */
function Root() {
  usePlatformEvents();
  return <Outlet />;
}

const rootRoute = createRootRoute({
  component: Root,
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
  validateSearch: (search: Record<string, unknown>): { agent?: string; team?: string } => ({
    ...(typeof search.agent === 'string' && search.agent ? { agent: search.agent } : {}),
    ...(typeof search.team === 'string' && search.team ? { team: search.team } : {}),
  }),
  component: function ChatHomeRoute() {
    const { agent, team } = chatHomeRoute.useSearch();
    // A fresh page for each New Chat.
    const fresh = useNewChatKey();
    return <ChatHomePage key={fresh} agentId={agent} teamId={team} />;
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
  // `?find=<snippet>`: a message-search result, opened at its match.
  validateSearch: (search: Record<string, unknown>): { find?: string } =>
    typeof search.find === 'string' && search.find ? { find: search.find.slice(0, 1000) } : {},
  component: function ThreadRoute() {
    const { agentId, threadId } = threadRoute.useParams();
    const { find } = threadRoute.useSearch();
    return <ChatThreadPage agentId={agentId} threadId={threadId} find={find} />;
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
    '/settings/you',
    lazyRouteComponent(() => import('~/routes/settings/you'), 'SettingsYouPage'),
  ),
  settingsPage(
    '/settings/customization',
    lazyRouteComponent(
      () => import('~/routes/settings/customization'),
      'SettingsCustomizationPage',
    ),
  ),
  createRoute({
    getParentRoute: () => settingsRoute,
    path: '/settings/agents',
    // `?new=true`: open on the New agent dialog (the first-run home screen's "Make an agent").
    validateSearch: (search: Record<string, unknown>): { new?: true } =>
      search.new === true || search.new === 'true' ? { new: true } : {},
    component: lazyRouteComponent(() => import('~/routes/settings/agents'), 'SettingsAgentsPage'),
  }),
  settingsPage(
    '/settings/teams',
    lazyRouteComponent(() => import('~/routes/settings/teams'), 'SettingsTeamsPage'),
  ),
  settingsPage(
    '/settings/models',
    lazyRouteComponent(() => import('~/routes/settings/models'), 'SettingsModelsPage'),
  ),
  settingsPage(
    '/settings/mcp',
    lazyRouteComponent(() => import('~/routes/settings/mcp'), 'SettingsMcpPage'),
  ),
  settingsPage(
    '/settings/schedules',
    lazyRouteComponent(() => import('~/routes/settings/schedules'), 'SettingsSchedulesPage'),
  ),
  settingsPage(
    '/settings/activity',
    lazyRouteComponent(() => import('~/routes/settings/activity'), 'SettingsActivityPage'),
  ),
  settingsPage(
    '/settings/backups',
    lazyRouteComponent(() => import('~/routes/settings/backups'), 'SettingsBackupsPage'),
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

const AgentDetailPage = lazyRouteComponent(
  () => import('~/routes/settings/agent-detail'),
  'SettingsAgentDetailPage',
);

/** One agent in the manager: Settings → Agents → its name. */
const agentDetailRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/settings/agents/$agentId',
  // `?tab=tools`: open on a tab (the composer's "turn on the read tool" link).
  validateSearch: (search: Record<string, unknown>): { tab?: string } =>
    typeof search.tab === 'string' && search.tab ? { tab: search.tab } : {},
  component: function AgentDetailRoute() {
    const { agentId } = agentDetailRoute.useParams();
    const { tab } = agentDetailRoute.useSearch();
    return <AgentDetailPage key={agentId} agentId={agentId} initialTab={tab} />;
  },
});

const SettingsLayout = lazyRouteComponent(
  () => import('~/components/settings/settings-layout'),
  'SettingsLayout',
);

const routeTree = rootRoute.addChildren([
  avatarsRoute,
  appRoute.addChildren([chatHomeRoute, agentRoute, threadRoute]),
  settingsRoute.addChildren([...settingsChildren, agentDetailRoute]),
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

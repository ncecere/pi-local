import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import type { FeatureId } from '~/api/client';
import { SkipLink } from '~/components/layout/skip-link';
import { ThemeMenu } from '~/components/layout/theme-menu';
import { Button } from '~/components/ui/button';
import { FOCUS_RING } from '~/components/ui/focus-ring';
import { useSuggestedFacts } from '~/hooks/use-memory';
import { useCurrentUser } from '~/hooks/use-session';
import { INBOX_SHORTCUTS, shortcutLabel } from '~/lib/inbox-shortcuts';
import {
  isApplePlatform,
  modifierKey,
  SHORTCUTS,
  type ShortcutId,
  shortcutKeys,
} from '~/lib/keyboard-shortcuts';
import { cn } from '~/lib/utils';
import { useTheme } from '~/providers/theme-provider';

/** Settings sections live beside the page, with a native section picker on small screens. */

interface Tab {
  to:
    | '/settings'
    | '/settings/you'
    | '/settings/customization'
    | '/settings/agents'
    | '/settings/teams'
    | '/settings/models'
    | '/settings/connections'
    | '/settings/mcp'
    | '/settings/schedules'
    | '/settings/conversations'
    | '/settings/usage'
    | '/settings/activity'
    | '/settings/prompts'
    | '/settings/backups';
  label: string;
  exact: boolean;
  /** Shown only while this optional feature is on. */
  feature?: FeatureId;
}

const ALL_TABS: Tab[] = [
  { to: '/settings', label: 'About', exact: true },
  { to: '/settings/you', label: 'You', exact: false },
  { to: '/settings/customization', label: 'Customization', exact: false },
  { to: '/settings/agents', label: 'Agents', exact: false },
  { to: '/settings/teams', label: 'Teams', exact: false },
  { to: '/settings/models', label: 'Models', exact: false },
  { to: '/settings/connections', label: 'Connections', exact: false },
  { to: '/settings/mcp', label: 'Custom connections', exact: false },
  { to: '/settings/schedules', label: 'Schedules', exact: false },
  { to: '/settings/conversations', label: 'Conversations', exact: false },
  { to: '/settings/usage', label: 'Usage', exact: false },
  { to: '/settings/activity', label: 'Activity', exact: false },
  { to: '/settings/prompts', label: 'Prompts', exact: false },
  { to: '/settings/backups', label: 'Backups', exact: false },
];

const SECTION_GROUPS: { label: string; routes: Tab['to'][] }[] = [
  { label: 'Personal', routes: ['/settings/you', '/settings/customization'] },
  {
    label: 'Agents & work',
    routes: [
      '/settings/agents',
      '/settings/teams',
      '/settings/schedules',
      '/settings/conversations',
      '/settings/prompts',
    ],
  },
  {
    label: 'Models & connections',
    routes: ['/settings/models', '/settings/connections', '/settings/mcp'],
  },
  {
    label: 'App',
    routes: ['/settings', '/settings/usage', '/settings/activity', '/settings/backups'],
  },
];

const isActive = (tab: Tab, pathname: string) =>
  tab.exact ? pathname === tab.to || pathname === `${tab.to}/` : pathname.startsWith(tab.to);

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function Identity() {
  const { user } = useCurrentUser();
  const name = user.name || 'You';
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-sm font-semibold text-[var(--accent-foreground)]">
        {initialsOf(name)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{name}</p>
        <p className="truncate text-sm text-[var(--text-muted)]">On this computer</p>
      </div>
    </div>
  );
}

const SHOWN_SHORTCUTS: ShortcutId[] = ['search', 'new-chat', 'toggle-sidebar'];

function Shortcuts() {
  const { invertSend } = useTheme();
  const apple = isApplePlatform();
  const shortcuts = [
    ...SHOWN_SHORTCUTS.map((id) => ({ label: SHORTCUTS[id].label, keys: shortcutKeys(id, apple) })),
    ...(invertSend
      ? [
          { label: 'Send message', keys: [modifierKey(apple), 'Enter'] },
          { label: 'New line', keys: ['Enter'] },
        ]
      : [
          { label: 'Send message', keys: ['Enter'] },
          { label: 'New line', keys: [apple ? '⇧' : 'Shift', 'Enter'] },
        ]),
    ...INBOX_SHORTCUTS.map((shortcut) => ({
      label: shortcut.label,
      keys: shortcutLabel(shortcut.keys, apple),
    })),
  ];
  return (
    // Keyboard shortcuts matter only with a keyboard and a precise pointer.
    <details className="hidden any-pointer-fine:block">
      <summary
        className={cn('cursor-pointer rounded-md text-sm text-[var(--text-secondary)]', FOCUS_RING)}
      >
        Keyboard shortcuts
      </summary>
      <div className="mt-4 flex flex-col gap-3">
        {shortcuts.map((shortcut) => (
          <div key={shortcut.label} className="flex items-center justify-between gap-3">
            <span className="text-sm text-[var(--text-secondary)]">{shortcut.label}</span>
            <span className="flex gap-1">
              {shortcut.keys.map((key) => (
                <kbd
                  key={key}
                  className="rounded bg-[var(--bg-control-hover)] px-1.5 py-0.5 text-[0.6875rem] text-[var(--text-secondary)]"
                >
                  {key}
                </kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

function SectionNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const features = useCurrentUser().features ?? {};
  const groups = SECTION_GROUPS.map((group) => ({
    ...group,
    tabs: group.routes
      .map((to) => ALL_TABS.find((tab) => tab.to === to)!)
      .filter((tab) => !tab.feature || features[tab.feature]),
  })).filter((group) => group.tabs.length > 0);
  const tabs = groups.flatMap((group) => group.tabs);
  // Suggestions agents made about the person wait on the You tab for a yes.
  const waiting = useSuggestedFacts().data?.length ?? 0;
  const waitingOn = (tab: Tab) => (tab.to === '/settings/you' ? waiting : 0);
  const current = tabs.find((tab) => isActive(tab, pathname)) ?? ALL_TABS[0]!;
  const track = useRef<HTMLDivElement>(null);
  const currentTo = current.to;
  useEffect(() => {
    // Reveal a deep-linked section in a short sidebar without moving the page's scroll area.
    const active = track.current?.querySelector<HTMLElement>(`[href="${currentTo}"]`);
    const sidebar = track.current?.closest<HTMLElement>('[data-settings-sidebar]');
    if (!active || !sidebar || sidebar.clientHeight === 0) return;
    const row = active.getBoundingClientRect();
    const bounds = sidebar.getBoundingClientRect();
    if (row.bottom > bounds.bottom) sidebar.scrollTop += row.bottom - bounds.bottom;
    else if (row.top < bounds.top) sidebar.scrollTop -= bounds.top - row.top;
  }, [currentTo]);
  return (
    <nav aria-label="Settings sections">
      <div ref={track} className="hidden flex-col gap-4 md:flex">
        {groups.map((group, index) => (
          <section key={group.label} aria-labelledby={`settings-group-${index}`}>
            <h2
              id={`settings-group-${index}`}
              className="mb-1 px-3 text-xs font-medium text-[var(--text-muted)]"
            >
              {group.label}
            </h2>
            <ul className="flex flex-col gap-0.5">
              {group.tabs.map((tab) => {
                const active = isActive(tab, pathname);
                return (
                  <li key={tab.to}>
                    <Link
                      to={tab.to}
                      activeOptions={{ exact: tab.exact }}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'relative flex min-w-0 items-center rounded-md px-3 py-1 text-sm transition-colors',
                        FOCUS_RING,
                        active
                          ? 'bg-[var(--bg-control-hover)] font-semibold text-[var(--text-primary)] before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-[var(--accent-bright)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]',
                      )}
                    >
                      {tab.label}
                      {waitingOn(tab) > 0 && (
                        <>
                          <span
                            aria-hidden="true"
                            data-suggestions-badge=""
                            className="ml-1.5 inline-flex min-w-[1.125rem] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[0.6875rem] font-semibold leading-[1.125rem] text-[var(--accent-foreground)]"
                          >
                            {waitingOn(tab)}
                          </span>
                          <span className="sr-only">
                            ,{' '}
                            {waitingOn(tab) === 1
                              ? '1 suggestion'
                              : `${waitingOn(tab)} suggestions`}{' '}
                            waiting
                          </span>
                        </>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <select
        aria-label="Settings section"
        value={current.to}
        onChange={(event) => void navigate({ to: event.target.value })}
        className={cn(
          'h-11 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-control)] px-3 text-sm md:hidden',
          FOCUS_RING,
        )}
      >
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.tabs.map((tab) => (
              <option key={tab.to} value={tab.to}>
                {tab.label}
                {waitingOn(tab) > 0
                  ? ` (${waitingOn(tab)} ${waitingOn(tab) === 1 ? 'suggestion' : 'suggestions'} waiting)`
                  : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </nav>
  );
}

export function SettingsLayout() {
  const { pathname } = useLocation();
  return (
    // The header stays put (in the desktop app it is also the window's title bar: it drags the window and clears the
    // traffic lights); the page scrolls below it, independently of the section sidebar.
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--bg-settings)] text-[var(--text-primary)]">
      <SkipLink />
      <header data-settings-titlebar className="shrink-0">
        <div className="mx-auto flex w-full max-w-[75rem] items-center justify-between px-4 py-3 sm:px-6">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/">
              <ArrowLeft />
              Back to chat
            </Link>
          </Button>
          <div className="flex items-center gap-1">
            <ThemeMenu />
          </div>
        </div>
      </header>

      {/* The sidebar has its own scroll on short windows; the page remains the outer scroll area. */}
      <div data-settings-scroll className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[75rem] grid-cols-1 gap-6 px-4 pt-4 sm:px-6 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-x-8">
          <aside
            data-settings-sidebar
            aria-label="Settings navigation and help"
            className="contents md:sticky md:top-0 md:flex md:max-h-[calc(100dvh-5rem)] md:flex-col md:gap-6 md:self-start md:overflow-y-auto md:px-1 md:pb-6 md:pt-1"
          >
            <section aria-label="Your profile">
              <Identity />
            </section>
            <SectionNav pathname={pathname} />
            <section
              aria-label="Shortcuts and help"
              className="order-last flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-4 pb-8 md:order-none md:pb-0"
            >
              <Shortcuts />
              <details>
                <summary
                  className={cn(
                    'cursor-pointer rounded-md text-sm text-[var(--text-secondary)]',
                    FOCUS_RING,
                  )}
                >
                  Need help?
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-[var(--text-muted)]">
                  Pi Local runs your agents on this computer. Their conversations and memory stay
                  here, in each agent's own folder.
                </p>
              </details>
            </section>
          </aside>

          <main id="main-content" tabIndex={-1} className="min-w-0 pb-16 outline-none">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}

/** A titled group of settings rows. */
export function SettingsSection({
  title,
  children,
  first = false,
}: {
  title: string;
  children: ReactNode;
  first?: boolean;
}) {
  return (
    <section className={first ? undefined : 'mt-12'}>
      <h2 className="text-xl font-bold">{title}</h2>
      <div className="mt-4 flex flex-col gap-6">{children}</div>
    </section>
  );
}

/** One setting: its name and what it does on the left, its control on the right. */
export function SettingsRow({
  id,
  label,
  description,
  children,
}: {
  id: string;
  label: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-sm font-medium text-[var(--text-primary)]">
          {label}
        </p>
        <p
          id={`${id}-description`}
          className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]"
        >
          {description}
        </p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

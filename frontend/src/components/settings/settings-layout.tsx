import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import type { FeatureId } from '~/api/client';
import { SkipLink } from '~/components/layout/skip-link';
import { ThemeMenu } from '~/components/layout/theme-menu';
import { Button } from '~/components/ui/button';
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

/** Settings, as Open Chat Interface lays them out: who you are and help on the left, the section on the right. */

interface Tab {
  to:
    | '/settings'
    | '/settings/you'
    | '/settings/customization'
    | '/settings/agents'
    | '/settings/teams'
    | '/settings/models'
    | '/settings/mcp'
    | '/settings/schedules'
    | '/settings/conversations'
    | '/settings/usage'
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
  { to: '/settings/mcp', label: 'MCP', exact: false },
  { to: '/settings/schedules', label: 'Schedules', exact: false },
  { to: '/settings/conversations', label: 'Conversations', exact: false },
  { to: '/settings/usage', label: 'Usage', exact: false },
  { to: '/settings/backups', label: 'Backups', exact: false },
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
    <div className="flex min-w-0 items-center gap-4 lg:flex-col lg:gap-3 lg:pt-2">
      <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-base font-semibold text-[var(--accent-foreground)] lg:size-24 lg:text-2xl">
        {initialsOf(name)}
      </span>
      <div className="min-w-0 flex-1 lg:flex-none lg:text-center">
        <p className="truncate text-base font-bold text-[var(--text-primary)] lg:text-xl">{name}</p>
        <p className="truncate text-sm text-[var(--text-muted)]">On this computer</p>
      </div>
    </div>
  );
}

function Card({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'w-full rounded-xl border border-[var(--border-inset)] bg-[var(--bg-inset)] p-4',
        className,
      )}
    >
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </div>
  );
}

const SHOWN_SHORTCUTS: ShortcutId[] = ['search', 'new-chat', 'toggle-sidebar'];

function ShortcutsCard() {
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
    <Card title="Keyboard shortcuts" className="hidden any-pointer-fine:block">
      <div className="flex flex-col gap-3">
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
    </Card>
  );
}

function SectionNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const features = useCurrentUser().features ?? {};
  const TABS = ALL_TABS.filter((tab) => !tab.feature || features[tab.feature]);
  const current = TABS.find((tab) => isActive(tab, pathname)) ?? ALL_TABS[0]!;
  // A window too narrow for every tab scrolls the row: keep the current one in view.
  const track = useRef<HTMLDivElement>(null);
  const currentTo = current.to;
  useEffect(() => {
    const active = track.current?.querySelector<HTMLElement>(`[href="${currentTo}"]`);
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [currentTo]);
  return (
    <nav aria-label="Settings sections">
      <div
        ref={track}
        className="hidden max-w-full flex-nowrap gap-1 overflow-x-auto rounded-xl bg-[var(--bg-segment-track)] p-1 [scrollbar-width:none] sm:inline-flex"
      >
        {TABS.map((tab) => {
          const active = isActive(tab, pathname);
          return (
            <Link
              key={tab.to}
              to={tab.to}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-colors',
                active
                  ? 'bg-[var(--bg-segment-active)] font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
      <select
        aria-label="Settings section"
        value={current.to}
        onChange={(event) => void navigate({ to: event.target.value })}
        className="h-11 w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)] px-3 text-sm sm:hidden"
      >
        {TABS.map((tab) => (
          <option key={tab.to} value={tab.to}>
            {tab.label}
          </option>
        ))}
      </select>
    </nav>
  );
}

export function SettingsLayout() {
  const { pathname } = useLocation();
  return (
    // The header stays put (in the desktop app it is also the window's title bar: it drags the window and clears the
    // traffic lights); everything under it scrolls, with the section tabs stuck to the top.
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

      {/* One scroll area. On wide windows the profile column beside it stays put (it scrolls on its own only when
          the window is too short for it); on narrow ones it splits around the page: profile above, help below. */}
      <div data-settings-scroll className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[75rem] grid-cols-1 gap-8 px-4 pt-4 sm:px-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-x-10">
          <div
            data-settings-sidebar
            className="contents lg:sticky lg:top-0 lg:col-start-1 lg:row-start-1 lg:flex lg:max-h-[calc(100dvh-5rem)] lg:flex-col lg:gap-8 lg:self-start lg:overflow-y-auto lg:pb-6 lg:pt-1"
          >
            <section aria-label="Your profile" className="order-1">
              <Identity />
            </section>
            <aside
              aria-label="Shortcuts and help"
              className="order-3 flex flex-col gap-6 pb-16 lg:pb-0"
            >
              <ShortcutsCard />
              <Card title="Need help?">
                <p className="text-sm text-[var(--text-muted)]">
                  Pi Local runs your agents on this computer. Their conversations and memory stay
                  here, in each agent's own folder.
                </p>
              </Card>
            </aside>
          </div>

          <div className="order-2 min-w-0 lg:col-start-2 lg:row-start-1">
            <div className="sticky top-0 z-20 -mx-1 bg-[var(--bg-settings)] px-1 pb-3 pt-1">
              <SectionNav pathname={pathname} />
            </div>
            <main id="main-content" tabIndex={-1} className="mt-5 pb-16 outline-none">
              <Outlet />
            </main>
          </div>
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

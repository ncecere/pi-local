import { Link, useNavigate } from '@tanstack/react-router';
import { PanelLeft, Search } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Wordmark } from '~/components/brand/wordmark';
import { SidebarInbox } from '~/components/layout/sidebar-inbox';
import { UserMenu } from '~/components/layout/user-menu';
import { Button } from '~/components/ui/button';
import { useAuthConfig } from '~/hooks/use-session';
import { clampSidebar, SIDEBAR_MIN, sidebarMax, useSidebarWidth } from '~/hooks/use-sidebar-width';
import { focusComposerSoon } from '~/lib/focus-after-navigation';
import { ariaKeyShortcuts } from '~/lib/keyboard-shortcuts';
import { loopTab } from '~/lib/tab-loop';
import { cn } from '~/lib/utils';

interface SidebarProps {
  open: boolean;
  mobile: boolean;
  onToggle: () => void;
}

/**
 * The sidebar's right edge: drag to resize, double-click to reset, or focus it
 * and use the arrow keys. Desktop only; on a phone the sidebar is a drawer.
 */
function ResizeRail({
  width,
  setWidth,
  reset,
  onDragging,
}: {
  width: number;
  setWidth: (width: number, persist?: boolean) => void;
  reset: () => void;
  onDragging: (dragging: boolean) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width };
    onDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current) setWidth(start.current.width + event.clientX - start.current.x, false);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    setWidth(start.current.width + event.clientX - start.current.x);
    start.current = null;
    onDragging(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === 'ArrowLeft') setWidth(width - step);
    else if (event.key === 'ArrowRight') setWidth(width + step);
    else if (event.key === 'Home') setWidth(SIDEBAR_MIN);
    else if (event.key === 'End') setWidth(sidebarMax());
    else return;
    event.preventDefault();
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter is role="separator" (WAI-ARIA)
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={clampSidebar(Number.POSITIVE_INFINITY)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 -right-2 z-10 hidden w-4 cursor-col-resize touch-none outline-none lg:block"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-[var(--border-strong)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:bg-[var(--accent-bright)] group-focus-visible:opacity-100"
      />
    </div>
  );
}

export function Sidebar({ open, mobile, onToggle }: SidebarProps) {
  const { width, setWidth, reset } = useSidebarWidth();
  const [dragging, setDragging] = useState(false);
  const { data: config } = useAuthConfig();
  const instance = config?.instance;
  const [search, setSearch] = useState('');
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (mobile && open) closeButtonRef.current?.focus();
  }, [mobile, open]);

  async function handleNewChat() {
    await navigate({ to: '/' });
    if (mobile) onToggle();
    // After the drawer's own focus return, so the message box wins (#251).
    focusComposerSoon();
  }

  return (
    // The role switches with the responsive layout; aria-modal applies only to the mobile dialog.
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: dynamic role and aria-modal are kept in sync
    <aside
      role={mobile ? 'dialog' : undefined}
      aria-modal={mobile ? true : undefined}
      aria-label={mobile ? 'Conversation sidebar' : undefined}
      aria-hidden={!open ? true : undefined}
      inert={!open ? true : undefined}
      // As a modal, Tab and Shift+Tab stay in it (#191).
      onKeyDown={mobile && open ? loopTab : undefined}
      className={cn(
        'fixed inset-y-0 left-0 z-50 flex h-dvh w-full shrink-0 flex-col bg-[var(--bg-app)] bg-[image:var(--sidebar-gradient)]',
        'transition-transform duration-200 ease-out lg:relative lg:z-auto lg:w-[var(--sidebar-width)]',
        !dragging && 'lg:transition-[margin]',
        open
          ? 'translate-x-0 lg:ml-0'
          : '-translate-x-full lg:-ml-[var(--sidebar-width)] lg:translate-x-0',
      )}
      style={{ '--sidebar-width': `${width}px` } as CSSProperties}
    >
      <div data-titlebar className="flex h-14 items-center px-3">
        <Button
          ref={closeButtonRef}
          variant="ghost"
          size="icon-sm"
          onClick={onToggle}
          aria-label="Close sidebar"
          aria-keyshortcuts={ariaKeyShortcuts('toggle-sidebar')}
        >
          <PanelLeft />
        </Button>
        {/* Mark and name sit beside the toggle (v0.10): centring them needed a
            spacer that left too little room for the full default name. */}
        <Link to="/" className="flex min-w-0 flex-1 items-center px-2">
          <Wordmark name={instance?.name} logoUrl={instance?.logoUrl} compact />
        </Link>
      </div>

      <div className="hidden px-3 pb-2 lg:block">
        <Button
          variant="primary"
          className="h-9 w-full font-semibold"
          onClick={handleNewChat}
          aria-keyshortcuts={ariaKeyShortcuts('new-chat')}
        >
          New Chat
        </Button>
      </div>

      <div className="relative px-3">
        <Search className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && search) {
              event.stopPropagation();
              setSearch('');
            }
          }}
          placeholder="Search conversations..."
          aria-label="Search conversations"
          dir="auto"
          aria-describedby="thread-search-hint"
          className="h-11 w-full bg-transparent pl-8 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
        />
      </div>

      <p id="thread-search-hint" className="sr-only">
        Filters your conversations by title.
      </p>

      <div className="mx-3 h-px bg-[var(--border-subtle)]" />

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-3 py-3">
        <SidebarInbox filter={search} />
      </nav>

      <div className="hidden items-center gap-1 p-2 lg:flex">
        <div className="min-w-0 flex-1">
          <UserMenu />
        </div>
      </div>

      <div className="flex items-center justify-between px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] lg:hidden">
        <Button
          variant="accent"
          className="h-11 rounded-full px-5"
          onClick={handleNewChat}
          aria-keyshortcuts={ariaKeyShortcuts('new-chat')}
        >
          New Chat
        </Button>
        <UserMenu compact />
      </div>
      {open && !mobile && (
        <ResizeRail width={width} setWidth={setWidth} reset={reset} onDragging={setDragging} />
      )}
    </aside>
  );
}

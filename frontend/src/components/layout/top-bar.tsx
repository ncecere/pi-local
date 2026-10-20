import { Link, useParams } from '@tanstack/react-router';
import { PanelLeft, Plus, Search } from 'lucide-react';
import { ThemeMenu } from '~/components/layout/theme-menu';
import { Button } from '~/components/ui/button';
import { useAgent } from '~/hooks/use-agents';
import { focusComposerSoon } from '~/lib/focus-after-navigation';
import { ariaKeyShortcuts } from '~/lib/keyboard-shortcuts';
import { cn } from '~/lib/utils';

interface TopBarProps {
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  onOpenCommandPalette: () => void;
}

/**
 * Thin band above the main panel. The band is only a few pixels tall, so the
 * controls it owns are rendered as pills that hang below it over the panel.
 */
export function TopBar({ sidebarOpen, onOpenSidebar, onOpenCommandPalette }: TopBarProps) {
  const params = useParams({ strict: false }) as { agentId?: string; threadId?: string };
  // In a conversation, "+" starts a new one with the same agent.
  const agent = useAgent(params.agentId);

  return (
    <header
      className={cn(
        'relative z-30 shrink-0',
        // The band only bridges the gap beside the sidebar; collapsed, the
        // panel runs to the top of the viewport.
        sidebarOpen ? 'h-[0.9375rem] bg-[var(--bg-app)]' : 'h-0',
      )}
    >
      {!sidebarOpen && (
        <div
          data-floating-controls
          className="absolute left-2 top-6 flex items-center gap-0.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-pill)] p-1 shadow-sm"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenSidebar}
            aria-label="Open sidebar"
            aria-keyshortcuts={ariaKeyShortcuts('toggle-sidebar')}
          >
            <PanelLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenCommandPalette}
            aria-label="Search commands and agents"
            aria-keyshortcuts="Meta+K Control+K"
          >
            <Search />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            asChild
            aria-label={agent ? `New chat with ${agent.name}` : 'New chat'}
            aria-keyshortcuts={ariaKeyShortcuts('new-chat')}
          >
            <Link
              to="/"
              search={agent ? { agent: agent.id } : {}}
              onClick={() => focusComposerSoon()}
            >
              <Plus />
            </Link>
          </Button>
        </div>
      )}

      <div
        data-floating-controls
        className="absolute right-2 top-6 flex items-center gap-0.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-pill)] p-1 shadow-sm"
      >
        <ThemeMenu />
      </div>
    </header>
  );
}

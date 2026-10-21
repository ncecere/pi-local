import { Link } from '@tanstack/react-router';
import { Bot, Lightbulb, Settings } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { useSuggestedFacts } from '~/hooks/use-memory';
import { useCurrentUser } from '~/hooks/use-session';
import { cn } from '~/lib/utils';

export function UserMenu({ compact = false }: { compact?: boolean }) {
  const { user } = useCurrentUser();
  const name = user.name || 'You';
  // Suggestions agents made about the person, waiting for a yes in Settings → You.
  const waiting = useSuggestedFacts().data?.length ?? 0;
  const waitingText = waiting === 1 ? '1 suggestion waiting' : `${waiting} suggestions waiting`;
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        // The name starts with the initials shown on the button (WCAG 2.5.3 Label in Name).
        aria-label={compact ? `${initials}, open user menu` : undefined}
        className={cn(
          'flex items-center gap-3 rounded-lg text-left transition-colors hover:bg-[var(--bg-control)]',
          compact ? 'rounded-full p-1' : 'w-full px-2 py-2',
        )}
      >
        <span
          className={cn(
            'relative flex items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold text-[var(--accent-foreground)]',
            compact ? 'size-10' : 'size-8',
          )}
        >
          {initials}
          {waiting > 0 && (
            <span
              aria-hidden="true"
              data-suggestions-dot=""
              className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-[var(--warning)] ring-2 ring-[var(--bg-app)]"
            />
          )}
        </span>
        <span className={cn('min-w-0 flex-1', compact && 'hidden')}>
          <span className="block truncate text-sm font-medium text-[var(--text-primary)]">
            {name}
          </span>
          <span className="block truncate text-xs text-[var(--text-muted)]">Pi Local</span>
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel className="truncate font-normal text-[var(--text-muted)]">
          {name}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings/agents">
            <Bot />
            Agents
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <Settings />
            Settings
          </Link>
        </DropdownMenuItem>
        {waiting > 0 && (
          <DropdownMenuItem asChild>
            <Link to="/settings/you">
              <Lightbulb />
              {waitingText}
            </Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

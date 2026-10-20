import { Link } from '@tanstack/react-router';
import { Bot, Settings } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { useCurrentUser } from '~/hooks/use-session';
import { cn } from '~/lib/utils';

export function UserMenu({ compact = false }: { compact?: boolean }) {
  const { user } = useCurrentUser();
  const name = user.name || 'You';
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
            'flex items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold text-[var(--accent-foreground)]',
            compact ? 'size-10' : 'size-8',
          )}
        >
          {initials}
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

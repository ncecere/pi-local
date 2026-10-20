import { useNavigate } from '@tanstack/react-router';
import { Bot, ChevronsLeftRight, MoonStar, Palette, Plus, Settings } from 'lucide-react';
import { useMemo } from 'react';
import { focusComposerSoon, touchOnly } from '~/lib/focus-after-navigation';
import { shortcutKeys } from '~/lib/keyboard-shortcuts';
import { useTheme } from '~/providers/theme-provider';
import type { CommandPaletteProps, PaletteGroup } from './types';

/** The palette's commands besides the agents. */
export function usePaletteActions({
  sidebarOpen,
  onSidebarOpenChange,
}: Pick<CommandPaletteProps, 'sidebarOpen' | 'onSidebarOpenChange'>) {
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();
  return useMemo<PaletteGroup[]>(
    () => [
      {
        id: 'chat',
        label: 'Chat',
        items: [
          {
            id: 'new-chat',
            label: 'New chat',
            keywords: 'start conversation home',
            icon: Plus,
            shortcut: shortcutKeys('new-chat'),
            keepFocusOnClose: !touchOnly(),
            onSelect: async () => {
              await navigate({ to: '/' });
              focusComposerSoon();
            },
          },
        ],
      },
      {
        id: 'settings',
        label: 'Settings',
        items: [
          {
            id: 'settings',
            label: 'Open settings',
            keywords: 'account preferences customize appearance avatar conversations archived',
            icon: Settings,
            onSelect: () => navigate({ to: '/settings' }),
          },
          {
            id: 'agents',
            label: 'Manage agents',
            keywords: 'agents create new rename delete',
            icon: Bot,
            onSelect: () => navigate({ to: '/settings/agents' }),
          },
          {
            id: 'toggle-theme',
            label: `Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`,
            keywords: 'toggle appearance color mode',
            icon: resolvedTheme === 'dark' ? Palette : MoonStar,
            onSelect: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
          },
          {
            id: 'toggle-sidebar',
            label: `${sidebarOpen ? 'Close' : 'Open'} sidebar`,
            keywords: 'toggle collapse navigation',
            icon: ChevronsLeftRight,
            shortcut: shortcutKeys('toggle-sidebar'),
            onSelect: () => onSidebarOpenChange(!sidebarOpen),
          },
        ],
      },
    ],
    [navigate, onSidebarOpenChange, resolvedTheme, setTheme, sidebarOpen],
  );
}

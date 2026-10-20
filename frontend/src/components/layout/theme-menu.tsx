import { Link } from '@tanstack/react-router';
import { Monitor, Moon, Settings2, Sun } from 'lucide-react';
import { AVATAR_STYLES, type AvatarStyle } from '~/components/agent/avatar/avatar-art';
import { setAvatarStyle, useAvatarStyle } from '~/components/agent/avatar/avatar-prefs';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { useTheme } from '~/providers/theme-provider';

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

export function ThemeMenu() {
  const { theme, setTheme, codeWrap, setCodeWrap, invertSend, setInvertSend } = useTheme();
  const avatarStyle = useAvatarStyle();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Appearance settings">
          <Settings2 />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => setTheme(value as (typeof THEME_OPTIONS)[number]['value'])}
        >
          {THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <option.icon />
              <span className="flex-1">{option.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuLabel>Avatar</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={avatarStyle}
          onValueChange={(value) => setAvatarStyle(value as AvatarStyle)}
        >
          {AVATAR_STYLES.map((style) => (
            <DropdownMenuRadioItem key={style.id} value={style.id}>
              {style.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuCheckboxItem
          checked={codeWrap}
          onCheckedChange={(checked) => setCodeWrap(checked === true)}
          onSelect={(event) => event.preventDefault()}
        >
          Wrap long code lines
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={invertSend}
          onCheckedChange={(checked) => setInvertSend(checked === true)}
          onSelect={(event) => event.preventDefault()}
        >
          Enter adds a new line
        </DropdownMenuCheckboxItem>

        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings/customization">All settings</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

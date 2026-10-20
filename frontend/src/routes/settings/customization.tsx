import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useId } from 'react';
import { AVATAR_HUES, AVATAR_STYLES, AvatarArt } from '~/components/agent/avatar/avatar-art';
import { setAvatarStyle, useAvatarStyle } from '~/components/agent/avatar/avatar-prefs';
import { SettingsRow, SettingsSection } from '~/components/settings/settings-layout';
import { Switch } from '~/components/ui/switch';
import { usePageTitle } from '~/lib/document-title';
import { cn } from '~/lib/utils';
import { useTheme } from '~/providers/theme-provider';
import type { ColorTheme, ThemeMode } from '~/shared';

const APPEARANCES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

/** The accent families (tokens.css), shown by their own colour. */
const ACCENTS: { value: ColorTheme; label: string; swatch: string }[] = [
  { value: 'neutral', label: 'Neutral', swatch: 'oklch(0.75 0 0)' },
  { value: 'blue', label: 'Blue', swatch: 'oklch(0.62 0.19 259)' },
  { value: 'violet', label: 'Violet', swatch: 'oklch(0.6 0.22 293)' },
  { value: 'emerald', label: 'Emerald', swatch: 'oklch(0.6 0.15 163)' },
];

const SEGMENT =
  'flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--accent-bright)]';

export function SettingsCustomizationPage() {
  usePageTitle('Customization · Settings');
  const theme = useTheme();
  const avatarStyle = useAvatarStyle();
  const id = useId();

  return (
    <>
      <SettingsSection title="Look" first>
        <SettingsRow
          id={`${id}-appearance`}
          label="Appearance"
          description="Light, dark, or follow your device's setting."
        >
          <div
            role="radiogroup"
            aria-labelledby={`${id}-appearance-label`}
            className="inline-flex gap-1 rounded-xl bg-[var(--bg-segment-track)] p-1"
          >
            {APPEARANCES.map((option) => (
              <label
                key={option.value}
                className={cn(
                  SEGMENT,
                  theme.theme === option.value
                    ? 'bg-[var(--bg-segment-active)] font-medium text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                )}
              >
                <input
                  type="radio"
                  name={`${id}-appearance`}
                  checked={theme.theme === option.value}
                  onChange={() => theme.setTheme(option.value as ThemeMode)}
                  className="sr-only"
                />
                <option.icon className="size-3.5" aria-hidden="true" />
                {option.label}
              </label>
            ))}
          </div>
        </SettingsRow>

        <SettingsRow
          id={`${id}-accent`}
          label="Accent"
          description="The colour of buttons, links and highlights."
        >
          <div role="radiogroup" aria-labelledby={`${id}-accent-label`} className="flex gap-2">
            {ACCENTS.map((accent) => {
              const selected = theme.colorTheme === accent.value;
              return (
                <label
                  key={accent.value}
                  title={accent.label}
                  className="relative flex size-9 cursor-pointer items-center justify-center rounded-full has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--accent-bright)]"
                  style={{ background: accent.swatch }}
                >
                  <input
                    type="radio"
                    name={`${id}-accent`}
                    aria-label={accent.label}
                    checked={selected}
                    onChange={() => theme.setColorTheme(accent.value)}
                    className="sr-only"
                  />
                  {selected && (
                    <Check className="size-4 text-white drop-shadow" aria-hidden="true" />
                  )}
                </label>
              );
            })}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Agents">
        <div>
          <p id={`${id}-avatar-label`} className="text-sm font-medium text-[var(--text-primary)]">
            Avatar style
          </p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">
            How agents look. Each one moves with what the agent is doing: thinking, working, waiting
            for you.
          </p>
          <div
            role="radiogroup"
            aria-labelledby={`${id}-avatar-label`}
            className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3"
          >
            {AVATAR_STYLES.map((style, index) => {
              const selected = avatarStyle === style.id;
              return (
                <label
                  key={style.id}
                  className={cn(
                    'flex cursor-pointer flex-col items-center gap-3 rounded-2xl border p-4 text-center transition-colors',
                    'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--accent-bright)]',
                    selected
                      ? 'border-[var(--accent-button-border)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border-subtle)] hover:bg-[var(--bg-control)]',
                  )}
                >
                  <input
                    type="radio"
                    name={`${id}-avatar`}
                    checked={selected}
                    onChange={() => setAvatarStyle(style.id)}
                    className="sr-only"
                  />
                  <span className="flex items-center gap-3">
                    <AvatarArt
                      style={style.id}
                      state="thinking"
                      hue={AVATAR_HUES[0]}
                      size={44}
                      phase={index * 4}
                    />
                    <AvatarArt
                      style={style.id}
                      state="working"
                      hue={AVATAR_HUES[3]}
                      size={28}
                      phase={index * 4 + 2}
                    />
                  </span>
                  <span className="text-sm font-medium text-[var(--text-primary)]">
                    {style.name}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Typing and reading">
        <SettingsRow
          id={`${id}-send`}
          label="Enter adds a new line"
          description={`On: Enter adds a line and ${navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}+Enter sends. Off: Enter sends and Shift+Enter adds a line.`}
        >
          <Switch
            checked={theme.invertSend}
            onCheckedChange={theme.setInvertSend}
            aria-labelledby={`${id}-send-label`}
            aria-describedby={`${id}-send-description`}
          />
        </SettingsRow>
        <SettingsRow
          id={`${id}-wrap`}
          label="Wrap long code lines"
          description="Wrap lines in code blocks instead of scrolling them sideways."
        >
          <Switch
            checked={theme.codeWrap}
            onCheckedChange={theme.setCodeWrap}
            aria-labelledby={`${id}-wrap-label`}
            aria-describedby={`${id}-wrap-description`}
          />
        </SettingsRow>
      </SettingsSection>

      <p className="mt-12 text-xs text-[var(--text-muted)]">
        Saved to your account, so they follow you to every device you sign in on.
      </p>
    </>
  );
}

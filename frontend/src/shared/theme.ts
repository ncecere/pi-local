export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Accent families layered over the shared neutral surface palette. */
export const COLOR_THEMES = ['neutral', 'blue', 'violet', 'emerald'] as const;
export type ColorTheme = (typeof COLOR_THEMES)[number];

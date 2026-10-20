/**
 * Keyboard shortcuts for the inbox. t3code's (⌘⇧S, ⌘⇧[ ], ⌘1–9) are a desktop
 * app's: in a browser ⌘⇧[ ] and ⌘1–9 switch tabs and cannot be taken over, so
 * these use ⌥ (Alt), which browsers leave to the page.
 */
export type InboxShortcut = 'previous' | 'next' | 'next-attention' | 'settle' | 'pin' | 'unread';

export const INBOX_SHORTCUTS: { id: InboxShortcut; label: string; keys: string[]; aria: string }[] =
  [
    { id: 'previous', label: 'Previous conversation', keys: ['⌥', '↑'], aria: 'Alt+ArrowUp' },
    { id: 'next', label: 'Next conversation', keys: ['⌥', '↓'], aria: 'Alt+ArrowDown' },
    {
      id: 'next-attention',
      label: 'Next that needs you',
      keys: ['⌥', '⇧', '↓'],
      aria: 'Alt+Shift+ArrowDown',
    },
    { id: 'settle', label: 'Settle, then next', keys: ['⌥', '⇧', 'S'], aria: 'Alt+Shift+S' },
    { id: 'pin', label: 'Pin or unpin', keys: ['⌥', '⇧', 'P'], aria: 'Alt+Shift+P' },
    { id: 'unread', label: 'Mark unread', keys: ['⌥', '⇧', 'U'], aria: 'Alt+Shift+U' },
  ];

/** The keys as they are written on this platform: Alt rather than ⌥ off Apple. */
export const shortcutLabel = (keys: string[], apple: boolean) =>
  apple ? keys : keys.map((key) => (key === '⌥' ? 'Alt' : key === '⇧' ? 'Shift' : key));

/**
 * Which inbox shortcut a key press is, if any. By `code`, not `key`: with ⌥
 * held, a Mac types "ß" for S.
 */
export function matchInboxShortcut(event: {
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  code: string;
}): InboxShortcut | null {
  if (!event.altKey || event.metaKey || event.ctrlKey) return null;
  if (event.code === 'ArrowUp' && !event.shiftKey) return 'previous';
  if (event.code === 'ArrowDown') return event.shiftKey ? 'next-attention' : 'next';
  if (!event.shiftKey) return null;
  if (event.code === 'KeyS') return 'settle';
  if (event.code === 'KeyP') return 'pin';
  if (event.code === 'KeyU') return 'unread';
  return null;
}

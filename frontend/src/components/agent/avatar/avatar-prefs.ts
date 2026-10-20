import { useSyncExternalStore } from 'react';
import { AVATAR_STYLES, type AvatarStyle } from './avatar-art';

/** Which avatar style this person sees for every agent. Kept in this browser. */
const KEY = 'pai.avatarStyle';
const DEFAULT_STYLE: AvatarStyle = 'face';

function read(): AvatarStyle {
  try {
    const stored = localStorage.getItem(KEY);
    return AVATAR_STYLES.find((style) => style.id === stored)?.id ?? DEFAULT_STYLE;
  } catch {
    return DEFAULT_STYLE;
  }
}

let current: AvatarStyle = read();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export function setAvatarStyle(style: AvatarStyle) {
  current = style;
  try {
    localStorage.setItem(KEY, style);
  } catch {
    // Storage blocked or full: the choice lasts for this page only.
  }
  notify();
}

/** Back to the default: another person has signed in on this browser. */
export function resetAvatarStyle() {
  current = DEFAULT_STYLE;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Open tabs follow each other.
  const follow = (event: StorageEvent) => {
    if (event.key !== null && event.key !== KEY) return;
    current = read();
    notify();
  };
  window.addEventListener('storage', follow);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', follow);
  };
}

export function useAvatarStyle(): AvatarStyle {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_STYLE,
  );
}

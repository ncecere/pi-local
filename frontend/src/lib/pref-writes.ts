import { api } from '~/api/client';

/**
 * Saving a person's prefs (`PUT /api/me/prefs/{key}`): at once, or after a
 * short pause so a burst of changes is one request. Either way, one request
 * per pref is in flight at a time, and the latest value goes next, so an older
 * value never lands after a newer one.
 *
 * A pause would lose a change made just before a reload or a close, so what is
 * waiting is sent at once, with `keepalive`, when the page goes away or is
 * hidden (installPrefFlush).
 */

interface Slot {
  /** The latest value, not sent yet. */
  value?: unknown;
  waiting: boolean;
  timer?: ReturnType<typeof setTimeout>;
  inFlight: number;
  /** Told when a save of this pref fails, so the caller can try again later. */
  onError?: () => void;
}

const slots = new Map<string, Slot>();

const prefPath = (key: string) => `/api/me/prefs/${encodeURIComponent(key)}`;

function send(key: string, keepalive = false) {
  const slot = slots.get(key);
  if (!slot?.waiting) return;
  clearTimeout(slot.timer);
  slot.timer = undefined;
  // One at a time; it goes when the one in flight ends. Unless the page is going away.
  if (slot.inFlight > 0 && !keepalive) return;
  const { value, onError } = slot;
  slot.waiting = false;
  slot.value = undefined;
  slot.inFlight += 1;
  void api
    .put(prefPath(key), { value }, keepalive ? { keepalive: true } : undefined)
    .catch(() => onError?.())
    .finally(() => {
      slot.inFlight -= 1;
      if (slot.waiting && slot.timer === undefined) send(key);
      else if (!slot.waiting && slot.inFlight === 0 && slots.get(key) === slot) slots.delete(key);
    });
}

/**
 * Saves `value` as the pref `key`: at once, or `delayMs` after the last call
 * for that key. A newer value replaces one still waiting.
 */
export function writePref(
  key: string,
  value: unknown,
  { delayMs = 0, onError }: { delayMs?: number; onError?: () => void } = {},
) {
  let slot = slots.get(key);
  if (!slot) {
    slot = { waiting: false, inFlight: 0 };
    slots.set(key, slot);
  }
  slot.value = value;
  slot.waiting = true;
  slot.onError = onError;
  clearTimeout(slot.timer);
  slot.timer = undefined;
  if (delayMs > 0) slot.timer = setTimeout(() => send(key), delayMs);
  else send(key);
}

/** Whether a pref has a value waiting to be sent (tests). */
export function hasPendingPref(key: string): boolean {
  return slots.get(key)?.waiting ?? false;
}

/** Sends every waiting pref now, with `keepalive` so it survives the page. */
export function flushPrefWrites() {
  for (const key of [...slots.keys()]) send(key, true);
}

/**
 * Flushes waiting prefs when the page is hidden or goes away (a reload, a
 * close). Returns a function that stops it.
 */
export function installPrefFlush(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onHidden = () => {
    if (document.visibilityState === 'hidden') flushPrefWrites();
  };
  window.addEventListener('pagehide', flushPrefWrites);
  document.addEventListener('visibilitychange', onHidden);
  return () => {
    window.removeEventListener('pagehide', flushPrefWrites);
    document.removeEventListener('visibilitychange', onHidden);
  };
}

/** Forgets every waiting write (tests). */
export function resetPrefWrites() {
  for (const slot of slots.values()) clearTimeout(slot.timer);
  slots.clear();
}

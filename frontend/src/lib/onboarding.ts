import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useCurrentUser } from '~/hooks/use-session';
import { writePref } from '~/lib/pref-writes';
import { PREFS_KEY, usePrefs } from '~/lib/prefs';

/**
 * The Get started card's choices, saved as the `onboarding` pref (docs/api.md)
 * so they follow the person: `skipModel`, they chose to try the demo model
 * rather than connect one.
 */
export interface OnboardingPrefs {
  skipModel?: boolean;
}

/** Where this browser kept `skipModel` before the pref: read once, moved to the pref, removed. */
export const LEGACY_SKIP_MODEL_KEY = 'pai.onboarding.skipModel';

/** Reads a saved onboarding pref, keeping only what is valid. */
export function parseOnboarding(value: unknown): OnboardingPrefs {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  return typeof raw.skipModel === 'boolean' ? { skipModel: raw.skipModel } : {};
}

function readLegacy(): boolean {
  try {
    return localStorage.getItem(LEGACY_SKIP_MODEL_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Whether the person chose the demo model, and a setter that saves it. Until
 * the pref says, this browser's old choice (localStorage) holds, and once the
 * prefs are read it is moved into the pref.
 */
export function useSkipModel(): [boolean, (skip: boolean) => void] {
  const me = useCurrentUser();
  const prefs = usePrefs();
  const queryClient = useQueryClient();
  const [legacy] = useState(readLegacy);
  const saved = parseOnboarding(prefs.data?.onboarding);
  const skipped = saved.skipModel ?? legacy;

  const set = (skip: boolean) => {
    const key = [...PREFS_KEY, me?.user.id];
    const before = queryClient.getQueryData<Record<string, unknown>>(key);
    const next: OnboardingPrefs = { ...parseOnboarding(before?.onboarding), skipModel: skip };
    queryClient.setQueryData<Record<string, unknown>>(key, { ...before, onboarding: next });
    writePref('onboarding', next);
    try {
      localStorage.removeItem(LEGACY_SKIP_MODEL_KEY);
    } catch {
      // Storage unavailable: nothing to clean up.
    }
  };

  const moved = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: moved once, when the prefs arrive
  useEffect(() => {
    if (moved.current || !prefs.isSuccess) return;
    moved.current = true;
    if (!legacy) return;
    if (saved.skipModel === undefined) set(true);
    else localStorage.removeItem(LEGACY_SKIP_MODEL_KEY);
  }, [prefs.isSuccess]);

  return [skipped, set];
}

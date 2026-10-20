import { useCallback, useEffect, useState } from 'react';

/** The sidebar's width, dragged by its edge and remembered in this browser (as t3code's is). */
const KEY = 'pai.sidebarWidth';
export const SIDEBAR_DEFAULT = 320;
export const SIDEBAR_MIN = 240;
/** The conversation always keeps at least this much room. */
const MAIN_MIN = 640;

export const sidebarMax = () =>
  Math.max(SIDEBAR_MIN, (typeof window === 'undefined' ? 1600 : window.innerWidth) - MAIN_MIN);

export const clampSidebar = (width: number) =>
  Math.round(Math.min(sidebarMax(), Math.max(SIDEBAR_MIN, width)));

function read(): number {
  try {
    const stored = Number(localStorage.getItem(KEY));
    return Number.isFinite(stored) && stored > 0 ? clampSidebar(stored) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

export function useSidebarWidth() {
  const [width, setWidthState] = useState(read);
  const setWidth = useCallback((next: number, persist = true) => {
    const value = clampSidebar(next);
    setWidthState(value);
    if (persist)
      try {
        localStorage.setItem(KEY, String(value));
      } catch {
        // Storage blocked: the width lasts for this page only.
      }
  }, []);
  const reset = useCallback(() => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // Nothing stored.
    }
    setWidthState(clampSidebar(SIDEBAR_DEFAULT));
  }, []);
  // A narrower window never leaves the conversation squeezed.
  useEffect(() => {
    const fit = () => setWidthState((current) => clampSidebar(current));
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return { width, setWidth, reset };
}

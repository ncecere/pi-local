import { useEffect, useState } from 'react';

/**
 * The time now, ticking every `every` ms (half a minute by default), so "just
 * now" and "in 5 minutes" stay true. It also catches up at once when the page
 * is shown again: a hidden window's timers are slowed or paused, which left
 * relative times stale.
 */
export function useNow(every = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, every);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', tick);
    };
  }, [every]);
  return now;
}

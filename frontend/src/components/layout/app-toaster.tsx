import { type AnyRouter, useRouterState } from '@tanstack/react-router';
import { Toaster } from 'sonner';

/** Clears the section tabs that stick to the top of Settings (they end about 6.5rem down). */
const BELOW_SETTINGS_TABS = 112;
const DEFAULT_TOP = 16;

/**
 * The app's toasts, at the top centre: clear of the Send button (bottom right)
 * and of the controls in the top corners. Settings has its section tabs along
 * the top, so there they sit just under them.
 */
export function AppToaster({ router }: { router: AnyRouter }) {
  const inSettings = useRouterState({
    router,
    select: (state) => state.location.pathname.startsWith('/settings'),
  });
  const top = inSettings ? BELOW_SETTINGS_TABS : DEFAULT_TOP;
  return <Toaster theme="dark" position="top-center" offset={{ top }} mobileOffset={{ top }} />;
}

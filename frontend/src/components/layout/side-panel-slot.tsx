import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

/**
 * A column beside the page, the full height of the main panel (the app shell's). A page's side panel renders into it,
 * so the panel reaches the top of the window instead of starting below the strip the floating controls keep.
 */
export const SidePanelSlotContext = createContext<HTMLElement | null>(null);

/** Its children in the side column when the shell has one; in place otherwise (tests, pages outside the shell). */
export function SidePanelPortal({ children }: { children: ReactNode }) {
  const slot = useContext(SidePanelSlotContext);
  return slot ? createPortal(children, slot) : children;
}

import { cn } from '~/lib/utils';

/**
 * Pi Agent Interface's mark, "Face": an amber face with two upright eyes (the
 * app's Face avatar) on a near-black tile.
 *
 * Source: pai-assets `logo/face/mark-small.svg` (the drawing for 20 to 47 px),
 * commit 08ca4a6. The icons in public/ (favicon.svg, favicon.ico,
 * apple-touch-icon.png, icon-192/512.png, icon-512-maskable.png) are copied
 * unchanged from the same commit's `logo/face/` and `logo/face/png/`.
 *
 * Usage rules from the logo README: the tile mark reads on light and dark
 * surfaces, so it is used everywhere; its colours are fixed and never follow
 * an instance's accent theme; it is decorative beside the live-text name.
 */
export function FaceMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
      data-brand-mark="face"
      className={cn('size-7 shrink-0', className)}
    >
      <rect width="64" height="64" rx="14" fill="#171717" />
      <circle cx="32" cy="32" r="21" fill="#fe9a00" />
      <rect x="22.5" y="24.5" width="6.5" height="12" rx="3.25" fill="#171717" />
      <rect x="35" y="24.5" width="6.5" height="12" rx="3.25" fill="#171717" />
    </svg>
  );
}

import { type AnyRouter, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAttentionCount } from '~/hooks/use-inbox';
import { useAuthConfig } from '~/hooks/use-session';
import {
  applyBrandIcons,
  brandIconHref,
  documentTitle,
  pageTitleFor,
  usePageTitleOverride,
} from '~/lib/document-title';

/**
 * Keeps the tab title and icon in step with Branding and the current page.
 *
 * Mounted beside the router rather than inside a route, so it covers the
 * sign-in and public share pages too (`/auth/status` is public). Renders
 * nothing. Until the status arrives the title is the product's name, as
 * index.html serves it.
 */
export function DocumentBranding({ router }: { router: AnyRouter }) {
  const { data } = useAuthConfig();
  const pathname = useRouterState({ router, select: (state) => state.location.pathname });
  const override = usePageTitleOverride();
  // "(2) …": conversations with a reply or a failure that have not been seen.
  const attention = useAttentionCount();
  const appName = data?.instance.name;
  const icon = brandIconHref(data?.instance.logoUrl);

  useEffect(() => {
    const title = documentTitle(override ?? pageTitleFor(pathname), appName);
    document.title = attention > 0 ? `(${attention}) ${title}` : title;
  }, [appName, override, pathname, attention]);

  useEffect(() => {
    // Wait for the status: resetting to the default first would flash it.
    if (data) applyBrandIcons(icon);
  }, [data, icon]);

  return null;
}

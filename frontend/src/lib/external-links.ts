import { api } from '~/api/client';

/**
 * In the desktop app, links to other sites open in the person's browser. Its web view can't open windows (a
 * `target="_blank"` link or `window.open` does nothing there) and must not navigate away from the app, so external
 * links and `window.open` go to `POST /api/open-url` instead. In a browser nothing changes.
 */
export function isExternalHref(href: string, origin = location.origin): boolean {
  try {
    const url = new URL(href, origin);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin !== origin;
  } catch {
    return false;
  }
}

export function openInBrowser(href: string): void {
  void api.post('/api/open-url', { url: new URL(href, location.href).toString() }).catch(() => {
    // Nothing better to do: the link stays where it is for the person to copy.
  });
}

export function installExternalLinks(doc: Document = document, win: Window = window): void {
  if (!doc.documentElement.dataset.shell?.startsWith('desktop')) return;
  // After the app's own handlers (a link that asks first calls preventDefault and opens it later with window.open).
  doc.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!link || !isExternalHref(link.href, win.location.origin)) return;
    event.preventDefault();
    openInBrowser(link.href);
  });
  const open = win.open.bind(win);
  win.open = ((url?: string | URL, target?: string, features?: string) => {
    const href = url === undefined ? '' : String(url);
    if (href && isExternalHref(href, win.location.origin)) {
      openInBrowser(href);
      return null;
    }
    return open(url, target, features);
  }) as typeof win.open;
}

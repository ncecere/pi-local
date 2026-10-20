// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { httpTransport, type Method, setTransport } from '../../src/api/transport';
import { installExternalLinks, isExternalHref } from '../../src/lib/external-links';

const posts: unknown[] = [];
function fakeApi() {
  setTransport({
    ...httpTransport,
    channel: () => null,
    async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
      posts.push({ method, path, body });
      return { ok: true } as T;
    },
  });
}

afterEach(() => {
  posts.length = 0;
  setTransport(httpTransport);
  document.body.innerHTML = '';
  delete document.documentElement.dataset.shell;
});

describe('external links', () => {
  it('tells other sites from the app', () => {
    expect(isExternalHref('https://login.microsoftonline.com/x', 'http://localhost:3000')).toBe(
      true,
    );
    expect(isExternalHref('/settings', 'http://localhost:3000')).toBe(false);
    expect(isExternalHref('mailto:a@b.c', 'http://localhost:3000')).toBe(false);
  });

  it('in the desktop app, opens external links and window.open in the browser, and leaves app links alone', async () => {
    fakeApi();
    document.documentElement.dataset.shell = 'desktop-mac';
    const win = {
      location: { origin: location.origin },
      open: () => 'original',
    } as unknown as Window;
    installExternalLinks(document, win);
    document.body.innerHTML = `<a id="out" href="https://example.com/a" target="_blank">x</a><a id="in" href="/settings">y</a>`;
    const out = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('out')!.dispatchEvent(out);
    expect(out.defaultPrevented).toBe(true);
    const inside = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('in')!.dispatchEvent(inside);
    expect(inside.defaultPrevented).toBe(false);
    expect(win.open('https://example.com/b')).toBeNull();
    await Promise.resolve();
    expect(posts).toEqual([
      { method: 'POST', path: '/api/open-url', body: { url: 'https://example.com/a' } },
      { method: 'POST', path: '/api/open-url', body: { url: 'https://example.com/b' } },
    ]);
  });

  it('in a browser, changes nothing', () => {
    fakeApi();
    const win = {
      location: { origin: location.origin },
      open: () => 'original',
    } as unknown as Window;
    installExternalLinks(document, win);
    expect(win.open('https://example.com/b')).toBe('original');
    expect(posts).toEqual([]);
  });
});

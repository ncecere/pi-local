// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { Markdown, preloadMarkdownRenderer } from '../../src/components/chat/markdown';

it('renders angle-bracket types and raw HTML literally, without affecting code or links', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await preloadMarkdownRenderer();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <Markdown>
          {
            'Trace: <string> in <module>.\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n`<code>` and [docs](https://example.com)\n\n```text\n<string>\n```'
          }
        </Markdown>,
      ),
    );
    expect(container.textContent).toContain('Trace: <string> in <module>.');
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.querySelector('script, img, string, module')).toBeNull();
    expect(container.querySelector('a')?.textContent).toBe('docs');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/');
    expect(
      [...container.querySelectorAll('code')].some((node) =>
        node.textContent?.includes('<string>'),
      ),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}, 15_000);

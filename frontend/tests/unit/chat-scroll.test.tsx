// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sentQuestion, useChatScroll } from '../../src/hooks/use-chat-scroll';

/**
 * The scroll behaviour of a conversation, against a small layout engine
 * (happy-dom has none): a row is as tall as `heights` says (100px otherwise),
 * the spacer is its style height, and the scroller shows VIEW px from its
 * scrollTop, clamped like a real one.
 */
const VIEW = 400;
let heights: Record<string, number> = {};
let scrollTop = 0;
let scroller: HTMLElement | null = null;

const rowHeight = (id: string | undefined) => (id ? (heights[id] ?? 100) : 0);
function rowsOf(content: Element) {
  return [...content.querySelectorAll<HTMLElement>('[data-message-id]')];
}
function spacerOf(): number {
  return (
    Number.parseFloat(scroller?.querySelector<HTMLElement>('[data-spacer]')?.style.height ?? '') ||
    0
  );
}
function totalRows(content: Element): number {
  return rowsOf(content).reduce((sum, row) => sum + rowHeight(row.dataset.messageId), 0);
}

const realRect = HTMLElement.prototype.getBoundingClientRect;
function box(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 0, width: 0 } as DOMRect;
}

beforeEach(() => {
  heights = {};
  scrollTop = 0;
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this === scroller) return box(0, VIEW);
    const content =
      this.closest('[data-content]') ?? (this.hasAttribute('data-content') ? this : null);
    if (!content) return box(0, 0);
    if (this === content) return box(-scrollTop, totalRows(content));
    let top = 0;
    for (const row of rowsOf(content)) {
      if (row === this) return box(top - scrollTop, rowHeight(row.dataset.messageId));
      top += rowHeight(row.dataset.messageId);
    }
    return box(0, 0);
  };
});
afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = realRect;
});

const message = (
  id: string,
  role: 'user' | 'assistant',
  text = id,
  pending = false,
): UIMessage => ({
  id,
  role,
  parts: [{ type: 'text', text }],
  ...(pending ? { metadata: { pending: 'queued' } } : {}),
});

function Harness({ messages, streaming }: { messages: UIMessage[]; streaming: boolean }) {
  const scroll = useChatScroll(messages, streaming);
  return (
    <div
      ref={(node) => {
        scroller = node;
        scroll.scrollRef.current = node;
        if (!node) return;
        // A real scroller: scrollTop is clamped to what there is to scroll.
        Object.defineProperties(node, {
          clientHeight: { configurable: true, get: () => VIEW },
          scrollHeight: {
            configurable: true,
            get: () => {
              const content = node.querySelector('[data-content]');
              return (content ? totalRows(content) : 0) + spacerOf();
            },
          },
          scrollTop: {
            configurable: true,
            get: () => scrollTop,
            set: (value: number) => {
              const max = Math.max(0, (node as HTMLElement).scrollHeight - VIEW);
              scrollTop = Math.min(Math.max(0, value), max);
              // The scroll event follows a move, whoever made it.
              queueMicrotask(() => node.dispatchEvent(new Event('scroll')));
            },
          },
        });
      }}
      onScroll={scroll.onScroll}
    >
      <div ref={scroll.contentRef} data-content="">
        {messages.map((m) => (
          <div key={m.id} data-message-id={m.id} data-message-role={m.role} />
        ))}
      </div>
      <div ref={scroll.spacerRef} data-spacer="" />
      {scroll.detached && (
        <button type="button" onClick={scroll.jumpToLatest}>
          Jump to latest
        </button>
      )}
    </div>
  );
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

async function show(messages: UIMessage[], streaming: boolean) {
  if (!root) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(<Harness messages={messages} streaming={streaming} />);
  });
}

/** The reader scrolls up to `top`: the scroll event follows the move. */
async function scrollUpTo(top: number) {
  await act(async () => {
    if (scroller) {
      scroller.scrollTop = top;
    }
    await Promise.resolve();
  });
}

const maxScroll = () => (scroller?.scrollHeight ?? 0) - VIEW;
const jumpButton = () =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Jump to latest');

describe('A message sent while the agent works', () => {
  const question = message('u1', 'user');
  const reply = message('a1', 'assistant');

  it('keeps the view at the bottom, and following the reply as it grows', async () => {
    heights.a1 = 600;
    await show([question, reply], false);
    expect(scrollTop).toBe(maxScroll());

    // The reply streams; a second message is queued meanwhile.
    await show([question, reply], true);
    await show([question, reply, message('u2', 'user', 'u2', true)], true);
    // Nothing was pinned to the top: no room kept below the queued message.
    expect(spacerOf()).toBe(0);
    expect(scrollTop).toBe(maxScroll());
    expect(scrollTop).toBeGreaterThan(0);
    expect(jumpButton()).toBeUndefined();

    // The reply goes on growing: the view stays with its end.
    heights.a1 = 900;
    await show(
      [question, message('a1', 'assistant', 'more words'), message('u2', 'user', 'u2', true)],
      true,
    );
    expect(scrollTop).toBe(maxScroll());
    expect(scrollTop).toBe(900 + 100 + 100 - VIEW);
  });

  it('leaves a reader who scrolled up where they are, and offers Jump to latest', async () => {
    heights.a1 = 900;
    await show([question, reply], false);
    await show([question, reply], true);
    await scrollUpTo(120);
    expect(scrollTop).toBe(120);
    expect(jumpButton()).toBeDefined();

    await show([question, reply, message('u2', 'user', 'u2', true)], true);
    expect(scrollTop).toBe(120);
    heights.a1 = 1200;
    await show(
      [question, message('a1', 'assistant', 'more'), message('u2', 'user', 'u2', true)],
      true,
    );
    expect(scrollTop).toBe(120);
    expect(jumpButton()).toBeDefined();

    await act(async () => {
      jumpButton()?.click();
    });
    expect(scrollTop).toBe(maxScroll());
    expect(jumpButton()).toBeUndefined();
  });

  it('still pins a question sent while the agent was idle', async () => {
    heights.a1 = 600;
    await show([question, reply], false);
    await show([question, reply, message('u2', 'user', 'u2', true)], true);
    // The question sits at the top of the view with room below for the reply.
    expect(spacerOf()).toBe(VIEW - (100 + 16));
    expect(scrollTop).toBe(maxScroll());
  });
});

describe('sentQuestion', () => {
  const user = (id: string) => message(id, 'user');
  const reply = message('a1', 'assistant');

  it('is a question added while the agent was idle', () => {
    expect(sentQuestion([user('q1'), reply, user('q2')], 1)).toBe(true);
    expect(sentQuestion([user('q1'), reply, user('q2')], 1, false)).toBe(true);
  });
  it('is not one added while the agent was working', () => {
    expect(sentQuestion([user('q1'), reply, user('q2')], 1, true)).toBe(false);
  });
});

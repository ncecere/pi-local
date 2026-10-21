// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  httpTransport,
  type Method,
  type RequestOptions,
  setTransport,
} from '../../src/api/transport';
import {
  flushPrefWrites,
  hasPendingPref,
  installPrefFlush,
  resetPrefWrites,
  writePref,
} from '../../src/lib/pref-writes';

interface Call {
  method: Method;
  path: string;
  body: unknown;
  options?: RequestOptions;
}

let calls: Call[];
let answer: () => Promise<unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  answer = () => Promise.resolve({ ok: true });
  setTransport({
    ...httpTransport,
    request<T>(method: Method, path: string, body?: unknown, options?: RequestOptions) {
      calls.push({ method, path, body, ...(options ? { options } : {}) });
      return answer() as Promise<T>;
    },
  });
});

afterEach(() => {
  resetPrefWrites();
  setTransport(httpTransport);
  vi.useRealTimers();
});

/** Lets resolved requests finish. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('saving prefs', () => {
  it('saves at once without a delay', () => {
    writePref('appearance', { theme: 'light' });
    expect(calls).toEqual([
      { method: 'PUT', path: '/api/me/prefs/appearance', body: { value: { theme: 'light' } } },
    ]);
  });

  it('saves a burst once, after the pause, with the latest value', () => {
    writePref('inbox', { n: 1 }, { delayMs: 1500 });
    writePref('inbox', { n: 2 }, { delayMs: 1500 });
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1500);
    expect(calls.map((call) => call.body)).toEqual([{ value: { n: 2 } }]);
  });

  it('sends one at a time per pref, and the latest goes next', async () => {
    let finish: (() => void) | undefined;
    answer = () =>
      new Promise((resolve) => {
        finish = () => resolve({ ok: true });
      });
    writePref('appearance', 'a');
    writePref('appearance', 'b');
    writePref('appearance', 'c');
    expect(calls.map((call) => call.body)).toEqual([{ value: 'a' }]);
    finish?.();
    await settle();
    expect(calls.map((call) => call.body)).toEqual([{ value: 'a' }, { value: 'c' }]);
  });

  it('tells the caller when a save fails', async () => {
    answer = () => Promise.reject(new Error('offline'));
    const onError = vi.fn();
    writePref('inbox', {}, { onError });
    await settle();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('a quick reload', () => {
  it('sends what waits at once, with keepalive, when the page is hidden', () => {
    const stop = installPrefFlush();
    writePref('inbox', { archived: 'a/1' }, { delayMs: 1500 });
    expect(calls).toEqual([]);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(calls).toEqual([
      {
        method: 'PUT',
        path: '/api/me/prefs/inbox',
        body: { value: { archived: 'a/1' } },
        options: { keepalive: true },
      },
    ]);
    expect(hasPendingPref('inbox')).toBe(false);
    // The timer has nothing left to send.
    vi.advanceTimersByTime(1500);
    expect(calls).toHaveLength(1);

    stop();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('sends what waits on pagehide, even with a request in flight', () => {
    const stop = installPrefFlush();
    answer = () => new Promise(() => undefined); // never answers
    writePref('appearance', 'dark');
    writePref('appearance', 'light');
    expect(calls).toHaveLength(1);
    window.dispatchEvent(new Event('pagehide'));
    expect(calls.map((call) => [call.body, call.options])).toEqual([
      [{ value: 'dark' }, undefined],
      [{ value: 'light' }, { keepalive: true }],
    ]);
    stop();
  });

  it('has nothing to send when nothing waits', () => {
    flushPrefWrites();
    expect(calls).toEqual([]);
  });
});

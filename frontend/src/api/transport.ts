import { readEvents, type ServerSentEvent } from '~/lib/sse';
import { apiErrorFrom } from './errors';

/**
 * The one place the app reaches the Go backend (docs/api.md). Today that is
 * plain same-origin HTTP to relative `/api` paths: through the Wails v3 asset
 * server in the desktop app, and through Vite's dev proxy (or the headless
 * server) in development. Both streams were verified to flow, unbuffered,
 * through the asset server on macOS (spikes/FINDINGS.md).
 *
 * Everything else calls `transport.*`, so this can be swapped (say, for Wails
 * events) with `setTransport()` without touching the hooks.
 */

export type Method = 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';

/** A live `/api/events`-style stream of named events. */
export interface EventChannel {
  /** Calls `listener` with each `event: type` message's data. */
  on(type: string, listener: (data: string) => void): void;
  /** Called when the connection breaks (it reconnects on its own). */
  onError(listener: () => void): void;
  close(): void;
}

export interface Transport {
  /** A request; the `data` of the answer, or throws an ApiError. */
  request<T>(method: Method, path: string, body?: unknown): Promise<T>;
  /**
   * Reads a server-sent event stream until the server ends it. Rejects with an
   * ApiError for a refused request, or the network error when the connection
   * breaks. Used for a thread's events: it exposes the status and can abort.
   */
  stream(
    path: string,
    onEvent: (event: ServerSentEvent) => void,
    signal: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<void>;
  /** A self-reconnecting event channel (EventSource), or null where there is none. */
  channel(path: string): EventChannel | null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // An empty or non-JSON answer: the status says enough.
    return null;
  }
}

export const httpTransport: Transport = {
  async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await readJson(response);
    if (!response.ok) throw apiErrorFrom(response, parsed);
    return (parsed as { data: T } | null)?.data as T;
  },

  async stream(path, onEvent, signal, headers = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: { Accept: 'text/event-stream', ...headers },
      cache: 'no-store',
      signal,
    });
    if (!response.ok || !response.body) throw apiErrorFrom(response, await readJson(response));
    await readEvents(response.body, onEvent);
  },

  channel(path) {
    if (typeof EventSource === 'undefined') return null;
    const source = new EventSource(path);
    return {
      on: (type, listener) =>
        source.addEventListener(type, (message) =>
          listener((message as MessageEvent<string>).data),
        ),
      onError: (listener) => {
        source.onerror = listener;
      },
      close: () => source.close(),
    };
  },
};

let current: Transport = httpTransport;

/** Replaces how the app reaches the backend (tests, another shell). */
export function setTransport(next: Transport) {
  current = next;
}

/** Calls through to the current transport. */
export const transport: Transport = {
  request: (method, path, body) => current.request(method, path, body),
  stream: (path, onEvent, signal, headers) => current.stream(path, onEvent, signal, headers),
  channel: (path) => current.channel(path),
};

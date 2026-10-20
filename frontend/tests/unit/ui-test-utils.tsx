import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ApiError, type Me } from '../../src/api/client';
import { httpTransport, type Method, setTransport } from '../../src/api/transport';
import { ME_KEY } from '../../src/hooks/use-session';

/**
 * Rendering a component against a fake backend: requests go to `routes`
 * ("METHOD /path" → a handler returning the `data`, or throwing an ApiError),
 * and each is recorded in `calls`.
 */
export type Handler = (body: unknown) => unknown;

export interface FakeBackend {
  calls: { method: Method; path: string; body: unknown }[];
  routes: Record<string, Handler>;
}

export function fakeBackend(routes: Record<string, Handler> = {}): FakeBackend {
  const backend: FakeBackend = { calls: [], routes };
  setTransport({
    ...httpTransport,
    channel: () => null,
    async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
      backend.calls.push({ method, path, body });
      const handler = backend.routes[`${method} ${path}`];
      if (!handler) throw new ApiError(404, 'not_found', `No route for ${method} ${path}`);
      return handler(body) as T;
    },
  });
  return backend;
}

export function restoreTransport() {
  setTransport(httpTransport);
}

export interface Rendered {
  container: HTMLElement;
  queryClient: QueryClient;
  root: Root;
  unmount: () => void;
}

/** Renders `ui` with a fresh query client, the local user having `features`. */
export async function renderWithQuery(
  ui: ReactNode,
  { features = {} }: { features?: Me['features'] } = {},
): Promise<Rendered> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData<Me>(ME_KEY, {
    user: { id: 'local', name: 'Ada', email: '', role: 'admin' },
    features,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  });
  return {
    container,
    queryClient,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      document.body.innerHTML = '';
    },
  };
}

/** Lets pending requests and renders finish. */
export async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Types into an input or textarea the way React hears it. */
export async function typeInto(element: Element | null, value: string) {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
    throw new Error('Not a text field');
  const proto =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function click(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) throw new Error('Nothing to click');
  await act(async () => {
    element.click();
  });
  await settle();
}

/** The button (anywhere in the document: dialogs are portalled) whose text is `text`. */
export function buttonByText(text: string | RegExp): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((button) =>
    typeof text === 'string'
      ? button.textContent?.trim() === text
      : text.test(button.textContent ?? ''),
  );
}

/** The labelled control, found through its <label>. */
export function fieldByLabel(text: string | RegExp): HTMLElement | null {
  const label = [...document.querySelectorAll('label')].find((candidate) =>
    typeof text === 'string'
      ? candidate.textContent?.trim().startsWith(text)
      : text.test(candidate.textContent ?? ''),
  );
  const id = label?.htmlFor;
  return id ? document.getElementById(id) : null;
}

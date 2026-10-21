// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import { PerConversationSection } from '../../src/components/models/per-conversation-section';
import {
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const toggle = () => document.querySelector<HTMLElement>('button[role="switch"]');
const me = (modelPerConversation: boolean) => ({
  user: { id: 'local', name: 'Ada', email: '', role: 'admin' },
  features: { modelPerConversation },
});

describe('Settings → Models → Per conversation', () => {
  it('says what it does, and is on as the app says', async () => {
    fakeBackend();
    view = await renderWithQuery(<PerConversationSection />, {
      features: { modelPerConversation: true },
    });
    expect(document.querySelector('h2')?.textContent).toBe('Per conversation');
    expect(document.body.textContent).toContain(
      'Choose the model and thinking for each conversation in the message box',
    );
    expect(document.body.textContent).toContain("Off: every conversation uses its agent's model.");
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    // The switch is named and described by those lines.
    const named = (attribute: string) =>
      document.getElementById(toggle()?.getAttribute(attribute) ?? '')?.textContent;
    expect(named('aria-labelledby')).toContain('Choose the model and thinking');
    expect(named('aria-describedby')).toContain('Off: every conversation');
  });

  it('saves with PUT /api/settings/chat, then reads who you are again', async () => {
    const backend = fakeBackend({
      'PUT /api/settings/chat': () => ({
        modelPerConversation: false,
        thinkingLevels: ['off', 'low', 'medium', 'high'],
      }),
      'GET /api/me': () => me(false),
    });
    view = await renderWithQuery(<PerConversationSection />, {
      features: { modelPerConversation: true },
    });
    await click(toggle());
    await settle();

    expect(backend.calls.filter((call) => call.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/api/settings/chat', body: { modelPerConversation: false } },
    ]);
    expect(backend.calls.some((call) => call.method === 'GET' && call.path === '/api/me')).toBe(
      true,
    );
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');

    // And on again.
    backend.routes['PUT /api/settings/chat'] = () => ({
      modelPerConversation: true,
      thinkingLevels: [],
    });
    backend.routes['GET /api/me'] = () => me(true);
    await click(toggle());
    await settle();
    expect(backend.calls.filter((call) => call.method === 'PUT').at(-1)?.body).toEqual({
      modelPerConversation: true,
    });
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
  });

  it('stays as it was when saving fails', async () => {
    fakeBackend({
      'PUT /api/settings/chat': () => {
        throw new ApiError(500, 'failed', 'The setting could not be saved.');
      },
      'GET /api/me': () => me(true),
    });
    view = await renderWithQuery(<PerConversationSection />, {
      features: { modelPerConversation: true },
    });
    await click(toggle());
    await settle();
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
  });
});

// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fact, YouInfo } from '../../src/api/client';
import { SettingsYouPage } from '../../src/routes/settings/you';
import { agent, fact, you } from './memory-fixtures';
import {
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

let view: Rendered | undefined;
beforeEach(() => {
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const text = () => document.body.textContent ?? '';
const sectionTitled = (title: string) =>
  [...document.querySelectorAll('section')].find(
    (section) => section.querySelector('h2')?.textContent === title,
  );
const suggestionSwitch = () =>
  document.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-labelledby="memory-suggestions-label"]',
  );

function backendWith({ facts = [] as Fact[], info = you() as YouInfo } = {}) {
  const state = { facts, you: info };
  const backend = fakeBackend({
    'GET /api/you': () => state.you,
    'GET /api/you/memories': () => state.facts,
    'GET /api/agents': () => [agent()],
    'GET /api/agents/ag_rex/threads': () => [],
  });
  return { backend, state };
}

describe('Settings → You: suggestions from conversations', () => {
  it('is off until turned on, then says what it does and sends the one switch', async () => {
    const { backend, state } = backendWith({
      info: you({ suggestions: { enabled: false, judged: false } }),
    });
    backend.routes['PUT /api/you/settings'] = (body) => {
      const enabled = (body as { suggestions: boolean }).suggestions;
      state.you = { ...state.you, suggestions: { enabled, judged: false } };
      return state.you.suggestions;
    };
    view = await renderWithQuery(<SettingsYouPage />);
    await settle();
    const section = sectionTitled('Suggestions from conversations')!;
    expect(section.textContent).toContain('quiet for 10 minutes');
    expect(section.textContent).toContain('up to 3 things');
    expect(section.textContent).toContain(
      'Conversations a schedule started, or another agent asked in, are never read',
    );
    expect(section.textContent).toContain('compacted');
    expect(section.textContent).not.toContain('Fast judgments check');
    expect(suggestionSwitch()?.getAttribute('aria-checked')).toBe('false');

    await click(suggestionSwitch());
    expect(backend.calls.filter((call) => call.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/api/you/settings', body: { suggestions: true } },
    ]);
    expect(suggestionSwitch()?.getAttribute('aria-checked')).toBe('true');
  });

  it('is off for a server that has never heard of it', async () => {
    backendWith({ info: you() });
    view = await renderWithQuery(<SettingsYouPage />);
    await settle();
    expect(suggestionSwitch()?.getAttribute('aria-checked')).toBe('false');
  });

  it('says when fast judgments check each suggestion', async () => {
    backendWith({ info: you({ suggestions: { enabled: true, judged: true } }) });
    view = await renderWithQuery(<SettingsYouPage />);
    await settle();
    expect(sectionTitled('Suggestions from conversations')?.textContent).toContain(
      'Fast judgments check each suggestion first',
    );
    expect(suggestionSwitch()?.getAttribute('aria-checked')).toBe('true');
  });

  it('puts the switch back when it could not be saved', async () => {
    const { backend } = backendWith({
      info: you({ suggestions: { enabled: false, judged: false } }),
    });
    backend.routes['PUT /api/you/settings'] = () => {
      throw new Error('boom');
    };
    view = await renderWithQuery(<SettingsYouPage />);
    await settle();
    await click(suggestionSwitch());
    await settle();
    expect(suggestionSwitch()?.getAttribute('aria-checked')).toBe('false');
    expect(toast.error).toHaveBeenCalled();
  });
});

describe('Settings → You: trust labels and history', () => {
  it('labels where each fact came from, known or suggested', async () => {
    backendWith({
      facts: [
        fact({ id: 'um_a', text: 'Prefers metric units', trust: 'said' }),
        fact({ id: 'um_b', text: 'Works in the lab', trust: 'inferred', sourceAgent: 'ag_rex' }),
        fact({
          id: 'um_c',
          text: 'Reads the newsletter',
          trust: 'external',
          sourceAgent: 'ag_rex',
        }),
        fact({
          id: 'um_d',
          status: 'suggested',
          text: 'Likes tea',
          trust: 'inferred',
          sourceAgent: 'ag_rex',
        }),
      ],
    });
    view = await renderWithQuery(<SettingsYouPage />);
    await settle();
    const row = (id: string) => document.querySelector(`[data-fact-id="${id}"]`)?.textContent ?? '';
    expect(row('um_a')).toContain('You said it');
    expect(row('um_b')).toContain('An agent inferred it');
    expect(row('um_c')).toContain('From outside text');
    expect(row('um_d')).toContain('An agent inferred it');
    expect(row('um_a')).not.toContain('An agent inferred it');
  });

  it('shows the last change under a fact, and the earlier ones on request', async () => {
    const at = (day: number) => Date.UTC(2026, 9, day, 12);
    backendWith({
      facts: [
        fact({
          id: 'um_h',
          category: 'projects',
          text: 'Works at Initech',
          history: [
            { text: 'Works at Initech', category: 'work', at: at(21) }, // moved to projects
            { text: 'Works at Acme', category: 'work', at: at(14) }, // reworded
            { text: 'Works somewhere', category: 'work', at: at(2) },
          ],
        }),
        fact({ id: 'um_n', text: 'Prefers short answers' }),
      ],
    });
    view = await renderWithQuery(<SettingsYouPage />);
    await settle();
    const history = document.querySelector('[data-fact-id="um_h"] [data-testid="fact-history"]')!;
    expect(history.querySelector('p')?.textContent).toMatch(/^Moved from Work on Oct 21/);
    expect(history.querySelector('summary')?.textContent).toBe('2 earlier changes');
    const earlier = [...history.querySelectorAll('li')].map((li) => li.textContent);
    expect(earlier[0]).toMatch(/^Changed from “Works at Acme” on Oct 14/);
    expect(earlier[1]).toMatch(/^Changed from “Works somewhere” on Oct 2/);
    // A fact nobody changed shows none.
    expect(document.querySelector('[data-fact-id="um_n"] [data-testid="fact-history"]')).toBeNull();
    expect(text()).not.toContain('undefined');
  });
});

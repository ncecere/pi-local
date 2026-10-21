// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatHomePage } from '../../src/routes/chat/home';
import { agent, basics, you } from './memory-fixtures';
import {
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

let view: Rendered | undefined;
beforeEach(() => localStorage.clear());
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

/** The name the new chat page greets a person by, whose account is named "Ada" (renderWithQuery). */
async function greetedAs(routes: Record<string, () => unknown>) {
  view?.unmount();
  fakeBackend({
    'GET /api/agents': () => [agent()],
    'GET /api/teams': () => [],
    'GET /api/agents/ag_rex/threads': () => [],
    'GET /api/elicitations': () => [],
    'GET /api/approvals?status=pending': () => [],
    ...routes,
  });
  view = await renderWithQuery(<ChatHomePage />);
  await settle();
  // "What should Rex work on, Countess?": the name is the last word, set off by a comma
  // (a space comes from the stylesheet).
  const heading = document.querySelector('h1')?.textContent ?? '';
  return /work on,\s*(.+)\?$/.exec(heading)?.[1] ?? `(no name in: ${heading})`;
}

describe('The new chat greeting', () => {
  it('uses what the person asked to be called', async () => {
    const name = await greetedAs({
      'GET /api/you': () =>
        you({ basics: basics({ name: 'Grace Hopper', addressAs: 'Countess' }) }),
    });
    expect(name).toBe('Countess');
  });

  it('then the first name of the name given in Settings → You', async () => {
    const name = await greetedAs({
      'GET /api/you': () => you({ basics: basics({ name: 'Grace Hopper', addressAs: '  ' }) }),
    });
    expect(name).toBe('Grace');
  });

  it("then the account's name, as before", async () => {
    // Nothing from /api/you (not answered, or nothing written there).
    expect(await greetedAs({})).toBe('Ada');
    expect(
      await greetedAs({
        'GET /api/you': () => you({ basics: basics({ name: '', addressAs: '' }) }),
      }),
    ).toBe('Ada');
  });
});

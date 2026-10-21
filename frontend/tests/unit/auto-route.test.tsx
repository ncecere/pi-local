// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type RouteResult } from '../../src/api/client';
import { routeOptions } from '../../src/components/chat/route-chooser';
import { ChatHomePage } from '../../src/routes/chat/home';
import { agent } from './memory-fixtures';
import {
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
  typeInto,
} from './ui-test-utils';

const navigate = vi.fn(async (_options: unknown) => undefined);
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const REX = agent();
const ADA = agent({ id: 'ag_ada', name: 'Ada', description: 'Plans trips' });
const MAX = agent({ id: 'ag_max', name: 'Max', description: 'Writes code' });

let view: Rendered | undefined;
beforeEach(() => {
  navigate.mockClear();
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const route = (change: Partial<RouteResult>): RouteResult => ({
  agentId: 'ag_ada',
  decided: true,
  confidence: 0.92,
  alternatives: [
    { agentId: 'ag_ada', probability: 0.92 },
    { agentId: 'ag_rex', probability: 0.05 },
    { agentId: 'ag_max', probability: 0.03 },
  ],
  model: 'jev-1.14.0',
  ...change,
});

async function showHome(answer: () => RouteResult, props: { agentId?: string } = {}) {
  const backend = fakeBackend({
    'GET /api/agents': () => [REX, ADA, MAX],
    'GET /api/teams': () => [],
    'POST /api/route': () => answer(),
  });
  view = await renderWithQuery(<ChatHomePage {...props} />, { features: { agentRouting: true } });
  await settle();
  return backend;
}

const picker = () => document.querySelector<HTMLElement>('[role="combobox"][aria-haspopup]');
const handover = () => JSON.parse(sessionStorage.getItem('pai.handover') ?? 'null');
async function send(text: string) {
  await typeInto(document.querySelector('textarea[aria-label="Message input"]'), text);
  await click(document.querySelector('button[aria-label="Send message"]'));
  await settle();
}

describe('Auto in a new chat', () => {
  it('is the default, and sends to the agent fast judgments decided on', async () => {
    const backend = await showHome(() => route({}));
    expect(picker()?.getAttribute('aria-label')).toBe('Select agent. Current: Auto');
    await send('Plan a weekend in Lisbon');
    expect(backend.calls.filter((call) => call.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/route', body: { text: 'Plan a weekend in Lisbon' } },
    ]);
    expect(navigate).toHaveBeenLastCalledWith({
      to: '/agents/$agentId/threads/$threadId',
      params: { agentId: 'ag_ada', threadId: expect.any(String) },
    });
    expect(handover()).toMatchObject({
      agentId: 'ag_ada',
      text: 'Plan a weekend in Lisbon',
      routed: true,
    });
  });

  it('asks which agent when it is not sure, and sends to the one picked', async () => {
    const backend = await showHome(() =>
      route({
        decided: false,
        confidence: 0.4,
        alternatives: [
          { agentId: 'ag_rex', probability: 0.4 },
          { agentId: 'ag_ada', probability: 0.35 },
          { agentId: 'ag_max', probability: 0.25 },
        ],
        agentId: 'ag_rex',
      }),
    );
    await send('Look into this');
    expect(navigate).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: '/agents/$agentId/threads/$threadId' }),
    );
    const chooser = document.querySelector('[data-route-chooser]');
    expect(chooser?.textContent).toContain('Which agent should take this?');
    expect(
      [...(chooser?.querySelectorAll('button[aria-label^="Send to"]') ?? [])].map((b) =>
        b.getAttribute('aria-label'),
      ),
    ).toEqual(['Send to Rex', 'Send to Ada', 'Send to Max']);
    expect(chooser?.textContent).toContain('40%');

    await click(chooser?.querySelector('button[aria-label="Send to Ada"]'));
    expect(navigate).toHaveBeenLastCalledWith({
      to: '/agents/$agentId/threads/$threadId',
      params: { agentId: 'ag_ada', threadId: expect.any(String) },
    });
    expect(handover()).toMatchObject({ agentId: 'ag_ada', text: 'Look into this' });
    // The person picked it: not "(auto)".
    expect(handover().routed).toBeUndefined();
    expect(backend.calls.filter((call) => call.path === '/api/route')).toHaveLength(1);
  });

  it('asks when routing is off (409)', async () => {
    await showHome(() => {
      throw new ApiError(409, 'off', 'Fast judgments are off.');
    });
    await send('Hello');
    const chooser = document.querySelector('[data-route-chooser]');
    expect(chooser?.textContent).toContain("Auto couldn't pick one just now.");
    expect(chooser?.querySelectorAll('button[aria-label^="Send to"]')).toHaveLength(3);
    expect(handover()).toBeNull();
  });

  it("isn't the default when an agent is asked for", async () => {
    const backend = await showHome(() => route({}), { agentId: 'ag_max' });
    expect(picker()?.getAttribute('aria-label')).toBe('Select agent. Current: Max');
    await send('Fix the build');
    expect(backend.calls.some((call) => call.path === '/api/route')).toBe(false);
    expect(handover()).toMatchObject({ agentId: 'ag_max' });
  });
});

describe('routeOptions', () => {
  it('offers the top three, at least two, likeliest first', () => {
    const agents = [REX, ADA, MAX];
    expect(
      routeOptions(agents, {
        agentId: 'ag_max',
        alternatives: [{ agentId: 'ag_max', probability: 0.5 }],
      }).map((option) => option.agent.id),
    ).toEqual(['ag_max', 'ag_rex']);
    expect(routeOptions(agents, null).map((option) => option.probability)).toEqual([
      null,
      null,
      null,
    ]);
  });
});

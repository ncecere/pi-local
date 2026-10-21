// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanAskTab } from '../../src/components/agent-manager/can-ask-tab';
import { agent } from './memory-fixtures';
import { fakeBackend, type Rendered, renderWithQuery, restoreTransport } from './ui-test-utils';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const tools = () =>
  [...document.querySelectorAll('ul[aria-label="Tools for asking other agents"] li')].map(
    (item) => ({ name: item.querySelector('code')?.textContent, does: item.textContent }),
  );

describe('Can ask: the tools', () => {
  it('lists ask_agent and list_agents, each with what it does', async () => {
    fakeBackend();
    const rex = agent({ callable: [{ id: 'ag_ada', name: 'Ada', via: 'direct' }] });
    view = await renderWithQuery(
      <CanAskTab agent={rex} agents={[rex, agent({ id: 'ag_ada', name: 'Ada' })]} />,
    );
    const listed = tools();
    expect(listed.map((tool) => tool.name)).toEqual(['list_agents', 'ask_agent']);
    expect(listed[0]?.does).toContain('Lists the agents it may ask');
    expect(listed[1]?.does).toContain('Sends one of them a message and waits for the reply');
    expect(document.body.textContent).toContain('Rex uses these to ask other agents.');
  });

  it('says they come once it may ask someone', async () => {
    fakeBackend();
    const rex = agent();
    view = await renderWithQuery(<CanAskTab agent={rex} agents={[rex]} />);
    expect(tools()).toHaveLength(2);
    expect(document.body.textContent).toContain('Rex gets these tools once it may ask someone.');
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddServerDialog } from '../../src/components/mcp/server-dialogs';
import { JudgmentsSection } from '../../src/components/models/judgments-section';
import { WebSearchSection } from '../../src/components/models/web-search-section';
import { secretsHome } from '../../src/lib/secrets';
import {
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

const IN_MEMORY = 'kept in memory for this session (development server)';
const IN_KEYCHAIN = 'kept in the system keychain';

describe('where secrets are kept', () => {
  it('names the place', () => {
    expect(secretsHome(true)).toBe('the system keychain');
    expect(secretsHome(false)).toBe('memory for this session (development server)');
  });

  it('says the keychain by default, and while the server has not said otherwise', async () => {
    fakeBackend();
    view = await renderWithQuery(<WebSearchSection />);
    await settle();
    expect(document.body.textContent).toContain(`The key is ${IN_KEYCHAIN}.`);
    view.unmount();
    view = await renderWithQuery(<WebSearchSection />, { features: { secretsInKeychain: true } });
    expect(document.body.textContent).toContain(IN_KEYCHAIN);
  });

  it('says memory when the server keeps secrets in memory', async () => {
    fakeBackend();
    view = await renderWithQuery(<WebSearchSection />, { features: { secretsInKeychain: false } });
    await settle();
    expect(document.body.textContent).toContain(`The key is ${IN_MEMORY}.`);
    expect(document.body.textContent).not.toContain('keychain');
    view.unmount();
    view = await renderWithQuery(<JudgmentsSection />, { features: { secretsInKeychain: false } });
    expect(document.body.textContent).toContain(IN_MEMORY);
    expect(document.body.textContent).not.toContain('keychain');
  });

  it('says so in the MCP server form too', async () => {
    fakeBackend();
    view = await renderWithQuery(<AddServerDialog onClose={() => {}} onSignIn={() => {}} />, {
      features: { secretsInKeychain: false },
    });
    await settle();
    expect(document.body.textContent).toContain(`Values are ${IN_MEMORY}.`);
    expect(document.body.textContent).not.toContain('keychain');
  });
});

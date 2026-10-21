// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import { MessageRow } from '../../src/components/chat/message-row';
import { rememberResultOf } from '../../src/hooks/use-memory';
import {
  click,
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
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
  vi.mocked(toast.error).mockClear();
});

const AGENT = { id: 'ag_rex', enabled: true, running: false };

function reply(
  tool: { name: string; input: Record<string, unknown>; output: string },
  callId = 'call_1',
): UIMessage {
  return {
    id: `reply-${callId}`,
    role: 'assistant',
    parts: [
      {
        type: 'dynamic-tool',
        toolName: tool.name,
        toolCallId: callId,
        state: 'output-available',
        input: tool.input,
        output: { text: tool.output },
      },
      { type: 'text', text: 'Noted.' },
    ] as UIMessage['parts'],
  };
}

async function show(message: UIMessage) {
  view = await renderWithQuery(<MessageRow message={message} streaming={false} agent={AGENT} />);
  await settle();
}

const chip = () => document.querySelector<HTMLElement>('[data-remember]');
const undoButton = () =>
  [...(chip()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Undo');

describe('rememberResultOf', () => {
  it('reads what was saved from the tool result', () => {
    expect(rememberResultOf('Saved (um_ab12, preferences).')).toEqual({
      kind: 'known',
      id: 'um_ab12',
    });
    expect(
      rememberResultOf(
        "Saved as a suggestion for the person to review (um_cd34); it isn't part of what you know until they accept it.",
      ),
    ).toEqual({ kind: 'suggested', id: 'um_cd34' });
    expect(rememberResultOf('Saved to your notes (an_ef56).')).toEqual({
      kind: 'note',
      id: 'an_ef56',
    });
    expect(rememberResultOf('Memory could not be reached. Try again in a moment.')).toBeNull();
    expect(rememberResultOf(null)).toBeNull();
  });
});

describe('The "Remembered" chip', () => {
  it('reads the id and kind from the tool details when given', async () => {
    const message = reply({
      name: 'remember',
      input: { about: 'you', text: 'Has a dog named Rex' },
      output: 'A wording the app does not parse.',
    });
    const part = message.parts[0] as { toolMetadata?: unknown };
    part.toolMetadata = { details: { kind: 'suggested', id: 'um_zz99' } };
    await show(message);
    expect(chip()?.dataset.memoryId).toBe('um_zz99');
    expect(chip()?.textContent).toContain('Suggested: Has a dog named Rex');
  });

  it('shows a known fact instead of the tool row, and Undo deletes it', async () => {
    const backend = fakeBackend({ 'DELETE /api/you/memories/um_ab12': () => ({ ok: true }) });
    await show(
      reply({
        name: 'remember',
        input: { about: 'you', text: 'Prefers short answers', category: 'preferences' },
        output: 'Saved (um_ab12, preferences).',
      }),
    );
    expect(chip()?.textContent).toContain('Remembered: Prefers short answers');
    expect(chip()?.textContent).not.toContain('Review');
    // No work block: the chip is the step.
    expect(document.querySelector('[data-reply-group="work"]')).toBeNull();

    await click(undoButton());
    expect(backend.calls).toEqual([
      { method: 'DELETE', path: '/api/you/memories/um_ab12', body: undefined },
    ]);
    expect(chip()?.textContent).toContain('Forgotten');
    expect(undoButton()).toBeUndefined();
  });

  it("undoes one of the agent's notes through the agent", async () => {
    const backend = fakeBackend({
      'DELETE /api/agents/ag_rex/memory/an_ef56': () => ({ ok: true }),
    });
    await show(
      reply(
        {
          name: 'remember',
          input: { about: 'myself', text: 'The report is due Fridays' },
          output: 'Saved to your notes (an_ef56).',
        },
        'call_2',
      ),
    );
    // A note to self is not something learned about the person.
    expect(chip()?.textContent).toContain('Noted: The report is due Fridays');
    expect(chip()?.textContent).not.toContain('Remembered');
    await click(undoButton());
    expect(backend.calls).toEqual([
      { method: 'DELETE', path: '/api/agents/ag_rex/memory/an_ef56', body: undefined },
    ]);
    expect(chip()?.textContent).toContain('Forgotten');
  });

  it('shows a suggestion with a link to review it', async () => {
    fakeBackend({
      'DELETE /api/you/memories/um_cd34': () => {
        throw new ApiError(500, 'internal', 'The database is locked.');
      },
    });
    await show(
      reply(
        {
          name: 'remember',
          input: { about: 'you', text: 'Has a sister', category: 'family', source: 'inferred' },
          output:
            "Saved as a suggestion for the person to review (um_cd34); it isn't part of what you know until they accept it.",
        },
        'call_3',
      ),
    );
    expect(chip()?.textContent).toContain('Suggested: Has a sister');
    const review = [...(chip()?.querySelectorAll('a') ?? [])].find(
      (a) => a.textContent === 'Review',
    );
    expect(review?.getAttribute('href')).toBe('/settings/you');
    await click(undoButton());
    expect(toast.error).toHaveBeenCalledWith('The database is locked.');
    expect(undoButton()).toBeDefined();
  });

  it('keeps the generic tool row for recall and forget', async () => {
    fakeBackend();
    await show(
      reply(
        {
          name: 'recall',
          input: { query: 'tea' },
          output: 'About the person:\n- (um_ab12, preferences) Likes tea',
        },
        'call_4',
      ),
    );
    expect(chip()).toBeNull();
    expect(document.querySelector('[data-reply-group="work"]')).not.toBeNull();
  });
});

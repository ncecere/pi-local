// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Author, ChatView } from '../../src/api/client';
import { MessageRow } from '../../src/components/chat/message-row';
import { viewToMessages } from '../../src/lib/chat-view';
import { agent } from './memory-fixtures';
import {
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

/**
 * What a person's message looks like in the transcript: its files as chips
 * under the text (also for a message sent before v0.2, whose text holds the
 * list), and who wrote it when it wasn't the person.
 */
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

let view: Rendered | undefined;
const writeText = vi.fn(async (_text: string) => undefined);
beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const REPORT = {
  path: 'attachments/2026-10-20/report.pdf',
  name: 'report.pdf',
  size: 120 * 1024,
  mediaType: 'application/pdf',
};
const SHOT = {
  path: 'attachments/2026-10-20/shot.png',
  name: 'shot.png',
  size: 2048,
  mediaType: 'image/png',
};

const transcript = (...messages: ChatView['messages']): ChatView => ({
  busy: false,
  tools: [],
  messages,
});

async function show(chat: ChatView) {
  fakeBackend({ 'GET /api/agents': () => [agent({ id: 'ag_ada', name: 'Ada' })] });
  const rows = viewToMessages(chat).filter((message) => message.role === 'user');
  view = await renderWithQuery(
    <div>
      {rows.map((message) => (
        <MessageRow
          key={message.id}
          message={message}
          streaming={false}
          onEdit={async () => null}
        />
      ))}
    </div>,
  );
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await settle();
}

const chips = () =>
  [...document.querySelectorAll('[data-message-attachment]')].map((chip) => ({
    text: chip.textContent,
    kind: chip.querySelector('[data-kind]')?.getAttribute('data-kind'),
    title: chip.getAttribute('title'),
  }));

describe('files on a message (v0.2)', () => {
  it('shows each as a chip under the text: icon, name and size', async () => {
    await show(
      transcript({
        id: 'u1',
        role: 'user',
        text: 'Summarise these',
        attachments: [REPORT, SHOT],
      }),
    );
    const bubble = document.querySelector('[data-message-role="user"]');
    expect(bubble?.textContent).toContain('Summarise these');
    expect(chips()).toEqual([
      { text: 'report.pdf120 KB', kind: 'pdf', title: REPORT.path },
      { text: 'shot.png2 KB', kind: 'image', title: SHOT.path },
    ]);
    // The chips come after the words.
    const text = bubble?.textContent ?? '';
    expect(text.indexOf('Summarise these')).toBeLessThan(text.indexOf('report.pdf'));
    expect(text).not.toContain('Attached files');
    expect(document.querySelector('[aria-label="Your message"]')).not.toBeNull();
  });

  it('is only chips when the files were sent without words', async () => {
    await show(transcript({ id: 'u1', role: 'user', text: '', attachments: [REPORT] }));
    expect(chips()).toHaveLength(1);
    expect(document.querySelector('[data-message-role="user"] p')).toBeNull();
    // Nothing to copy or edit: there are no words.
    expect(document.querySelector('button[aria-label^="Copy message"]')).toBeNull();
    expect(document.querySelector('button[aria-label^="Edit message"]')).toBeNull();
  });
});

describe('a message sent before v0.2 (its text holds the list)', () => {
  const OLD = [
    'Please read these',
    '',
    'Attached files (in your workspace):',
    '- attachments/2026-10-20/report.pdf (120 KB)',
    '- attachments/2026-10-20/data.csv (3 KB)',
  ].join('\n');

  it('shows the files as chips and only the words as text', async () => {
    await show(transcript({ id: 'u1', role: 'user', text: OLD }));
    expect(chips().map((chip) => [chip.text, chip.kind])).toEqual([
      ['report.pdf120 KB', 'pdf'],
      ['data.csv3 KB', 'sheet'],
    ]);
    const words = document.querySelector('[data-message-role="user"] p')?.textContent;
    expect(words).toBe('Please read these');
    expect(document.body.textContent).not.toContain('Attached files (in your workspace)');
  });

  it('copies the words without the list', async () => {
    await show(transcript({ id: 'u1', role: 'user', text: OLD }));
    document.querySelector<HTMLButtonElement>('button[aria-label^="Copy message"]')?.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith('Please read these');
  });

  it('shows no words for a message that was only the list', async () => {
    await show(
      transcript({
        id: 'u1',
        role: 'user',
        text: 'Attached files (in your workspace):\n- attachments/2026-10-20/a.docx (10 KB)',
      }),
    );
    expect(chips().map((chip) => chip.kind)).toEqual(['doc']);
    expect(document.querySelector('[data-message-role="user"] p')).toBeNull();
  });
});

describe('who wrote a message', () => {
  const author = (change: Partial<Author>): Author => ({
    kind: 'agent',
    id: 'ag_ada',
    name: 'Ada',
    ...change,
  });
  const authored = (who: Author | undefined) =>
    transcript({ id: 'u1', role: 'user', text: 'Can you check the budget?', author: who });

  it('shows another agent’s question with its name and avatar, not as the person’s', async () => {
    await show(authored(author({})));
    const row = document.querySelector('[data-message-role="user"]');
    expect(row?.getAttribute('aria-label')).toBe('Message from Ada');
    expect(row?.getAttribute('data-author-kind')).toBe('agent');
    expect(row?.textContent).toContain('Ada');
    expect(row?.textContent).toContain('Agent');
    expect(row?.textContent).toContain('Can you check the budget?');
    expect(document.querySelector('[aria-label="Your message"]')).toBeNull();
    // Its own avatar (the agent's drawing, not the stand-in icon), beside the name.
    expect(row?.querySelector('svg')).not.toBeNull();
    expect(row?.querySelector('.lucide-bot')).toBeNull();
    // An edit would be the person's: not offered.
    expect(document.querySelector('button[aria-label^="Edit message"]')).toBeNull();
    // It sits on the left, like a reply.
    expect(row?.className).toContain('gap-3');
    expect(row?.className).not.toContain('items-end');
  });

  it('names a schedule or a service as itself', async () => {
    await show(authored(author({ kind: 'trigger', id: 'sch_1', name: 'Morning briefing' })));
    const row = document.querySelector('[data-message-role="user"]');
    expect(row?.getAttribute('aria-label')).toBe('Message from Morning briefing');
    expect(row?.textContent).toContain('Schedule');
    view?.unmount();
    await show(authored(author({ kind: 'service_account', id: 'svc', name: 'Deploy bot' })));
    expect(document.querySelector('[data-message-role="user"]')?.textContent).toContain(
      'Deploy bot',
    );
  });

  it('copes with an agent that is no longer there', async () => {
    await show(authored(author({ id: 'ag_gone', name: 'Old helper' })));
    const row = document.querySelector('[data-message-role="user"]');
    expect(row?.getAttribute('aria-label')).toBe('Message from Old helper');
    expect(row?.querySelector('.lucide-bot')).not.toBeNull();
  });

  it('keeps a person’s own message as theirs, with or without an author line', async () => {
    await show(authored(author({ kind: 'user', id: 'local', name: 'Ada Lovelace' })));
    expect(document.querySelector('[aria-label="Your message"]')).not.toBeNull();
    view?.unmount();
    await show(authored(undefined));
    expect(document.querySelector('[aria-label="Your message"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label^="Edit message"]')).not.toBeNull();
  });
});

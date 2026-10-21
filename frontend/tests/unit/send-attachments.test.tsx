// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import { ChatHomePage } from '../../src/routes/chat/home';
import { ChatThreadPage } from '../../src/routes/chat/thread';
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
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

/** An agent that can open files (it has the read tool). */
const REX = agent({ workspace: { tools: ['read'], folder: '', dir: '/data/agents/ag_rex/ws' } });
const MESSAGES = '/api/agents/ag_rex/threads/t1/messages';
const PASTED = 'Pasted image 2026-10-21 at 14.03.22.png';
const UPLOAD = (name: string) => `/api/agents/ag_rex/attachments?name=${encodeURIComponent(name)}`;

const saved = (name: string, size = 4) => ({
  path: `attachments/2026-10-21/${name}`,
  name,
  size,
  mediaType: name.endsWith('.png') ? 'image/png' : 'application/pdf',
});

const emptyTranscript = async (
  _path: string,
  onEvent: (event: { event: string; data: string }) => void,
  signal: AbortSignal,
) => {
  onEvent({ event: 'view', data: JSON.stringify({ busy: false, messages: [], tools: [] }) });
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
};

const createObjectURL = vi.fn(
  (_file: unknown) => `blob:thumb-${createObjectURL.mock.calls.length}`,
);
const revokeObjectURL = vi.fn((_url: string) => undefined);

let view: Rendered | undefined;
beforeEach(() => {
  navigate.mockClear();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  sessionStorage.clear();
  localStorage.clear();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 21, 14, 3, 22));
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
  vi.useRealTimers();
});

const baseRoutes = {
  'GET /api/agents': () => [REX],
  'GET /api/teams': () => [],
  'GET /api/agents/catalog': () => ({
    templates: [],
    models: [],
    defaultModelId: null,
    allowModelChoice: true,
    limit: 1000,
    used: 1,
  }),
  'GET /api/agents/ag_rex/threads': () => [],
  'GET /api/elicitations': () => [],
  'GET /api/approvals?status=pending': () => [],
  [`POST ${MESSAGES}`]: () => ({ submissionId: 's1' }),
};

async function showThread(extra: Record<string, (body: unknown) => unknown> = {}) {
  const backend = fakeBackend({ ...baseRoutes, ...extra }, emptyTranscript);
  view = await renderWithQuery(<ChatThreadPage agentId="ag_rex" threadId="t1" />);
  await settle();
  return backend;
}

const field = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message input"]');
const sendButton = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
const tray = () => document.querySelector('ul[aria-label="Files to send"]');

/** A paste into the message box, carrying files the way the clipboard does. */
async function paste(files: File[], text = '') {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      files,
      getData: () => text,
      types: [],
    },
  });
  await act(async () => {
    field()?.dispatchEvent(event);
  });
  await settle();
  return event;
}

const screenshot = () => new File(['png!'], 'image.png', { type: 'image/png' });

describe('pasting into the message box', () => {
  it('attaches a screenshot, named for the moment it was taken, with a thumbnail', async () => {
    const backend = await showThread({ [`POST ${UPLOAD(PASTED)}`]: () => saved(PASTED) });
    const event = await paste([screenshot()]);
    expect(event.defaultPrevented).toBe(true);
    // Uploaded under the friendly name.
    expect(backend.calls.filter((call) => call.path.includes('/attachments'))).toEqual([
      { method: 'POST', path: UPLOAD(PASTED), body: 'png!' },
    ]);
    const chip = tray()?.querySelector('li');
    expect(chip?.textContent).toContain(PASTED);
    expect(chip?.textContent).toContain('4 B');
    // A small picture from an object URL, not a file icon.
    expect(chip?.querySelector('img')?.getAttribute('src')).toBe('blob:thumb-1');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    // Ready: Send is on with no text.
    expect(sendButton()?.disabled).toBe(false);
  });

  it('keeps two screenshots from the same second apart', async () => {
    await showThread({
      [`POST ${UPLOAD(PASTED)}`]: () => saved(PASTED),
      [`POST ${UPLOAD('Pasted image 2026-10-21 at 14.03.22 (2).png')}`]: () =>
        saved('Pasted image 2026-10-21 at 14.03.22 (2).png'),
    });
    await paste([screenshot()]);
    await paste([screenshot()]);
    const names = [...(tray()?.querySelectorAll('li') ?? [])].map((chip) => chip.textContent);
    expect(names[0]).toContain(PASTED);
    expect(names[1]).toContain('Pasted image 2026-10-21 at 14.03.22 (2).png');
  });

  it('leaves a paste of cells or a page to the text box', async () => {
    await showThread();
    const event = await paste([screenshot()], 'a1\tb1');
    expect(event.defaultPrevented).toBe(false);
    expect(tray()).toBeNull();
  });

  it('lets go of a thumbnail when its chip is removed, and of the rest when the page closes', async () => {
    await showThread({
      [`POST ${UPLOAD(PASTED)}`]: () => saved(PASTED),
      [`POST ${UPLOAD('Pasted image 2026-10-21 at 14.03.22 (2).png')}`]: () =>
        saved('Pasted image 2026-10-21 at 14.03.22 (2).png'),
    });
    await paste([screenshot()]);
    await paste([screenshot()]);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    await click(document.querySelector(`button[aria-label="Remove ${PASTED}"]`));
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:thumb-1');
    view?.unmount();
    view = undefined;
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:thumb-2');
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});

describe('sending files', () => {
  it('sends them as `attachments`, with no block in the text, and sends with no words at all', async () => {
    const file = saved(PASTED);
    const backend = await showThread({ [`POST ${UPLOAD(PASTED)}`]: () => file });
    await paste([screenshot()]);
    await click(sendButton());
    const sent = backend.calls.find((call) => call.path === MESSAGES);
    expect(sent?.body).toMatchObject({ text: '', attachments: [file] });
    expect(JSON.stringify(sent?.body)).not.toContain('Attached files');
    // The message shows at once with its file as a chip; the tray is empty again.
    expect(document.querySelector('[data-message-attachment]')?.textContent).toContain(PASTED);
    expect(tray()).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:thumb-1');
  });

  it('sends the words as typed beside the files', async () => {
    const file = saved('Q3.pdf', 120 * 1024);
    const backend = await showThread({ [`POST ${UPLOAD('Q3.pdf')}`]: () => file });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    const pdf = new File(['%PDF'], 'Q3.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [pdf], configurable: true });
    await act(async () => {
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    await typeInto(field(), '  Summarise this  ');
    await click(sendButton());
    const sent = backend.calls.find((call) => call.path === MESSAGES);
    expect(sent?.body).toMatchObject({ text: 'Summarise this', attachments: [file] });
    expect(JSON.stringify(sent?.body)).not.toContain('Attached files');
    expect(sent?.body).not.toMatchObject({ text: expect.stringContaining('Q3.pdf') });
  });

  it('sends nothing for a file that did not upload, and says why', async () => {
    const backend = await showThread({
      [`POST ${UPLOAD(PASTED)}`]: () => {
        throw new ApiError(500, 'internal', 'The disk is full.');
      },
    });
    await paste([screenshot()]);
    const chip = tray()?.querySelector('li');
    expect(chip?.getAttribute('data-attachment')).toBe('error');
    expect(chip?.textContent).toContain('The disk is full.');
    // Nothing to send, and the chip can go.
    expect(sendButton()?.disabled).toBe(true);
    await click(document.querySelector(`button[aria-label="Remove ${PASTED}"]`));
    expect(tray()).toBeNull();
    expect(backend.calls.some((call) => call.path === MESSAGES)).toBe(false);
  });

  it('hands the files to a new conversation with the first message', async () => {
    const file = saved(PASTED);
    fakeBackend({
      'GET /api/agents': () => [REX],
      'GET /api/teams': () => [],
      [`POST ${UPLOAD(PASTED)}`]: () => file,
    });
    view = await renderWithQuery(<ChatHomePage agentId="ag_rex" />);
    await settle();
    await paste([screenshot()]);
    await click(sendButton());
    expect(navigate).toHaveBeenCalledTimes(1);
    const handover = JSON.parse(sessionStorage.getItem('pai.handover') ?? 'null');
    expect(handover).toMatchObject({ agentId: 'ag_rex', text: '', attachments: [file] });
  });
});

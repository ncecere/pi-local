// @vitest-environment happy-dom
import { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../src/components/chat/composer';
import type { SlashCommand } from '../../src/lib/slash-commands';
import { type Rendered, renderWithQuery, settle, typeInto } from './ui-test-utils';

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const run = vi.fn();
const submit = vi.fn();
const commands: SlashCommand[] = [
  { id: 'cmd:new', name: 'new', title: 'New conversation', group: 'command', run },
  { id: 'cmd:model', name: 'model', title: 'Choose the model', group: 'command', run: vi.fn() },
  {
    id: 'cmd:remember',
    name: 'remember',
    title: 'Remember something',
    group: 'command',
    text: 'Remember that ',
  },
  {
    id: 'prompt:summarize',
    name: 'summarize',
    title: 'Summarize a document',
    description: 'with the decisions',
    group: 'prompt',
    text: 'Summarize {{document}} for {{audience}}.\nList the decisions.',
    fields: ['document', 'audience'],
  },
  {
    id: 'prompt:plain',
    name: 'plain',
    title: 'A plain prompt',
    group: 'prompt',
    text: 'Just this text.',
    fields: [],
  },
];

function Harness({ list = commands, initial = '' }: { list?: SlashCommand[]; initial?: string }) {
  const [value, setValue] = useState(initial);
  return <Composer value={value} onChange={setValue} onSubmit={submit} commands={list} />;
}

async function mount(props: Parameters<typeof Harness>[0] = {}) {
  run.mockClear();
  submit.mockClear();
  view = await renderWithQuery(<Harness {...props} />);
}

const box = () => document.querySelector('textarea') as HTMLTextAreaElement;
const menu = () => document.querySelector('[role="listbox"]');
const options = () => [...document.querySelectorAll('[role="option"]')];
const names = () => options().map((o) => o.querySelector('span')?.textContent);

async function press(key: string, init: KeyboardEventInit = {}, target: Element = box()) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

describe('the slash menu', () => {
  it('opens on a slash at the start and lists the commands and prompts', async () => {
    await mount();
    expect(menu()).toBeNull();
    await typeInto(box(), '/');
    expect(menu()).not.toBeNull();
    expect(names()).toEqual(['/new', '/model', '/remember', '/summarize', '/plain']);
    // A native multiline textbox points at the list, with the first row active.
    // `combobox` is not an allowed role for a textarea.
    expect(box().getAttribute('role')).toBeNull();
    expect(box().getAttribute('aria-autocomplete')).toBe('list');
    expect(box().getAttribute('aria-controls')).toBe(menu()?.id);
    expect(box().getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
    // A prompt with blanks says how many.
    expect(options()[3]?.textContent).toContain('2 fields');
    expect(options()[3]?.textContent).toContain('with the decisions');
  });

  it('filters as you type, and closes when nothing matches or a space follows', async () => {
    await mount();
    await typeInto(box(), '/re');
    expect(names()).toEqual(['/remember']);
    await typeInto(box(), '/zzz');
    expect(menu()).toBeNull();
    expect(box().getAttribute('aria-controls')).toBeNull();
    expect(box().getAttribute('aria-activedescendant')).toBeNull();
    await typeInto(box(), '/remember ');
    expect(menu()).toBeNull();
    await typeInto(box(), 'say /new');
    expect(menu()).toBeNull();
  });

  it('moves with the arrow keys, wrapping around, and Enter chooses without sending', async () => {
    await mount();
    await typeInto(box(), '/');
    await press('ArrowDown');
    expect(options()[1]?.getAttribute('aria-selected')).toBe('true');
    await press('ArrowUp');
    await press('ArrowUp');
    expect(options()[4]?.getAttribute('aria-selected')).toBe('true');
    await press('ArrowDown');
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
    await press('ArrowDown');
    await press('ArrowDown');
    await press('Enter');
    // /remember fills the box and puts the cursor at its end.
    expect(box().value).toBe('Remember that ');
    expect(box().selectionStart).toBe('Remember that '.length);
    expect(submit).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });

  it('chooses with Tab and with a click, and runs a command after clearing the box', async () => {
    await mount();
    await typeInto(box(), '/ne');
    await press('Tab');
    expect(run).toHaveBeenCalledTimes(1);
    expect(box().value).toBe('');
    await typeInto(box(), '/plain');
    await act(async () => {
      (options()[0] as HTMLElement).click();
    });
    expect(box().value).toBe('Just this text.');
  });

  it('closes on Escape until the text changes, and then Enter sends the slash text as it is', async () => {
    await mount();
    await typeInto(box(), '/new');
    await press('Escape');
    expect(menu()).toBeNull();
    expect(box().value).toBe('/new');
    await press('Enter');
    expect(submit).toHaveBeenCalledTimes(1);
    await typeInto(box(), '/ne');
    expect(menu()).not.toBeNull();
    await typeInto(box(), '/new');
    expect(menu()).not.toBeNull();
    await press('Escape');
    await typeInto(box(), '');
    await typeInto(box(), '/new');
    expect(menu()).not.toBeNull();
  });

  it('lets Shift+Enter and Cmd+Enter through, and ignores Enter that confirms an input method', async () => {
    await mount();
    await typeInto(box(), '/new');
    await press('Enter', { isComposing: true });
    expect(run).not.toHaveBeenCalled();
    await press('Enter', { shiftKey: true });
    expect(run).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it('is not there without commands, and a message that merely starts with a slash is sent with Enter', async () => {
    await mount({ list: [] });
    await typeInto(box(), '/');
    expect(menu()).toBeNull();
    await press('Enter');
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('a prompt with blanks', () => {
  async function open() {
    await mount();
    await typeInto(box(), '/summ');
    await press('Enter');
    await settle();
  }
  const form = () =>
    document.querySelector(
      'form[aria-label="Fill in Summarize a document"]',
    ) as HTMLFormElement | null;
  const inputs = () => [...(form()?.querySelectorAll('input') ?? [])] as HTMLInputElement[];

  it('asks for each blank in a form, focused on the first, with the box cleared', async () => {
    await open();
    expect(box().value).toBe('');
    expect(menu()).toBeNull();
    expect(
      inputs().map(
        (i) => form()?.querySelector(`label:has(input[name="${i.name}"]) span`)?.textContent,
      ),
    ).toEqual(['document', 'audience']);
    expect(document.activeElement).toBe(inputs()[0]);
  });

  it('moves to the next blank on Enter, and Enter in the last puts the finished text in the box', async () => {
    await open();
    await typeInto(inputs()[0]!, 'the Q3 report');
    await press('Enter', {}, inputs()[0]!);
    expect(document.activeElement).toBe(inputs()[1]);
    await typeInto(inputs()[1]!, 'the board');
    await press('Enter', {}, inputs()[1]!);
    await settle();
    expect(form()).toBeNull();
    expect(box().value).toBe('Summarize the Q3 report for the board.\nList the decisions.');
    expect(document.activeElement).toBe(box());
    expect(box().selectionStart).toBe(box().value.length);
    expect(submit).not.toHaveBeenCalled();
  });

  it('leaves a blank that was not filled as {{name}} for the person to fill in the box', async () => {
    await open();
    await typeInto(inputs()[0]!, 'the Q3 report');
    await act(async () => {
      form()?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(box().value).toBe('Summarize the Q3 report for {{audience}}.\nList the decisions.');
  });

  it('is dropped with Escape or Cancel, leaving the box empty and focused', async () => {
    await open();
    await press('Escape', {}, inputs()[0]!);
    expect(form()).toBeNull();
    expect(box().value).toBe('');
    expect(document.activeElement).toBe(box());

    await typeInto(box(), '/summ');
    await press('Enter');
    await settle();
    const cancel = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');
    await act(async () => cancel?.click());
    expect(form()).toBeNull();
  });
});

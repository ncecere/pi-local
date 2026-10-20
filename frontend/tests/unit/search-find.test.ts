import { describe, expect, it } from 'vitest';
import { searchable, searchQueryOf } from '../../src/hooks/use-message-search';
import {
  findSnippetMessage,
  foldText,
  matchedTermsOf,
  snippetCoreOf,
} from '../../src/lib/search-find';

const wire = (s: string) => s.replaceAll('[', '\u0001').replaceAll(']', '\u0002');

describe('a search query', () => {
  it('needs a word of two letters or more (the API matches nothing shorter)', () => {
    expect(searchable('ab')).toBe(true);
    expect(searchable('a b')).toBe(false);
    expect(searchable(' é9 ')).toBe(true);
    expect(searchable('')).toBe(false);
  });

  it('is sent trimmed, at most 200 characters', () => {
    expect(searchQueryOf('  desk  ')).toBe('desk');
    expect(searchQueryOf('x'.repeat(300))).toHaveLength(200);
  });
});

describe('finding the message a snippet came from', () => {
  const messages = [
    { id: 'u1', text: 'Can I expense a standing desk?' },
    { id: 'r1', text: 'Yes: a **standing desk** counts as equipment.' },
    { id: 'u2', text: 'And a chair?' },
    { id: 'r2', text: 'Desks and chairs, both. Standing ones too.' },
  ];

  it('reads the matched words and the text around them, accents and case aside', () => {
    expect(matchedTermsOf(wire('Can I [Éxpense] a [desk] and a [desk]?'))).toEqual([
      'expense',
      'desk',
    ]);
    expect(snippetCoreOf(wire('… a [standing]  desk counts …'))).toBe('a standing desk counts');
    expect(foldText('  Café\nCrème ')).toBe('cafe creme');
  });

  it('prefers the message holding the snippet text', () => {
    expect(findSnippetMessage(messages, wire('Can I expense a [standing] [desk]?'))).toBe('u1');
  });

  it('else takes the newest holding every matched word at a word start', () => {
    expect(findSnippetMessage(messages, wire('… [stand] … [desk] …'))).toBe('r2');
    expect(findSnippetMessage(messages, wire('[chair]'))).toBe('r2');
    expect(findSnippetMessage(messages, wire('[tanding]'))).toBeNull();
    expect(findSnippetMessage(messages, '')).toBeNull();
  });
});

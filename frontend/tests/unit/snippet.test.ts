import { describe, expect, it } from 'vitest';
import { splitSnippet } from '../../src/lib/snippet';

const wire = (s: string) => s.replaceAll('[', '\u0001').replaceAll(']', '\u0002');

describe('splitSnippet', () => {
  it('separates the matched words from the text around them, in order', () => {
    expect(
      splitSnippet(wire('Can I [expense] a standing [desk]?')).map((p) => [p.text, p.match]),
    ).toEqual([
      ['Can I ', false],
      ['expense', true],
      [' a standing ', false],
      ['desk', true],
      ['?', false],
    ]);
  });

  it('is one plain piece when nothing matched, and nothing for nothing', () => {
    expect(splitSnippet('just text').map((p) => [p.text, p.match])).toEqual([['just text', false]]);
    expect(splitSnippet('')).toEqual([]);
  });

  it('gives each piece its own key, and copes with a match at either end and a stray marker', () => {
    const parts = splitSnippet(wire('[start] middle [end]'));
    expect(parts.map((p) => p.text)).toEqual(['start', ' middle ', 'end']);
    expect(new Set(parts.map((p) => p.at)).size).toBe(3);
    expect(() => splitSnippet(wire('open [never closed'))).not.toThrow();
    expect(
      splitSnippet(wire('open [never closed'))
        .map((p) => p.text)
        .join(''),
    ).toBe('open never closed');
  });

  it('never makes a tag of what it is given: the text stays text', () => {
    expect(splitSnippet('<img src=x onerror=alert(1)>')[0]?.text).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });
});

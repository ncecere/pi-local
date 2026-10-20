/**
 * A search result's line from a message, the server's markers around the words that matched
 * (server/search.ts: U+0001 before, U+0002 after), as pieces to draw: plain text and matches.
 */
const START = String.fromCharCode(1);
const END = String.fromCharCode(2);

export interface SnippetPart {
  /** Where the piece starts in the line: a stable key. */
  at: number;
  text: string;
  match: boolean;
}

export function splitSnippet(line: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let at = 0;
  let matching = false;
  let current = '';
  let started = 0;
  const push = () => {
    if (current) parts.push({ at: started, text: current, match: matching });
    current = '';
  };
  for (const char of line) {
    if (char === START || char === END) {
      push();
      matching = char === START;
      started = at + 1;
    } else {
      if (!current) started = at;
      current += char;
    }
    at += char.length;
  }
  push();
  return parts;
}

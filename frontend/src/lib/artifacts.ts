export type ArtifactVersion = {
  title: string;
  type: 'markdown' | 'code' | 'html' | 'csv';
  language?: string;
  content: string;
  revision: number;
  updatedAt: number;
};
export type Artifact = ArtifactVersion & { id: string; versions: ArtifactVersion[] };

export function artifactList(value: unknown): Artifact[] {
  if (
    !value ||
    typeof value !== 'object' ||
    !('artifacts' in value) ||
    !Array.isArray(value.artifacts)
  )
    return [];
  return value.artifacts.filter(
    (a): a is Artifact =>
      !!a &&
      typeof a === 'object' &&
      typeof a.id === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/.test(a.id) &&
      typeof a.title === 'string' &&
      typeof a.content === 'string' &&
      ['markdown', 'code', 'html', 'csv'].includes(a.type) &&
      Number.isSafeInteger(a.revision) &&
      Array.isArray(a.versions),
  );
}

/** CSV is text, never HTML or formulas. Handles quoted commas, CRLF, escaped quotes and newlines. */
export function csvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    recordStarted = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    // Quotes can start a record without adding decoded characters (the CSV record "").
    recordStarted = true;
    if (ch === '"') {
      if (quoted && content[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((ch === '\r' || ch === '\n') && !quoted) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      recordStarted = false;
      if (ch === '\r' && content[i + 1] === '\n') i++;
    } else cell += ch;
  }
  if (recordStarted) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export const ARTIFACT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const HTML_TAGS = new Set(
  'div span p h1 h2 h3 h4 h5 h6 br hr strong em b i u s small sub sup pre code blockquote ul ol li table caption thead tbody tfoot tr th td colgroup col style section article header footer main aside dl dt dd'.split(
    ' ',
  ),
);

/** Inert template parse + a tiny passive HTML allowlist, then sandbox + CSP in the preview.
 * No links, forms, refresh, base, frames, SVG, scripts, handlers or URL-bearing attributes survive.
 */
export function artifactHtml(content: string): string {
  const template = document.createElement('template');
  template.innerHTML = content;
  const clean = (parent: ParentNode) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.COMMENT_NODE) {
        node.remove();
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as Element;
      if (!HTML_TAGS.has(el.localName) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
        el.replaceWith(document.createTextNode(el.textContent ?? ''));
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        if (!['style', 'class', 'title', 'colspan', 'rowspan'].includes(attr.name))
          el.removeAttribute(attr.name);
      }
      clean(el);
    }
  };
  clean(template.content);
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta name="referrer" content="no-referrer"></head><body>${template.innerHTML}</body></html>`;
}

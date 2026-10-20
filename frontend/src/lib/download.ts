/**
 * Saving a file the API answered with (an agent's export): the name it
 * suggests in Content-Disposition, and a download through a Blob URL.
 */

/** Strips what a file name can't hold: folders, control characters. */
function safeName(name: string): string | null {
  const base = name
    .split(/[/\\]/)
    .at(-1)!
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return base && base !== '.' && base !== '..' ? base : null;
}

/**
 * The file name a Content-Disposition header suggests (RFC 6266), or null.
 * `filename*` (RFC 5987, percent-encoded UTF-8) wins over `filename`; a
 * quoted value may hold `\"`, `;` and spaces; folders are dropped.
 */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const params = new Map<string, string>();
  // name=value pairs, the value a quoted string or a token.
  const pattern = /;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+\*?)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  for (const match of `;${header.replace(/^[^;]*/, '')}`.matchAll(pattern)) {
    const key = match[1]!.toLowerCase();
    let value = match[2]!.trim();
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    if (!params.has(key)) params.set(key, value);
  }
  const extended = params.get('filename*');
  if (extended) {
    const parts = /^([\w!#$%&+^`{}~-]*)'[^']*'(.*)$/.exec(extended);
    if (parts) {
      try {
        const charset = parts[1]!.toLowerCase();
        const decoded =
          charset === 'iso-8859-1'
            ? parts[2]!.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
              )
            : decodeURIComponent(parts[2]!);
        const name = safeName(decoded);
        if (name) return name;
      } catch {
        // Malformed: fall back to `filename`.
      }
    }
  }
  const plain = params.get('filename');
  return plain ? safeName(plain) : null;
}

/** Starts a download of `blob` as `filename` (through a short-lived Blob URL). */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  // Long enough for the download to start reading it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

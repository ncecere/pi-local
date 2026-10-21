import type { Agent, Attachment } from '~/api/types';

/**
 * Files attached in the composer (docs/api.md, "Attachments"): each is saved
 * in the agent's workspace, and the message carries them as `attachments`
 * (the upload's answers) beside its text, so the agent can open them with its
 * `read` tool. Pure.
 */

/** The most one file may be: 100 MiB. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export const ATTACHMENTS_HEADING = 'Attached files (in your workspace):';

/** "512 B", "120 KB", "4.2 MB": a size as the message and the chips say it (1 KB = 1024 B). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unit]}`;
}

/** The line before the files in a message sent before v0.2 (the model still reads the same block). */
const LEGACY_LINE = /^- (.+) \(([^()]*)\)$/;

/** "120 KB", "4.2 MB", "512 B" back to bytes (what formatBytes wrote); 0 when it isn't one. */
export function parseSize(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i.exec(text.trim());
  if (!match) return 0;
  const power = ['B', 'KB', 'MB', 'GB'].indexOf(match[2]!.toUpperCase());
  return Math.round(Number(match[1]) * 1024 ** power);
}

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
};

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * The files a message sent before v0.2 names in its text, and the text
 * without them. The block is the last thing in the text: the line
 * `Attached files (in your workspace):`, then one `- <path> (<size>)` line per
 * file. Text that only looks like it (more text after, or lines that aren't
 * file lines) is left as it is. Pure.
 */
export function splitAttachmentBlock(text: string): { text: string; attachments: Attachment[] } {
  const lines = text.split('\n');
  const at = lines.findLastIndex((line) => line.trim() === ATTACHMENTS_HEADING);
  if (at < 0) return { text, attachments: [] };
  const attachments: Attachment[] = [];
  for (const line of lines.slice(at + 1)) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const match = LEGACY_LINE.exec(trimmed);
    if (!match) return { text, attachments: [] };
    const path = match[1]!;
    const name = baseName(path);
    attachments.push({
      path,
      name,
      size: parseSize(match[2]!),
      mediaType: MEDIA_TYPES[extensionOf(name)] ?? 'application/octet-stream',
    });
  }
  if (attachments.length === 0) return { text, attachments: [] };
  return { text: lines.slice(0, at).join('\n').trimEnd(), attachments };
}

/** The text without a trailing "Attached files" block: what a copy of the message holds. */
export const stripAttachmentBlock = (text: string): string => splitAttachmentBlock(text).text;

/** The kinds of file a chip has an icon for. */
export type FileKind = 'image' | 'pdf' | 'doc' | 'sheet' | 'slides' | 'file';

/** What kind of file it is, from its media type and then its name's extension. */
export function fileKindOf(file: { name: string; mediaType?: string | null }): FileKind {
  const type = (file.mediaType ?? '').toLowerCase();
  const extension = extensionOf(file.name);
  if (type.startsWith('image/') || /^(png|jpe?g|gif|webp|bmp|svg|heic)$/.test(extension))
    return 'image';
  if (type === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (
    type.includes('wordprocessingml') ||
    type === 'application/msword' ||
    /^(docx?|odt|rtf)$/.test(extension)
  )
    return 'doc';
  if (
    type.includes('spreadsheetml') ||
    type === 'application/vnd.ms-excel' ||
    type === 'text/csv' ||
    /^(xlsx?|ods|csv|tsv)$/.test(extension)
  )
    return 'sheet';
  if (
    type.includes('presentationml') ||
    type === 'application/vnd.ms-powerpoint' ||
    /^(pptx?|odp|key)$/.test(extension)
  )
    return 'slides';
  return 'file';
}

/** What the browser names an image pasted from the clipboard (or nothing at all). */
const GENERIC_PASTE_NAME = /^(image|blob|unknown|clipboard)?(\.[a-z0-9]+)?$/i;

const PASTE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

/**
 * A pasted file's name. A screenshot from the clipboard arrives as `image.png`
 * (or unnamed), so it gets `Pasted image 2026-10-21 at 14.03.22.png` (the
 * local time); a file with a real name keeps it. `taken` are the names already
 * attached: a clash gets ` (2)`, ` (3)`.
 */
export function pastedFileName(
  file: { name: string; type: string },
  at: Date,
  taken: ReadonlySet<string> = new Set(),
): string {
  let name = file.name.trim();
  if (!name || GENERIC_PASTE_NAME.test(name)) {
    const pad = (value: number) => String(value).padStart(2, '0');
    const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    const time = `${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`;
    const extension = extensionOf(name) || PASTE_EXTENSIONS[file.type] || '';
    const kind = file.type.startsWith('image/') ? 'image' : 'file';
    name = `Pasted ${kind} ${day} at ${time}${extension ? `.${extension}` : ''}`;
  }
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** What a conversation begun with files alone is called for now: their names (the platform names it after them). */
export const titleFromFiles = (files: readonly { name: string }[]): string =>
  files.map((file) => file.name).join(', ');

/** Why a file can't be attached, or null. */
export function attachmentProblem(file: { name: string; size: number }): string | null {
  if (!file.name.trim()) return 'This file has no name.';
  if (file.size > MAX_ATTACHMENT_BYTES)
    return `${file.name} is ${formatBytes(file.size)}; files can be up to ${formatBytes(MAX_ATTACHMENT_BYTES)}.`;
  return null;
}

/** Whether the agent can open attached files: it has the `read` tool. */
export function canReadAttachments(agent: Pick<Agent, 'workspace'> | null | undefined): boolean {
  return Boolean(agent?.workspace?.tools.includes('read'));
}

/** The upload's path: the name, encoded, as a query parameter. */
export function attachmentUploadPath(agentId: string, name: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/attachments?name=${encodeURIComponent(name)}`;
}

/** Files from a drop or a paste: only real files, not dragged text or links. */
export function filesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  // Some webviews list files only in `files`.
  return out.length > 0 ? out : Array.from(data.files ?? []);
}

/**
 * The files in a paste, or none when the paste is text. Copying cells or a
 * page puts text and a picture of it on the clipboard together: the text is
 * what was meant. A screenshot or a copied file has no text.
 */
export function pastedFilesOf(data: DataTransfer | null): File[] {
  const files = filesOf(data);
  if (files.length === 0) return files;
  const text = data?.getData('text/plain') ?? '';
  if (text.trim() && files.every((file) => file.type.startsWith('image/'))) return [];
  return files;
}

/** Whether a drag carries files (not text or a link), so the drop zone shows. */
export function dragHasFiles(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.types ?? []).includes('Files'));
}

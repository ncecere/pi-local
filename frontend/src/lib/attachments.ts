import type { Agent } from '~/api/types';

/**
 * Files attached in the composer (docs/api.md, "Attachments"): each is saved
 * in the agent's workspace, and the message names them in a block after its
 * text, so the agent can open them with its `read` tool. Pure.
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

/** The block naming the files, one line each: `- attachments/2026-10-20/report.pdf (120 KB)`. */
export function attachmentBlock(files: readonly { path: string; size: number }[]): string {
  if (files.length === 0) return '';
  return [
    ATTACHMENTS_HEADING,
    ...files.map((file) => `- ${file.path} (${formatBytes(file.size)})`),
  ].join('\n');
}

/** The message as sent: the person's text, then (after a blank line) the files. */
export function messageWithAttachments(
  text: string,
  files: readonly { path: string; size: number }[],
): string {
  const body = text.trim();
  const block = attachmentBlock(files);
  if (!block) return body;
  return body ? `${body}\n\n${block}` : block;
}

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
  if (data.items?.length) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) out.push(file);
    }
    return out;
  }
  return Array.from(data.files ?? []);
}

/** Whether a drag carries files (not text or a link), so the drop zone shows. */
export function dragHasFiles(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.types ?? []).includes('Files'));
}

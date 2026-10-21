import type { Agent, KnowledgeFolder } from '~/api/client';
import { formatDayTime } from '~/lib/dates';

/** An agent's knowledge folders (an older backend sends none). */
export const knowledgeFoldersOf = (agent: Pick<Agent, 'knowledge'>): string[] =>
  agent.knowledge?.folders ?? [];

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The last part of a path: the folder's own name. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** One line on what the index holds for a folder: "42 files, 311 passages · read Oct 21, 2:03 PM". */
export function folderSummary(folder: KnowledgeFolder): string {
  switch (folder.state) {
    case 'missing':
      return folder.error || "This folder isn't on this computer (is a drive unplugged?).";
    case 'waiting':
      return 'Waiting to be read…';
    case 'indexing': {
      const progress = folder.progress;
      return progress && progress.total > 0
        ? `Reading ${progress.done.toLocaleString()} of ${plural(progress.total, 'file')}…`
        : 'Reading the folder…';
    }
    default: {
      const counts = `${plural(folder.files, 'file')}, ${plural(folder.passages, 'passage')}`;
      return folder.lastScanAt ? `${counts} · read ${formatDayTime(folder.lastScanAt)}` : counts;
    }
  }
}

/** What was left out of a folder, each as a sentence (empty when nothing was). */
export function folderNotes(
  folder: KnowledgeFolder,
  limits: { maxFileBytes: number; maxFiles: number },
): string[] {
  const notes: string[] = [];
  if (folder.problems > 0) notes.push(`${plural(folder.problems, 'file')} couldn't be read.`);
  if (folder.tooLarge > 0)
    notes.push(
      `${plural(folder.tooLarge, 'file')} over ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB ${folder.tooLarge === 1 ? 'was' : 'were'} skipped.`,
    );
  if (folder.partial > 0)
    notes.push(`${plural(folder.partial, 'very long file')} can only be searched in part.`);
  if (folder.truncated)
    notes.push(
      `The folder has more than ${limits.maxFiles.toLocaleString()} files: only the first ${limits.maxFiles.toLocaleString()} are read.`,
    );
  return notes;
}

/**
 * A citation's link: `/api/agents/<id>/knowledge/file?path=<absolute path>`. The app's own address for the
 * file, which its click handler turns into "open this file". Null for any other link.
 */
export function knowledgeLinkOf(href: string): { agentId: string; path: string } | null {
  let url: URL;
  try {
    url = new URL(href, 'http://app.invalid');
  } catch {
    return null;
  }
  // Only the app's own address (a relative link, or this page's own origin).
  const relative = href.startsWith('/') && !href.startsWith('//');
  if (!relative && url.origin !== globalThis.location?.origin) return null;
  if (url.username || url.password) return null;
  const match = /^\/api\/agents\/(ag_[a-z2-7]{16})\/knowledge\/file$/.exec(url.pathname);
  const path = url.searchParams.get('path');
  return match?.[1] && path ? { agentId: match[1], path } : null;
}

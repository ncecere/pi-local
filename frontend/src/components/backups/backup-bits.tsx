import type { Backup, BackupKeyNeed, BackupReason } from '~/api/client';
import { formatBytes } from '~/lib/utils';

export const REASON_LABEL: Record<BackupReason, string> = {
  manual: 'Made by you',
  automatic: 'Daily backup',
  'before-update': 'Before an update',
};

/** "OpenAI, GitHub and Web search": the names of what needs a key typed in again. */
export function keyNames(needs: BackupKeyNeed[]): string {
  const names = needs.map((need) => need.name);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What a backup is made of, in a line: its size, and how much of that is the agents' workspace folders. */
export function sizeLine(backup: Pick<Backup, 'size' | 'workspaceBytes' | 'agents'>): string {
  const parts = [formatBytes(backup.size)];
  parts.push(`${backup.agents} ${backup.agents === 1 ? 'agent' : 'agents'}`);
  if (backup.workspaceBytes > 0)
    parts.push(`workspace files ${formatBytes(backup.workspaceBytes)} before compression`);
  return parts.join(' · ');
}

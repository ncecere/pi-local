import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Agent, ApiError, type Attachment, api, errorMessage } from '~/api/client';
import {
  attachmentProblem,
  attachmentUploadPath,
  canReadAttachments,
  fileKindOf,
  pastedFileName,
} from '~/lib/attachments';

/**
 * Files attached in the composer before a message is sent. Each is uploaded
 * at once to the agent's workspace (`POST /api/agents/{a}/attachments`), as
 * an ArrayBuffer: the Wails asset server drops Blob and File bodies. Sending
 * carries the uploads' answers (`ready`) with the message as `attachments`.
 *
 * An agent without the `read` tool couldn't open them: nothing is uploaded,
 * and `blocked` says so (the composer points to the agent's Tools tab).
 */

export type AttachmentState = 'reading' | 'uploading' | 'done' | 'error';

export interface PendingAttachment {
  /** This tab's own key for the chip. */
  key: string;
  name: string;
  size: number;
  mediaType: string;
  state: AttachmentState;
  error?: string;
  /** Once uploaded: where it is in the workspace. */
  saved?: Attachment;
  /** An image: an object URL for its thumbnail (revoked when the chip goes). */
  previewUrl?: string;
}

let counter = 0;
const nextKey = () => `att-${Date.now().toString(36)}-${++counter}`;

/** An object URL for an image's thumbnail, or undefined (not an image, or no object URLs here). */
function previewOf(file: File): string | undefined {
  if (fileKindOf({ name: file.name, mediaType: file.type }) !== 'image') return undefined;
  try {
    return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined;
  } catch {
    return undefined;
  }
}

const revoke = (url: string | undefined) => {
  if (!url) return;
  try {
    URL.revokeObjectURL?.(url);
  } catch {
    // Nothing to release.
  }
};

export interface Attachments {
  items: PendingAttachment[];
  /** Chosen or dropped files. */
  add(files: readonly File[]): void;
  /** Pasted files: a screenshot named `image.png` gets a name of its own. */
  paste(files: readonly File[]): void;
  remove(key: string): void;
  clear(): void;
  /** Some file is still being read or uploaded: sending waits. */
  busy: boolean;
  /** Uploaded files, ready to send with the message. */
  ready: Attachment[];
  /** The agent can't open files (no `read` tool): nothing was uploaded. */
  blocked: boolean;
  dismissBlocked(): void;
  /** False while there is no agent to attach to. */
  enabled: boolean;
}

export function useAttachments(
  agent: Pick<Agent, 'id' | 'workspace'> | null | undefined,
): Attachments {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [blocked, setBlocked] = useState(false);
  const agentId = agent?.id ?? null;
  // Uploads for an agent no longer chosen are let go (their answers ignored).
  const generation = useRef(0);
  // Every thumbnail's URL by chip, so each is revoked once, whichever way its chip goes.
  const previews = useRef(new Map<string, string>());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const release = useCallback((key: string) => {
    revoke(previews.current.get(key));
    previews.current.delete(key);
  }, []);
  const releaseAll = useCallback(() => {
    for (const url of previews.current.values()) revoke(url);
    previews.current.clear();
  }, []);

  // Another agent: what was attached was put in the other one's workspace.
  // biome-ignore lint/correctness/useExhaustiveDependencies: agentId is the trigger
  useEffect(() => {
    generation.current++;
    releaseAll();
    setItems([]);
    setBlocked(false);
  }, [agentId]);

  // Leaving the page lets go of every thumbnail.
  useEffect(() => releaseAll, [releaseAll]);

  const patch = useCallback((key: string, change: Partial<PendingAttachment>) => {
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...change } : item)),
    );
  }, []);

  const upload = useCallback(
    async (file: File, key: string, forAgent: string, round: number) => {
      const stale = () => generation.current !== round;
      try {
        const bytes = await file.arrayBuffer();
        if (stale()) return;
        patch(key, { state: 'uploading' });
        const saved = await api.upload<Attachment>(
          attachmentUploadPath(forAgent, file.name),
          bytes,
          file.type || 'application/octet-stream',
        );
        if (stale()) return;
        patch(key, { state: 'done', saved });
      } catch (error) {
        if (stale()) return;
        if (error instanceof ApiError && error.code === 'no_read_tool') {
          setBlocked(true);
          release(key);
          setItems((current) => current.filter((item) => item.key !== key));
          return;
        }
        patch(key, {
          state: 'error',
          error:
            error instanceof ApiError && error.status === 413
              ? `${file.name} is too large.`
              : errorMessage(error, `${file.name} couldn't be attached.`),
        });
      }
    },
    [patch, release],
  );

  const attach = useCallback(
    (files: readonly File[], pasted: boolean) => {
      if (!agentId || files.length === 0) return;
      if (!canReadAttachments(agent)) {
        setBlocked(true);
        return;
      }
      const round = generation.current;
      // A pasted screenshot is named after the moment it was taken; names stay unique among the chips.
      const taken = new Set(itemsRef.current.map((item) => item.name));
      const now = new Date();
      const prepared = files.map((original) => {
        if (!pasted) return original;
        const name = pastedFileName(original, now, taken);
        taken.add(name);
        return name === original.name
          ? original
          : new File([original], name, {
              type: original.type,
              lastModified: original.lastModified,
            });
      });
      const added: PendingAttachment[] = prepared.map((file) => {
        const problem = attachmentProblem(file);
        const key = nextKey();
        const previewUrl = problem ? undefined : previewOf(file);
        if (previewUrl) previews.current.set(key, previewUrl);
        return {
          key,
          name: file.name || 'file',
          size: file.size,
          mediaType: file.type,
          state: problem ? 'error' : 'reading',
          ...(problem ? { error: problem } : {}),
          ...(previewUrl ? { previewUrl } : {}),
        };
      });
      setItems((current) => [...current, ...added]);
      prepared.forEach((file, index) => {
        const item = added[index]!;
        if (item.state !== 'error') void upload(file, item.key, agentId, round);
      });
    },
    [agent, agentId, upload],
  );
  const add = useCallback((files: readonly File[]) => attach(files, false), [attach]);
  const paste = useCallback((files: readonly File[]) => attach(files, true), [attach]);

  const remove = useCallback(
    (key: string) => {
      // The file stays in the workspace (the API has no delete); it is just not sent.
      release(key);
      setItems((current) => current.filter((item) => item.key !== key));
    },
    [release],
  );
  const clear = useCallback(() => {
    releaseAll();
    setItems([]);
  }, [releaseAll]);

  return useMemo(() => {
    const ready = items.flatMap((item) =>
      item.state === 'done' && item.saved ? [item.saved] : [],
    );
    return {
      items,
      add,
      paste,
      remove,
      clear,
      busy: items.some((item) => item.state === 'reading' || item.state === 'uploading'),
      ready,
      blocked,
      dismissBlocked: () => setBlocked(false),
      enabled: agentId !== null,
    };
  }, [items, add, paste, remove, clear, blocked, agentId]);
}

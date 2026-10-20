import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Agent, ApiError, type Attachment, api, errorMessage } from '~/api/client';
import {
  attachmentProblem,
  attachmentUploadPath,
  canReadAttachments,
  messageWithAttachments,
} from '~/lib/attachments';

/**
 * Files attached in the composer before a message is sent. Each is uploaded
 * at once to the agent's workspace (`POST /api/agents/{a}/attachments`), as
 * an ArrayBuffer: the Wails asset server drops Blob and File bodies. Sending
 * appends the "Attached files" block naming them (lib/attachments.ts).
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
  state: AttachmentState;
  error?: string;
  /** Once uploaded: where it is in the workspace. */
  saved?: Attachment;
}

let counter = 0;
const nextKey = () => `att-${Date.now().toString(36)}-${++counter}`;

export interface Attachments {
  items: PendingAttachment[];
  add(files: readonly File[]): void;
  remove(key: string): void;
  clear(): void;
  /** Some file is still being read or uploaded: sending waits. */
  busy: boolean;
  /** Uploaded files, ready to name in the message. */
  ready: Attachment[];
  /** The agent can't open files (no `read` tool): nothing was uploaded. */
  blocked: boolean;
  dismissBlocked(): void;
  /** The text to send: `text` and the block naming the uploaded files. */
  compose(text: string): string;
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

  // Another agent: what was attached was put in the other one's workspace.
  // biome-ignore lint/correctness/useExhaustiveDependencies: agentId is the trigger
  useEffect(() => {
    generation.current++;
    setItems([]);
    setBlocked(false);
  }, [agentId]);

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
    [patch],
  );

  const add = useCallback(
    (files: readonly File[]) => {
      if (!agentId || files.length === 0) return;
      if (!canReadAttachments(agent)) {
        setBlocked(true);
        return;
      }
      const round = generation.current;
      const added: PendingAttachment[] = files.map((file) => {
        const problem = attachmentProblem(file);
        return {
          key: nextKey(),
          name: file.name || 'file',
          size: file.size,
          state: problem ? 'error' : 'reading',
          ...(problem ? { error: problem } : {}),
        };
      });
      setItems((current) => [...current, ...added]);
      files.forEach((file, index) => {
        const item = added[index]!;
        if (item.state !== 'error') void upload(file, item.key, agentId, round);
      });
    },
    [agent, agentId, upload],
  );

  const remove = useCallback((key: string) => {
    // The file stays in the workspace (the API has no delete); it is just not named.
    setItems((current) => current.filter((item) => item.key !== key));
  }, []);
  const clear = useCallback(() => setItems([]), []);

  return useMemo(() => {
    const ready = items.flatMap((item) =>
      item.state === 'done' && item.saved ? [item.saved] : [],
    );
    return {
      items,
      add,
      remove,
      clear,
      busy: items.some((item) => item.state === 'reading' || item.state === 'uploading'),
      ready,
      blocked,
      dismissBlocked: () => setBlocked(false),
      compose: (text: string) => messageWithAttachments(text, ready),
      enabled: agentId !== null,
    };
  }, [items, add, remove, clear, blocked, agentId]);
}

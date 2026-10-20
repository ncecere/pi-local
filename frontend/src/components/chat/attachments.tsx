import { Link } from '@tanstack/react-router';
import { CircleAlert, FileText, Paperclip, Upload, X } from 'lucide-react';
import { type DragEvent, useCallback, useRef, useState } from 'react';
import { FOCUS_RING } from '~/components/ui/focus-ring';
import { Spinner } from '~/components/ui/spinner';
import type { Attachments, PendingAttachment } from '~/hooks/use-attachments';
import { dragHasFiles, filesOf, formatBytes, MAX_ATTACHMENT_BYTES } from '~/lib/attachments';
import { cn } from '~/lib/utils';

/** The paperclip left of the agent picker: choose files to attach. */
export function AttachButton({
  onFiles,
  disabled = false,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        aria-label="Attach files"
        title={`Attach files (up to ${formatBytes(MAX_ATTACHMENT_BYTES)} each)`}
        className={cn(
          'inline-flex size-[2.125rem] shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40',
          FOCUS_RING,
        )}
      >
        <Paperclip className="size-4" aria-hidden="true" />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // The same file can be chosen again after it was removed.
          event.target.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}

const STATE_LABEL: Record<PendingAttachment['state'], string> = {
  reading: 'Reading…',
  uploading: 'Uploading…',
  done: 'Attached',
  error: 'Not attached',
};

function Chip({ item, onRemove }: { item: PendingAttachment; onRemove: () => void }) {
  const working = item.state === 'reading' || item.state === 'uploading';
  const failed = item.state === 'error';
  return (
    <li
      className={cn(
        'relative flex max-w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg border py-1.5 pr-1 pl-2.5 text-xs',
        failed
          ? 'border-[var(--danger)]/50 bg-[var(--danger)]/10'
          : 'border-[var(--border-subtle)] bg-[var(--bg-control-alt)]',
      )}
      title={item.error ?? (item.saved ? item.saved.path : item.name)}
    >
      {working ? (
        <Spinner className="size-3.5 shrink-0" />
      ) : failed ? (
        <CircleAlert className="size-3.5 shrink-0 text-[var(--danger)]" aria-hidden="true" />
      ) : (
        <FileText className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="max-w-[14rem] truncate font-medium text-[var(--text-primary)]">
          {item.name}
        </span>
        <span
          className={cn(
            'truncate',
            failed ? 'text-[var(--danger-on-tint)]' : 'text-[var(--text-muted)]',
          )}
        >
          {failed
            ? (item.error ?? STATE_LABEL.error)
            : `${formatBytes(item.size)} · ${STATE_LABEL[item.state]}`}
        </span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${item.name}`}
        title="Remove"
        className={cn(
          'ml-0.5 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]',
          FOCUS_RING,
        )}
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
      {working && (
        // Indeterminate: a raw-bytes POST reports no progress.
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-[var(--border-subtle)]"
        >
          <span className="block h-full w-1/3 bg-[var(--accent-bright)] motion-safe:animate-[attach-progress_1.2s_ease-in-out_infinite]" />
        </span>
      )}
    </li>
  );
}

/**
 * Above the message box: the files attached so far, as chips (name, size,
 * whether it is uploaded, Remove), and a note when the agent can't open files.
 */
export function AttachmentTray({
  attachments,
  agent,
}: {
  attachments: Attachments;
  agent: { id: string; name: string } | null | undefined;
}) {
  const { items, blocked } = attachments;
  if (items.length === 0 && !blocked) return null;
  const uploading = items.filter((item) => item.state === 'reading' || item.state === 'uploading');
  return (
    <div className="mb-3 flex flex-col gap-2">
      {blocked && agent && (
        <div
          role="note"
          className="flex items-start gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control-alt)] px-3 py-2 text-xs text-[var(--text-secondary)]"
        >
          <CircleAlert
            className="mt-px size-3.5 shrink-0 text-[var(--warning)]"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1">
            {agent.name} can't open files: it doesn't have the <strong>Read files</strong> tool.{' '}
            <Link
              to="/settings/agents/$agentId"
              params={{ agentId: agent.id }}
              search={{ tab: 'tools' }}
              className="font-medium text-[var(--text-primary)] underline underline-offset-2"
            >
              Turn it on in {agent.name}'s Tools
            </Link>
            , then attach again.
          </p>
          <button
            type="button"
            onClick={attachments.dismissBlocked}
            aria-label="Dismiss"
            className={cn(
              'rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]',
              FOCUS_RING,
            )}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
      {items.length > 0 && (
        <ul aria-label="Attached files" className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <Chip key={item.key} item={item} onRemove={() => attachments.remove(item.key)} />
          ))}
        </ul>
      )}
      <span role="status" className="sr-only">
        {uploading.length > 0
          ? `Uploading ${uploading.length} ${uploading.length === 1 ? 'file' : 'files'}…`
          : items.length > 0
            ? `${items.filter((item) => item.state === 'done').length} attached`
            : ''}
      </span>
    </div>
  );
}

/**
 * Dropping files onto an area (the conversation and the composer). Only a
 * drag carrying files counts; dragged text or links are left alone.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled: boolean) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const reset = useCallback(() => {
    depth.current = 0;
    setDragging(false);
  }, []);
  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!enabled || !dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!enabled || !dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: DragEvent) => {
      if (!enabled || !dragHasFiles(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (!enabled || !dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      reset();
      const files = filesOf(event.dataTransfer);
      if (files.length > 0) onFiles(files);
    },
  };
  return { dragging, handlers };
}

/** Over the conversation while files are dragged onto it. */
export function DropOverlay({ show, agentName }: { show: boolean; agentName?: string }) {
  if (!show) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[var(--accent-bright)] bg-[var(--bg-root)]/85 text-sm text-[var(--text-primary)] backdrop-blur-sm"
    >
      <Upload className="size-6" />
      <p className="font-medium">Drop files to attach</p>
      <p className="text-xs text-[var(--text-muted)]">
        They're saved in {agentName ? `${agentName}'s` : 'the agent’s'} workspace, up to{' '}
        {formatBytes(MAX_ATTACHMENT_BYTES)} each.
      </p>
    </div>
  );
}

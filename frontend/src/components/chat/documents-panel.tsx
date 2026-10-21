import { ChevronDown, FileText, LoaderCircle, PanelRightClose, X } from 'lucide-react';
import { useId, useState } from 'react';
import { errorMessage } from '~/api/client';
import type { ChatDocumentRef } from '~/api/types';
import { ArtifactCanvas } from '~/components/chat/artifact-canvas';
import { DocumentValue } from '~/components/chat/document-views';
import { SidePanelPortal } from '~/components/layout/side-panel-slot';
import { Dialog, DialogContent, DialogTitle } from '~/components/ui/dialog';
import { FOCUS_RING } from '~/components/ui/focus-ring';
import { useMediaQuery } from '~/hooks/use-media-query';
import { useThreadDocument } from '~/hooks/use-thread-documents';
import { documentTitle, sortDocumentKinds } from '~/lib/thread-documents';
import { cn } from '~/lib/utils';

/** Wide enough for the panel beside the conversation; narrower, it is a drawer. */
export const DOCUMENTS_SIDE_QUERY = '(min-width: 1100px)';

type Documents = Readonly<Record<string, ChatDocumentRef>>;

/** One document: its name, and its value as it is now (re-read when its revision changes). */
function DocumentSection({
  agentId,
  threadId,
  kind,
  revision,
}: {
  agentId: string;
  threadId: string;
  kind: string;
  revision: string;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const query = useThreadDocument(agentId, threadId, kind, revision);
  const updating = query.isFetching && query.data !== undefined;
  return (
    <section
      className="border-b border-[var(--border-subtle)] py-3 last:border-b-0"
      data-document-kind={kind}
    >
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className={cn(
            'flex w-full items-center gap-2 rounded text-left text-[0.8125rem] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            FOCUS_RING,
          )}
        >
          <FileText className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{documentTitle(kind)}</span>
          {updating && (
            <LoaderCircle
              className="size-3.5 shrink-0 text-[var(--text-muted)] motion-safe:animate-spin"
              aria-label="Updating"
            />
          )}
          <ChevronDown
            className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </h3>
      {open && (
        <div id={bodyId} className="mt-2.5">
          {query.data ? (
            kind === 'artifacts' ? (
              <ArtifactCanvas agentId={agentId} threadId={threadId} value={query.data.value} />
            ) : (
              <DocumentValue kind={kind} value={query.data.value} />
            )
          ) : query.isError ? (
            <p role="alert" className="text-xs text-[var(--danger-on-tint)]">
              {errorMessage(query.error, "This document couldn't be read.")}{' '}
              <button type="button" className="underline" onClick={() => void query.refetch()}>
                Try again
              </button>
            </p>
          ) : (
            <p className="text-xs text-[var(--text-muted)]">Loading…</p>
          )}
        </div>
      )}
    </section>
  );
}

function DocumentList({
  agentId,
  threadId,
  documents,
}: {
  agentId: string;
  threadId: string;
  documents: Documents;
}) {
  return (
    <div>
      {sortDocumentKinds(Object.keys(documents)).map((kind) => (
        <DocumentSection
          key={kind}
          agentId={agentId}
          threadId={threadId}
          kind={kind}
          revision={documents[kind]!.revision}
        />
      ))}
    </div>
  );
}

/**
 * The documents the agent keeps for this conversation (a research plan and
 * its sources, a triage queue), beside the transcript on a wide window and
 * as a drawer on a narrow one. Nothing when there are none.
 */
export function DocumentsPanel({
  agentId,
  threadId,
  documents,
}: {
  agentId: string;
  threadId: string;
  documents: Documents | undefined;
}) {
  const side = useMediaQuery(DOCUMENTS_SIDE_QUERY);
  const [hidden, setHidden] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const count = documents ? Object.keys(documents).length : 0;
  const hasCanvas = !!documents?.artifacts;
  const title = hasCanvas ? 'Canvas & documents' : 'Documents';
  if (!documents || count === 0) return null;

  const opener = (onClick: () => void, label: string) => (
    <button
      type="button"
      data-floating-controls
      onClick={onClick}
      aria-label={label}
      className={cn(
        'absolute right-2 top-[4.5rem] z-20 flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-pill)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] shadow-sm hover:text-[var(--text-primary)]',
        FOCUS_RING,
      )}
    >
      <FileText className="size-3.5" aria-hidden="true" />
      {title}
      <span className="tabular-nums text-[var(--text-muted)]">{count}</span>
    </button>
  );

  if (side && !hidden)
    return (
      <SidePanelPortal>
        <aside
          aria-label="Conversation documents"
          className={cn(
            'flex shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-app)]/40',
            hasCanvas ? 'w-[32rem] max-w-[45vw]' : 'w-[20rem]',
          )}
        >
          <div className="flex items-center gap-2 px-4 pb-1 pt-[4.5rem]">
            <h2 className="flex-1 text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
            <button
              type="button"
              onClick={() => setHidden(true)}
              aria-label="Hide documents"
              title="Hide documents"
              className={cn(
                'rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]',
                FOCUS_RING,
              )}
            >
              <PanelRightClose className="size-4" aria-hidden="true" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <DocumentList agentId={agentId} threadId={threadId} documents={documents} />
          </div>
        </aside>
      </SidePanelPortal>
    );

  if (side) return opener(() => setHidden(false), 'Show documents');

  return (
    <>
      {opener(() => setDrawer(true), 'Open documents')}
      <Dialog open={drawer} onOpenChange={setDrawer}>
        <DialogContent
          closeButton={false}
          aria-describedby={undefined}
          className="left-auto right-0 top-0 h-full w-[min(24rem,100%)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none border-y-0 border-r-0 p-0"
        >
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-3">
            <DialogTitle className="flex-1 text-sm">{title}</DialogTitle>
            <button
              type="button"
              onClick={() => setDrawer(false)}
              aria-label="Close"
              className={cn(
                'rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]',
                FOCUS_RING,
              )}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          <div className="px-4 pb-4">
            <DocumentList agentId={agentId} threadId={threadId} documents={documents} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

import { createContext, type ReactNode, useContext, useState } from 'react';
import type { Artifact } from '~/lib/artifacts';

export type ArtifactDraft = { base: Artifact; content: string };
type Drafts = Record<string, ArtifactDraft>;
type Selections = Record<string, string>;

function useDraftSession() {
  const [drafts, setDrafts] = useState<Drafts>({});
  const [selections, setSelections] = useState<Selections>({});
  return {
    drafts,
    selections,
    setDraft(key: string, draft: ArtifactDraft | null) {
      setDrafts((current) => {
        const next = { ...current };
        if (draft) next[key] = draft;
        else delete next[key];
        return next;
      });
    },
    saved(key: string, snapshot: ArtifactDraft) {
      setDrafts((current) => {
        // A request may finish after hiding the editor or starting another draft.
        // Never clear content that was not part of the confirmed save.
        if (current[key] !== snapshot) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    select(key: string, id: string) {
      setSelections((current) => ({ ...current, [key]: id }));
    },
  };
}

const ArtifactDraftContext = createContext<ReturnType<typeof useDraftSession> | null>(null);

/**
 * React-owned window session, not a module cache or durable storage. At the app
 * root it survives conversation navigation. Nothing evicts drafts: only an
 * explicit successful save or discard removes them. Page teardown loses them.
 * Panel/canvas fallbacks keep standalone renders usable with the same behavior.
 */
export function ArtifactDraftProvider({ children }: { children: ReactNode }) {
  const inherited = useContext(ArtifactDraftContext);
  return inherited ? children : <DraftSession>{children}</DraftSession>;
}

function DraftSession({ children }: { children: ReactNode }) {
  const session = useDraftSession();
  return <ArtifactDraftContext.Provider value={session}>{children}</ArtifactDraftContext.Provider>;
}

export function artifactDraftKey(agentId: string, threadId: string, artifactId?: string) {
  // Tuple encoding avoids collisions even when IDs contain delimiters.
  return JSON.stringify([agentId, threadId, artifactId]);
}

export function useArtifactDrafts() {
  const session = useContext(ArtifactDraftContext);
  if (!session) throw new Error('Artifact drafts require an ArtifactDraftProvider');
  return session;
}

import { useQueryClient } from '@tanstack/react-query';
import { FolderOpen, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { type Agent, errorMessage, type KnowledgeFolder } from '~/api/client';
import { Panel, saveAgentChange } from '~/components/agent-manager/panel';
import { ProjectFolderInput } from '~/components/agent-manager/project-folder-field';
import { ErrorNotice, RequestError } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useUpdateAgent } from '~/hooks/use-agents';
import {
  knowledgeKey,
  useKnowledge,
  useKnowledgeProblems,
  useRescanKnowledge,
} from '~/hooks/use-knowledge';
import { folderName, folderNotes, folderSummary, knowledgeFoldersOf } from '~/lib/knowledge';

/** Documents this agent may search and read. Adding a folder never gives it permission to write there. */
export function KnowledgeTab({ agent }: { agent: Agent }) {
  const id = useId();
  const [path, setPath] = useState('');
  const info = useKnowledge(agent.id);
  const update = useUpdateAgent();
  const queryClient = useQueryClient();
  const folders = knowledgeFoldersOf(agent);
  const save = (next: string[], after?: () => void) =>
    saveAgentChange(
      agent,
      () => update.mutateAsync({ id: agent.id, knowledge: { folders: next } }),
      () => {
        void queryClient.invalidateQueries({ queryKey: knowledgeKey(agent.id) });
        after?.();
      },
    );
  return (
    <Panel
      title="Knowledge folders"
      description={
        <>
          Folders on this computer whose documents {agent.name} can search, read and cite, even
          outside its workspace. This does not allow writing to them. Text, Markdown, PDF, Word,
          Excel and PowerPoint are read locally; matching passages go to its model provider. With
          Knowledge fast judgments on, passages also go to that service.
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim() && !update.isPending)
              save([...folders, path.trim()], () => setPath(''));
          }}
        >
          <label htmlFor={id} className="text-sm font-medium">
            Knowledge folder
          </label>
          <ProjectFolderInput
            id={id}
            value={path}
            onChange={setPath}
            label="Knowledge folder"
            placeholder="/Users/you/Documents/contracts"
            dialogTitle="Choose a knowledge folder"
          />
          <div>
            <Button
              type="submit"
              variant="secondary"
              disabled={!path.trim() || update.isPending || folders.length >= 20}
            >
              {update.isPending ? <Spinner className="size-4" /> : <Plus />}
              Add folder
            </Button>
          </div>
          <RequestError error={update.error} what="The knowledge folders" />
        </form>
        {info.isError ? (
          <ErrorNotice>
            {errorMessage(info.error, 'The index status could not be read.')}
          </ErrorNotice>
        ) : !info.data ? (
          <Spinner />
        ) : folders.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">
            No knowledge folders yet. Add one to let this agent search your documents.
          </p>
        ) : (
          <ul
            aria-label="Knowledge folders"
            className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]"
          >
            {folders.map((folder) => {
              const status = info.data.folders.find((item) => item.path === folder) ?? {
                path: folder,
                state: 'waiting',
                files: 0,
                passages: 0,
                problems: 0,
                tooLarge: 0,
                partial: 0,
                truncated: false,
                lastScanAt: null,
              };
              return (
                <FolderRow
                  key={folder}
                  agentId={agent.id}
                  folder={status}
                  limits={info.data.limits}
                  removing={update.isPending}
                  onRemove={() => save(folders.filter((item) => item !== folder))}
                />
              );
            })}
          </ul>
        )}
        <p className="text-xs text-[var(--text-muted)]">
          Changes are checked every 30 seconds and when the app starts. Hidden files, symbolic links
          and node_modules are skipped. Files over 50 MB are skipped; at most 10,000 files per
          folder and 3,000 passages per file are indexed. Removing a folder stops access for this
          agent. Your files stay where they are.
        </p>
      </div>
    </Panel>
  );
}

function FolderRow({
  agentId,
  folder,
  limits,
  removing,
  onRemove,
}: {
  agentId: string;
  folder: KnowledgeFolder;
  limits: { maxFileBytes: number; maxFiles: number };
  removing: boolean;
  onRemove: () => void;
}) {
  const [showProblems, setShowProblems] = useState(false);
  const rescan = useRescanKnowledge(agentId);
  const problems = useKnowledgeProblems(agentId, folder.path, showProblems);
  const notes = folderNotes(folder, limits);
  const reading = folder.state === 'indexing' || folder.state === 'waiting';
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-start gap-2">
        <FolderOpen
          className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{folderName(folder.path)}</p>
          <p className="break-all text-xs text-[var(--text-muted)]">{folder.path}</p>
          <p role="status" className="mt-1 text-sm text-[var(--text-secondary)]">
            {folderSummary(folder)}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={rescan.isPending || reading}
          aria-label={`Rescan ${folder.path}`}
          onClick={() => rescan.mutate(folder.path)}
        >
          <RefreshCw /> Rescan
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={removing}
          aria-label={`Remove ${folder.path}`}
          title="Remove folder (files stay)"
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
      {notes.map((note) => (
        <p key={note} className="text-xs text-[var(--text-muted)]">
          {note}
        </p>
      ))}
      {notes.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setShowProblems(!showProblems)}
        >
          {showProblems ? 'Hide details' : 'Show details'}
        </Button>
      )}
      {showProblems &&
        (problems.isError ? (
          <ErrorNotice>
            {errorMessage(problems.error, 'The files could not be listed.')}
          </ErrorNotice>
        ) : !problems.data ? (
          <Spinner />
        ) : (
          <ul aria-label={`Index problems in ${folder.path}`} className="text-xs">
            {problems.data.map((problem) => (
              <li key={problem.path} className="py-1">
                <span className="break-all font-medium">{problem.rel}</span>: {problem.message}
              </li>
            ))}
          </ul>
        ))}
      <RequestError error={rescan.error} what="The rescan" />
    </li>
  );
}

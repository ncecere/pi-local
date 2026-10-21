import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ApiError, api, errorMessage, threadPath } from '~/api/client';
import { HighlightedCode, Markdown } from '~/components/chat/markdown';
import { Button } from '~/components/ui/button';
import { useAgent } from '~/hooks/use-agents';
import { threadDocumentKey } from '~/hooks/use-thread-documents';
import {
  type Artifact,
  type ArtifactVersion,
  artifactHtml,
  artifactList,
  csvRows,
} from '~/lib/artifacts';
import { filenameFromContentDisposition, saveBlob } from '~/lib/download';

export function ArtifactPreview({ artifact }: { artifact: ArtifactVersion }) {
  const html = useMemo(
    () => (artifact.type === 'html' ? artifactHtml(artifact.content) : ''),
    [artifact.type, artifact.content],
  );
  if (artifact.type === 'html')
    return (
      <iframe
        title="HTML artifact preview"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={html}
        className="h-[30rem] w-full border-0 bg-white"
      />
    );
  if (artifact.type === 'code')
    return <HighlightedCode source={artifact.content} language={artifact.language ?? 'text'} />;
  if (artifact.type === 'csv')
    return (
      <div className="overflow-auto">
        <table className="w-full text-xs">
          <tbody>
            {csvRows(artifact.content).map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: CSV rows and cells are positional, read-only text
              <tr key={i}>
                {row.map((cell, j) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: CSV cells have positional identity and no state
                    key={`${i}:${j}`}
                    className="whitespace-pre-wrap border border-[var(--border-subtle)] p-2"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return <Markdown skipHtml>{artifact.content}</Markdown>;
}

/** Lives inside DocumentsPanel: only one side-panel portal, shared with the other conversation documents. */
export function ArtifactCanvas({
  agentId,
  threadId,
  value,
}: {
  agentId: string;
  threadId: string;
  value: unknown;
}) {
  const canWrite = useAgent(agentId)?.workspace?.tools.includes('write') ?? false;
  const artifacts = artifactList(value);
  const [selected, setSelected] = useState('');
  const artifact = artifacts.find((a) => a.id === selected) ?? artifacts[0];
  if (!artifact) return <p>No artifacts yet.</p>;
  return (
    <section className="space-y-3" aria-label="Artifact canvas">
      <label className="block text-xs">
        Artifact
        <select
          className="mt-1 block w-full rounded bg-[var(--bg-control)] p-2"
          aria-label="Select artifact"
          value={artifact.id}
          onChange={(e) => setSelected(e.target.value)}
        >
          {artifacts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title}
            </option>
          ))}
        </select>
      </label>
      <ArtifactEditor
        key={`${agentId}/${threadId}/${artifact.id}`}
        agentId={agentId}
        threadId={threadId}
        artifact={artifact}
        canWrite={canWrite}
      />
    </section>
  );
}

function ArtifactEditor({
  agentId,
  threadId,
  artifact,
  canWrite,
}: {
  agentId: string;
  threadId: string;
  artifact: Artifact;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ base: Artifact; content: string } | null>(null);
  const [history, setHistory] = useState<ArtifactVersion[] | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [workspacePath, setWorkspacePath] = useState('');
  const [workspace, setWorkspace] = useState(false);
  const shown = history?.find((v) => v.revision === revision) ?? artifact;
  const path = threadPath(agentId, threadId, `/artifacts/${encodeURIComponent(artifact.id)}`);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e, 'The artifact could not be saved. Your draft is still here.'));
    } finally {
      setBusy(false);
    }
  }
  const save = () =>
    run(async () => {
      if (!editing) return;
      await api.put(path, {
        title: editing.base.title,
        type: editing.base.type,
        language: editing.base.language,
        content: editing.content,
        expectedRevision: editing.base.revision,
      });
      setEditing(null);
      setHistory(null);
      setRevision(null);
      await queryClient.invalidateQueries({
        queryKey: threadDocumentKey(agentId, threadId, 'artifacts'),
      });
      setNotice('Saved a new revision.');
    });
  const download = () =>
    run(async () => {
      try {
        const result = await api.post<{ cancelled?: boolean; path?: string }>(`${path}/download`);
        if (result.path) setNotice(`Saved to ${result.path}`);
        return;
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 501) throw e;
      }
      const file = await api.download(`${path}/download`);
      saveBlob(
        file.blob,
        filenameFromContentDisposition(file.contentDisposition) ?? `${artifact.id}.txt`,
      );
    });
  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--text-muted)]">
        Revision {shown.revision} · {new Date(shown.updatedAt).toLocaleString()}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await navigator.clipboard.writeText(editing?.content ?? shown.content);
              setNotice('Copied.');
            })
          }
        >
          Copy
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !!editing || revision !== null}
          onClick={() => void download()}
        >
          Download
        </Button>
        {!editing && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || revision !== null}
            onClick={() => {
              setEditing({ base: artifact, content: artifact.content });
              setError('');
            }}
          >
            Edit
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !!editing}
          onClick={() =>
            void run(async () => {
              setHistory(await api.get<ArtifactVersion[]>(`${path}/history`));
              setRevision(null);
            })
          }
        >
          History
        </Button>
        {canWrite && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !!editing || revision !== null}
            onClick={() => setWorkspace(!workspace)}
          >
            Save to workspace
          </Button>
        )}
      </div>
      {workspace && !editing && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.post(`${path}/workspace`, {
                path: workspacePath,
                expectedRevision: artifact.revision,
              });
              setNotice(`Saved to workspace: ${workspacePath}`);
            });
          }}
        >
          <label className="block text-xs">
            Workspace file path
            <input
              className="block w-full rounded bg-[var(--bg-control)] p-2"
              required
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              placeholder="report.md"
            />
          </label>
          <p className="text-xs">
            Requires this agent’s write capability. Replaces the file at this workspace-relative
            path.
          </p>
          <Button size="sm" disabled={busy}>
            Save file
          </Button>
        </form>
      )}
      {history && !editing && (
        <label className="block text-xs">
          Version
          <select
            aria-label="Artifact version"
            className="ml-2 rounded bg-[var(--bg-control)] p-1"
            value={revision ?? ''}
            onChange={(e) => setRevision(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Current ({artifact.revision})</option>
            {history.map((v) => (
              <option key={v.revision} value={v.revision}>
                Revision {v.revision}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p role="alert" className="text-xs text-[var(--danger-on-tint)]">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
      {editing ? (
        <div className="space-y-2">
          <label className="block text-xs">
            Content
            <textarea
              aria-label="Artifact content"
              className="mt-1 h-96 w-full rounded bg-[var(--bg-control)] p-2 font-mono text-xs"
              value={editing.content}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
            />
          </label>
          <p className="text-xs">
            {new TextEncoder().encode(editing.content).byteLength} / 65,536 bytes · editing revision{' '}
            {editing.base.revision}
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              Save revision
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setError('');
              }}
            >
              Discard draft
            </Button>
          </div>
        </div>
      ) : (
        <ArtifactPreview artifact={shown} />
      )}
      <p className="text-xs text-[var(--text-faint)]">
        Code is never executed. HTML previews have no scripts, navigation or network access.
      </p>
    </div>
  );
}

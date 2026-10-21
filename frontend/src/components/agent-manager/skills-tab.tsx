import { FolderUp, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { type Agent, ApiError, errorMessage, type Skill } from '~/api/client';
import { agentSavedMessage, Panel } from '~/components/agent-manager/panel';
import { ConfirmDialog, ErrorNotice } from '~/components/models/fields';
import { SkillViewDialog } from '~/components/skills/skill-view-dialog';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import {
  type SkillScope,
  useAddSkill,
  useAgentSkills,
  useDeleteSkill,
  useEnableSkills,
} from '~/hooks/use-skills';
import { MAX_SKILL_ZIP_BYTES, zipOfPickedFolder } from '~/lib/skill-files';

/** What a zip or a folder becomes, and what to say about it going wrong. */
function problemText(error: unknown): string {
  if (error instanceof ApiError && error.status === 400)
    return `That can't be added: ${error.message}`;
  return errorMessage(error, 'The skill could not be added.');
}

/**
 * "Add from a zip" and "Add from a folder": the person picks a file or a folder, the bytes go to the API as a zip
 * (a folder is zipped here first). A name that is taken asks before replacing.
 */
function AddSkillButtons({ scope, label }: { scope: SkillScope; label: string }) {
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const add = useAddSkill(scope);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<ArrayBuffer | null>(null);
  const [existing, setExisting] = useState('');

  async function send(bytes: ArrayBuffer) {
    setError(null);
    try {
      const skill = await add.mutateAsync({ bytes });
      toast(`${skill.name} added.`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'exists') {
        setExisting(caught.message);
        setReplacing(bytes);
      } else setError(problemText(caught));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <input
        ref={zipInput}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid={`zip-${'agentId' in scope ? 'own' : 'shared'}`}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          if (file.size > MAX_SKILL_ZIP_BYTES) {
            setError('A skill zip is at most 25 MB.');
            return;
          }
          try {
            await send(await file.arrayBuffer());
          } catch (caught) {
            setError(problemText(caught));
          }
        }}
      />
      <input
        ref={folderInput}
        type="file"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid={`folder-${'agentId' in scope ? 'own' : 'shared'}`}
        // A folder chooser (Safari, Chrome and the desktop app's web view all have this one).
        {...{ webkitdirectory: '', directory: '' }}
        multiple
        onChange={async (event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length === 0) return;
          try {
            await send(await zipOfPickedFolder(files));
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'That folder could not be read.');
          }
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={add.isPending}
          onClick={() => zipInput.current?.click()}
        >
          {add.isPending ? <Spinner className="size-4 text-current" /> : <Upload />}
          Add from a zip{label}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={add.isPending}
          onClick={() => folderInput.current?.click()}
        >
          <FolderUp />
          Add from a folder{label}
        </Button>
      </div>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {replacing && (
        <ConfirmDialog
          title="Replace this skill?"
          description={`${existing} Replacing it removes its old files.`}
          action="Replace"
          what="This skill"
          onConfirm={async () => {
            await add.mutateAsync({ bytes: replacing, replace: true });
            toast('Skill replaced.');
          }}
          onClose={() => setReplacing(null)}
        />
      )}
    </div>
  );
}

function SkillRow({
  skill,
  trailing,
  onView,
  onDelete,
  deleteLabel,
  children,
}: {
  skill: Skill;
  trailing?: React.ReactNode;
  onView: () => void;
  onDelete: () => void;
  deleteLabel: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="font-mono text-sm font-medium text-[var(--text-primary)]">{skill.name}</p>
        {skill.description && (
          <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{skill.description}</p>
        )}
        {skill.problem && (
          <p className="mt-0.5 text-sm text-[var(--danger-on-tint)]">
            Not used yet: {skill.problem}
          </p>
        )}
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          {skill.fileCount} {skill.fileCount === 1 ? 'file' : 'files'}
          {children}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {trailing}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={onView}
          aria-label={`View ${skill.name}`}
        >
          View
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onDelete}
          aria-label={`${deleteLabel} ${skill.name}`}
        >
          <Trash2 />
          {deleteLabel}
        </Button>
      </div>
    </li>
  );
}

type Viewing = { scope: SkillScope; name: string } | null;

/**
 * Settings → Agents → an agent → Skills: skills are folders of instructions the agent reads when a task fits. Its own
 * (in its folder, always on for it) and the shared ones (kept once, switched on per agent).
 */
export function SkillsTab({ agent }: { agent: Agent }) {
  const skills = useAgentSkills(agent.id);
  const enable = useEnableSkills(agent.id);
  const removeOwn = useDeleteSkill({ agentId: agent.id });
  const removeShared = useDeleteSkill({ shared: true });
  const [viewing, setViewing] = useState<Viewing>(null);
  const [deleting, setDeleting] = useState<{ shared: boolean; skill: Skill } | null>(null);

  if (skills.isError)
    return <ErrorNotice>Skills could not be read: {errorMessage(skills.error)}</ErrorNotice>;
  if (!skills.data)
    return (
      <div className="py-8">
        <Spinner className="mx-auto" />
      </div>
    );
  const { own, shared, enabled, missing } = skills.data;

  const toggle = (name: string, on: boolean) => {
    const next = on ? [...enabled, name] : enabled.filter((n) => n !== name);
    enable.mutate(next, {
      onSuccess: (saved) => toast(agentSavedMessage(agent, saved)),
      onError: (error) => toast.error(errorMessage(error, 'The change could not be saved.')),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-2xl text-sm text-[var(--text-muted)]">
        A skill is a folder with a SKILL.md that tells {agent.name} how to do something specific.{' '}
        {agent.name} sees each skill's name and description, and reads the instructions when a task
        fits.
      </p>

      <Panel
        title={`${agent.name}'s own skills`}
        description={`Kept in ${agent.name}'s folder, on for ${agent.name} only.`}
      >
        <div className="flex flex-col gap-4">
          {own.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">None yet.</p>
          ) : (
            <ul className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-xl border border-[var(--border-subtle)]">
              {own.map((skill) => (
                <SkillRow
                  key={skill.name}
                  skill={skill}
                  deleteLabel="Remove"
                  onView={() => setViewing({ scope: { agentId: agent.id }, name: skill.name })}
                  onDelete={() => setDeleting({ shared: false, skill })}
                />
              ))}
            </ul>
          )}
          <AddSkillButtons scope={{ agentId: agent.id }} label="" />
        </div>
      </Panel>

      <Panel
        title="Shared skills"
        description="Kept once for every agent. Switch on the ones this agent should use."
      >
        <div className="flex flex-col gap-4">
          {missing.length > 0 && (
            <ErrorNotice>
              {missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} switched on but not in the
              shared skills any more.
              <Button
                variant="secondary"
                size="sm"
                className="ml-2"
                disabled={enable.isPending}
                onClick={() =>
                  enable.mutate(
                    enabled.filter((name) => !missing.includes(name)),
                    {
                      onSuccess: (saved) => toast(agentSavedMessage(agent, saved)),
                      onError: (error) =>
                        toast.error(errorMessage(error, 'The change could not be saved.')),
                    },
                  )
                }
              >
                Remove missing skills
              </Button>
            </ErrorNotice>
          )}
          {shared.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">
              No shared skills yet. Add one below to use it with any agent.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-xl border border-[var(--border-subtle)]">
              {shared.map((skill) => (
                <SkillRow
                  key={skill.name}
                  skill={skill}
                  deleteLabel="Delete"
                  onView={() => setViewing({ scope: { shared: true }, name: skill.name })}
                  onDelete={() => setDeleting({ shared: true, skill })}
                  trailing={
                    <Switch
                      checked={skill.enabled}
                      disabled={enable.isPending || (Boolean(skill.problem) && !skill.enabled)}
                      aria-label={`Use ${skill.name}`}
                      onCheckedChange={(on) => toggle(skill.name, on)}
                    />
                  }
                />
              ))}
            </ul>
          )}
          <AddSkillButtons scope={{ shared: true }} label=" (for every agent)" />
        </div>
      </Panel>

      {viewing && (
        <SkillViewDialog
          scope={viewing.scope}
          name={viewing.name}
          onClose={() => setViewing(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={
            deleting.shared
              ? `Delete ${deleting.skill.name} for every agent?`
              : `Remove ${deleting.skill.name}?`
          }
          description={
            deleting.shared
              ? 'Its folder is deleted, and every agent that used it stops using it.'
              : `Its folder is deleted from ${agent.name}'s folder.`
          }
          action={deleting.shared ? 'Delete' : 'Remove'}
          what="This skill"
          onConfirm={() =>
            (deleting.shared ? removeShared : removeOwn).mutateAsync(deleting.skill.name)
          }
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

import { Link } from '@tanstack/react-router';
import { MessageSquarePlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { type Agent, errorMessage, type Team } from '~/api/client';
import { AgentAvatar } from '~/components/agent/agent-avatar';
import { ConfirmDialog, ErrorNotice, FIELD, Field, Optional } from '~/components/models/fields';
import { SettingsSection } from '~/components/settings/settings-layout';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { useAgents } from '~/hooks/use-agents';
import { useCreateTeam, useDeleteTeam, useTeams, useUpdateTeam } from '~/hooks/use-teams';
import { usePageTitle } from '~/lib/document-title';
import { listNames } from '~/lib/models';
import {
  MAX_TEAM_MEMBERS,
  memberCandidates,
  normalizeMembers,
  type TeamDraft,
  teamChanges,
  teamDraftProblem,
  toggleMember,
} from '~/lib/teams';
import { cn } from '~/lib/utils';

/** Making a team, or changing one: its name, lead, members, and whether members talk. */
function TeamDialog({
  team,
  agents,
  onClose,
}: {
  team: Team | null;
  agents: Agent[];
  onClose: () => void;
}) {
  const id = useId();
  const create = useCreateTeam();
  const update = useUpdateTeam();
  const known = useMemo(() => new Set(agents.map((agent) => agent.id)), [agents]);
  const [draft, setDraft] = useState<TeamDraft>(() => ({
    name: team?.name ?? '',
    description: team?.description ?? '',
    leadId: team?.leadId ?? agents[0]?.id ?? '',
    memberIds: team ? normalizeMembers(team.memberIds, team.leadId, known) : [],
    membersTalk: team?.membersTalk ?? false,
  }));
  const [tried, setTried] = useState(false);
  const problem = teamDraftProblem(draft);
  const busy = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const candidates = memberCandidates(agents, draft.leadId);
  const full = draft.memberIds.length >= MAX_TEAM_MEMBERS;

  const submit = () => {
    setTried(true);
    if (problem) return;
    const body = {
      ...draft,
      name: draft.name.trim(),
      description: draft.description.trim(),
      memberIds: normalizeMembers(draft.memberIds, draft.leadId),
    };
    const done = (saved: Team) => {
      toast(team ? `${saved.name} saved.` : `${saved.name} is ready.`);
      onClose();
    };
    if (team) {
      const changes = teamChanges(team, body);
      if (Object.keys(changes).length === 0) return onClose();
      update.mutate({ id: team.id, ...changes }, { onSuccess: done });
    } else create.mutate(body, { onSuccess: done });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{team ? `Edit ${team.name}` : 'New team'}</DialogTitle>
          <DialogDescription>
            You chat with the team's lead; it may ask the members for help. Each asked member
            answers in a conversation of its own.
          </DialogDescription>
        </DialogHeader>
        <form
          id={`${id}-form`}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field id={`${id}-name`} label="Name">
            <input
              id={`${id}-name`}
              maxLength={60}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="Research team"
              className={FIELD}
            />
          </Field>
          <Field
            id={`${id}-description`}
            label={
              <>
                Description <Optional />
              </>
            }
          >
            <input
              id={`${id}-description`}
              maxLength={500}
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              placeholder="Finds sources and writes them up"
              className={FIELD}
            />
          </Field>
          <Field
            id={`${id}-lead`}
            label="Lead"
            hint="The agent you chat with for the team. It may ask every member."
          >
            <select
              id={`${id}-lead`}
              value={draft.leadId}
              aria-describedby={`${id}-lead-hint`}
              onChange={(event) => {
                const leadId = event.target.value;
                // The new lead can't also be a member.
                setDraft({
                  ...draft,
                  leadId,
                  memberIds: normalizeMembers(draft.memberIds, leadId),
                });
              }}
              className={FIELD}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Field>
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-1.5 text-sm font-medium">
              Members{' '}
              <span className="font-normal text-[var(--text-muted)]">
                ({draft.memberIds.length} of at most {MAX_TEAM_MEMBERS})
              </span>
            </legend>
            {candidates.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                Make another agent first: a team needs at least one member besides its lead.
              </p>
            ) : (
              <ul className="flex max-h-60 flex-col gap-0.5 overflow-y-auto rounded-lg border border-[var(--border-subtle)] p-1">
                {candidates.map((agent) => {
                  const checked = draft.memberIds.includes(agent.id);
                  return (
                    <li key={agent.id}>
                      <label
                        className={cn(
                          'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--bg-control)]',
                          !checked && full && 'cursor-not-allowed opacity-50',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!checked && full}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              memberIds: toggleMember(
                                draft.memberIds,
                                agent.id,
                                event.target.checked,
                              ),
                            })
                          }
                          className="size-4 accent-[var(--accent)]"
                        />
                        <AgentAvatar agent={agent} size={20} frozen />
                        <span className="min-w-0 truncate">{agent.name}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
          <div className="flex items-start justify-between gap-6">
            <div>
              <p id={`${id}-talk-label`} className="text-sm font-medium">
                Members can ask each other
              </p>
              <p id={`${id}-talk-hint`} className="mt-1 text-xs text-[var(--text-muted)]">
                Otherwise only the lead asks; members just answer.
              </p>
            </div>
            <Switch
              checked={draft.membersTalk}
              onCheckedChange={(membersTalk) => setDraft({ ...draft, membersTalk })}
              aria-labelledby={`${id}-talk-label`}
              aria-describedby={`${id}-talk-hint`}
            />
          </div>
          {tried && problem && <ErrorNotice>{problem}</ErrorNotice>}
          {error && <ErrorNotice>{errorMessage(error)}</ErrorNotice>}
        </form>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={`${id}-form`} variant="primary" disabled={busy}>
            {busy && <Spinner className="size-4 text-current" />}
            {team ? 'Save' : 'Make team'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TeamRow({
  team,
  byId,
  onEdit,
  onDelete,
}: {
  team: Team;
  byId: Map<string, Agent>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const lead = byId.get(team.leadId);
  const members = team.memberIds.flatMap((memberId) => {
    const agent = byId.get(memberId);
    return agent ? [agent] : [];
  });
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      {lead ? (
        <AgentAvatar agent={lead} size={32} />
      ) : (
        <span className="size-8 shrink-0 rounded-full bg-[var(--bg-control)]" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{team.name}</p>
        {team.description && (
          <p className="truncate text-xs text-[var(--text-muted)]">{team.description}</p>
        )}
        <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
          Led by {lead?.name ?? 'an agent that is gone'}
          {members.length > 0 && (
            <>
              {' · with '}
              {listNames(
                members.map((member) => member.name),
                3,
              )}
            </>
          )}
          {team.membersTalk && (
            <span className="text-[var(--text-muted)]"> · members ask each other</span>
          )}
        </p>
      </div>
      {lead && (
        <Button
          variant="ghost"
          size="icon-sm"
          asChild
          aria-label={`New chat with ${team.name}`}
          title="New chat"
        >
          <Link to="/" search={{ agent: lead.id, team: team.id }}>
            <MessageSquarePlus />
          </Link>
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Edit ${team.name}`}
        title="Edit"
        onClick={onEdit}
      >
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete ${team.name}`}
        title="Delete"
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </li>
  );
}

/** Settings → Teams: agents grouped under a lead, who may ask its members. */
export function SettingsTeamsPage() {
  usePageTitle('Teams · Settings');
  const teams = useTeams();
  const agents = useAgents();
  const remove = useDeleteTeam();
  const [editing, setEditing] = useState<Team | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Team | null>(null);
  const byId = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent])),
    [agents.data],
  );

  if (teams.isError)
    return (
      <SettingsSection title="Teams" first>
        <ErrorNotice>{errorMessage(teams.error, 'The teams could not be loaded.')}</ErrorNotice>
      </SettingsSection>
    );
  if (!teams.data || !agents.data)
    return (
      <div className="py-12">
        <Spinner className="mx-auto" />
      </div>
    );
  const enoughAgents = agents.data.length >= 2;

  return (
    <>
      <SettingsSection title="Teams" first>
        <p className="-mt-2 text-sm text-[var(--text-muted)]">
          A team is a lead agent you chat with and members it may ask for help. What they say to
          each other is in each member's own conversations.
        </p>
        {teams.data.length > 0 && (
          <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
            {teams.data.map((team) => (
              <TeamRow
                key={team.id}
                team={team}
                byId={byId}
                onEdit={() => setEditing(team)}
                onDelete={() => setDeleting(team)}
              />
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            disabled={!enoughAgents}
            title={enoughAgents ? undefined : 'A team needs at least two agents.'}
            onClick={() => setEditing('new')}
          >
            <Plus />
            New team
          </Button>
          {!enoughAgents && (
            <p className="text-sm text-[var(--text-muted)]">
              A team needs at least two agents.{' '}
              <Link to="/settings/agents" className="text-[var(--accent-bright)] hover:underline">
                Make one
              </Link>
              .
            </p>
          )}
        </div>
      </SettingsSection>

      {editing && (
        <TeamDialog
          team={editing === 'new' ? null : editing}
          agents={agents.data}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          description="Its agents stay, with their conversations. Only the team goes."
          action="Delete"
          what={deleting.name}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toast(`${deleting.name} deleted.`);
          }}
        />
      )}
    </>
  );
}

import { useId, useState } from 'react';
import { type Agent, errorMessage } from '~/api/client';
import { Panel, SaveBar, saveAgentChange } from '~/components/agent-manager/panel';
import { SandboxPanel } from '~/components/agent-manager/sandbox-panel';
import { ErrorNotice, FIELD, Field } from '~/components/models/fields';
import { Switch } from '~/components/ui/switch';
import { useUpdateAgent } from '~/hooks/use-agents';
import {
  clampPlanSteps,
  formatToolList,
  MAX_PLAN_STEPS,
  MIN_PLAN_STEPS,
  parseToolList,
  readResearcherSettings,
  readTriageSettings,
} from '~/lib/kind-settings';
import { cn } from '~/lib/utils';

/** The settings of the agent's kind: triage's tools, researcher's plan; an assistant or coding agent has none. */
export function KindSettingsTab({ agent }: { agent: Agent }) {
  if (agent.agentKind === 'triage') return <TriageForm key={agent.revision} agent={agent} />;
  if (agent.agentKind === 'researcher')
    return <ResearcherForm key={agent.revision} agent={agent} />;
  if (agent.agentKind === 'coding')
    return (
      <div className="flex flex-col gap-4">
        <Panel>
          <p className="text-sm text-[var(--text-muted)]">
            A coding agent has no settings of its own. It uses the pi coding prompt and follows its
            project folder's AGENTS.md or CLAUDE.md. Set the folder in the Tools tab.
          </p>
        </Panel>
        <SandboxPanel agent={agent} />
      </div>
    );
  return (
    <Panel>
      <p className="text-sm text-[var(--text-muted)]">An assistant has no settings of its own.</p>
    </Panel>
  );
}

function useSaveKindSettings(agent: Agent) {
  const update = useUpdateAgent();
  return {
    update,
    save: (kindSettings: Record<string, unknown>) =>
      saveAgentChange(agent, () => update.mutateAsync({ id: agent.id, kindSettings })),
  };
}

function ToolListField({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field id={id} label={label} hint={hint}>
      <textarea
        id={id}
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={'github_list_issues\ngithub_*'}
        spellCheck={false}
        aria-describedby={`${id}-hint`}
        className={cn(FIELD, 'h-auto min-h-20 resize-y py-2 font-mono text-xs')}
      />
    </Field>
  );
}

function TriageForm({ agent }: { agent: Agent }) {
  const id = useId();
  const saved = readTriageSettings(agent.kindSettings);
  const initial = {
    listTools: formatToolList(saved.listTools),
    readTools: formatToolList(saved.readTools),
    writeTools: formatToolList(saved.writeTools),
    approveWrites: saved.approveWrites,
  };
  const [form, setForm] = useState(initial);
  const { update, save } = useSaveKindSettings(agent);
  const next = {
    listTools: parseToolList(form.listTools),
    readTools: parseToolList(form.readTools),
    writeTools: parseToolList(form.writeTools),
    approveWrites: form.approveWrites,
  };
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);

  return (
    <Panel
      title="Triage"
      description="The MCP tools it uses for each step, one per line (a * matches any characters). Tools not named here are refused."
    >
      <div className="flex flex-col gap-4">
        <ToolListField
          id={`${id}-list`}
          label="List tools"
          hint="List new or open items."
          value={form.listTools}
          onChange={(listTools) => setForm({ ...form, listTools })}
        />
        <ToolListField
          id={`${id}-read`}
          label="Read tools"
          hint="Read one item: its body, comments, labels."
          value={form.readTools}
          onChange={(readTools) => setForm({ ...form, readTools })}
        />
        <ToolListField
          id={`${id}-write`}
          label="Write tools"
          hint="Comment, label, close."
          value={form.writeTools}
          onChange={(writeTools) => setForm({ ...form, writeTools })}
        />
        <div className="flex items-start justify-between gap-6">
          <div>
            <p id={`${id}-approve-label`} className="text-sm font-medium">
              Ask before writing
            </p>
            <p id={`${id}-approve-hint`} className="mt-1 text-xs text-[var(--text-muted)]">
              Every write tool waits for your approval.
            </p>
          </div>
          <Switch
            checked={form.approveWrites}
            onCheckedChange={(approveWrites) => setForm({ ...form, approveWrites })}
            aria-labelledby={`${id}-approve-label`}
            aria-describedby={`${id}-approve-hint`}
          />
        </div>
        {update.error && <ErrorNotice>{errorMessage(update.error)}</ErrorNotice>}
        <SaveBar
          dirty={dirty}
          busy={update.isPending}
          onSave={() => save({ ...next })}
          onReset={() => {
            setForm(initial);
            update.reset();
          }}
        />
      </div>
    </Panel>
  );
}

function ResearcherForm({ agent }: { agent: Agent }) {
  const id = useId();
  const saved = readResearcherSettings(agent.kindSettings);
  const [background, setBackground] = useState(saved.backgroundSubagents);
  const [steps, setSteps] = useState(String(saved.maxPlanSteps));
  const { update, save } = useSaveKindSettings(agent);
  const parsed = Number(steps);
  const validSteps =
    steps.trim() !== '' &&
    Number.isInteger(parsed) &&
    parsed >= MIN_PLAN_STEPS &&
    parsed <= MAX_PLAN_STEPS;
  const dirty =
    background !== saved.backgroundSubagents || (validSteps && parsed !== saved.maxPlanSteps);

  return (
    <Panel title="Researcher" description="How it plans and carries out research.">
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p id={`${id}-bg-label`} className="text-sm font-medium">
              Research in the background
            </p>
            <p id={`${id}-bg-hint`} className="mt-1 text-xs text-[var(--text-muted)]">
              Each step runs in a subagent, so the conversation stays free while it works.
            </p>
          </div>
          <Switch
            checked={background}
            onCheckedChange={setBackground}
            aria-labelledby={`${id}-bg-label`}
            aria-describedby={`${id}-bg-hint`}
          />
        </div>
        <Field
          id={`${id}-steps`}
          label="Most steps in a plan"
          hint={
            validSteps
              ? `${MIN_PLAN_STEPS} to ${MAX_PLAN_STEPS}.`
              : `Enter a whole number from ${MIN_PLAN_STEPS} to ${MAX_PLAN_STEPS}.`
          }
        >
          <input
            id={`${id}-steps`}
            type="number"
            inputMode="numeric"
            min={MIN_PLAN_STEPS}
            max={MAX_PLAN_STEPS}
            step={1}
            value={steps}
            onChange={(event) => setSteps(event.target.value)}
            onBlur={() => {
              if (steps.trim() !== '' && Number.isFinite(parsed))
                setSteps(String(clampPlanSteps(parsed)));
            }}
            aria-invalid={!validSteps || undefined}
            aria-describedby={`${id}-steps-hint`}
            className={cn(FIELD, 'w-28')}
          />
        </Field>
        {update.error && <ErrorNotice>{errorMessage(update.error)}</ErrorNotice>}
        <SaveBar
          dirty={dirty}
          busy={update.isPending}
          disabled={!validSteps}
          onSave={() => save({ backgroundSubagents: background, maxPlanSteps: parsed })}
          onReset={() => {
            setBackground(saved.backgroundSubagents);
            setSteps(String(saved.maxPlanSteps));
            update.reset();
          }}
        />
      </div>
    </Panel>
  );
}

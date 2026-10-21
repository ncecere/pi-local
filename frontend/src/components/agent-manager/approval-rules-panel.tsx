import { useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { type Agent, type ApprovalRule, errorMessage } from '~/api/client';
import { Panel } from '~/components/agent-manager/panel';
import { ErrorNotice, FIELD, Field } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import { AGENTS_KEY, useUpdateAgent } from '~/hooks/use-agents';
import { useAddApprovalRule, useRemoveApprovalRule } from '~/hooks/use-approvals';
import {
  actionLabel,
  approvalPatternsError,
  describeRule,
  readToolSettings,
} from '~/lib/approvals';

/** Rules save independently and reach a running agent without a restart. */
export function ApprovalRulesPanel({ agent }: { agent: Agent }) {
  const id = useId();
  const cache = useQueryClient();
  const add = useAddApprovalRule();
  const remove = useRemoveApprovalRule();
  const update = useUpdateAgent();
  const { rules, builtinRules } = readToolSettings(agent).approvals;
  const [editing, setEditing] = useState<ApprovalRule | 'new' | null>(null);
  const [tool, setTool] = useState('bash');
  const [action, setAction] = useState<ApprovalRule['action']>('allow');
  const [args, setArgs] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const busy = add.isPending || remove.isPending || update.isPending;
  const currentRules = () =>
    cache.getQueryData<Agent[]>(AGENTS_KEY)?.find((a) => a.id === agent.id)?.approvals?.rules ??
    rules;
  const saveRules = (next: ApprovalRule[]) => {
    // The contract replaces tools and timeout when approvals is sent. Keep both,
    // even for a rules-only edit, so remembering a command never disables asking.
    const latest = cache.getQueryData<Agent[]>(AGENTS_KEY)?.find((a) => a.id === agent.id) ?? agent;
    const policy = readToolSettings(latest).approvals;
    return update.mutateAsync({
      id: agent.id,
      approvals: { rules: next, tools: policy.tools, timeoutSeconds: policy.timeoutSeconds },
    });
  };
  const open = (rule: ApprovalRule | 'new') => {
    setEditing(rule);
    setTool(rule === 'new' ? 'bash' : rule.tool);
    setAction(rule === 'new' ? 'allow' : rule.action);
    setArgs(
      rule === 'new'
        ? ''
        : Object.entries(rule.args ?? {})
            .map(([key, value]) => `${key}=${value}`)
            .join('\n'),
    );
    setProblem(null);
  };
  const submit = async () => {
    const patternsProblem = approvalPatternsError([tool.trim()]);
    if (patternsProblem) return setProblem(patternsProblem);
    const parsed: Record<string, string> = {};
    for (const line of args.split('\n').filter((line) => line.trim())) {
      const equals = line.indexOf('=');
      const name = line.slice(0, equals).trim();
      const value = line.slice(equals + 1);
      if (equals < 1 || !name || !value || value.length > 500 || name in parsed)
        return setProblem(
          'Use one argument=pattern per line, with unique names and a nonempty pattern (up to 500 characters).',
        );
      parsed[name] = value;
    }
    if (Object.keys(parsed).length > 10) return setProblem('At most 10 argument patterns.');
    const body = {
      tool: tool.trim(),
      action,
      ...(Object.keys(parsed).length ? { args: parsed } : {}),
    };
    try {
      if (editing && editing !== 'new')
        await saveRules(
          currentRules().map((rule) => (rule.id === editing.id ? { id: rule.id, ...body } : rule)),
        );
      else await add.mutateAsync({ agentId: agent.id, ...body });
      setEditing(null);
      toast('Rule saved. It applies now.');
    } catch (error) {
      setProblem(errorMessage(error));
    }
  };
  const removeRule = async (rule: ApprovalRule) => {
    const index = rules.findIndex((candidate) => candidate.id === rule.id);
    try {
      await remove.mutateAsync({ agentId: agent.id, ruleId: rule.id });
      toast('Rule removed.', {
        action: {
          label: 'Undo',
          onClick: () => {
            const next = currentRules().filter((candidate) => candidate.id !== rule.id);
            next.splice(Math.min(index, next.length), 0, rule);
            void saveRules(next).then(
              () => toast('Rule restored.'),
              (error) => toast.error(errorMessage(error)),
            );
          },
        },
      });
    } catch (error) {
      setProblem(errorMessage(error));
    }
  };
  const row = (rule: ApprovalRule, locked: boolean) => (
    <li
      key={rule.id}
      data-approval-rule={rule.id}
      className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs"
    >
      <span>{actionLabel(rule.action)}</span>
      <code className="min-w-0 flex-1 break-all">{describeRule(rule)}</code>
      {locked ? (
        <span className="inline-flex items-center gap-1">
          <Lock className="size-3" />
          Built in
        </span>
      ) : (
        <>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={`Edit the rule: ${describeRule(rule)}`}
            onClick={() => open(rule)}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={`Remove the rule: ${actionLabel(rule.action)} ${describeRule(rule)}`}
            onClick={() => void removeRule(rule)}
          >
            Remove
          </Button>
        </>
      )}
    </li>
  );
  return (
    <Panel
      title="Approval rules"
      description="The first matching rule decides, before the profile. Built-in rules always ask, even when your rule allows a call."
    >
      <div className="space-y-4">
        <h3 className="text-sm font-medium">Your rules</h3>
        {rules.length ? (
          <ul className="space-y-2">{rules.map((rule) => row(rule, false))}</ul>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">
            No rules yet. Add one here or remember a call when approving it.
          </p>
        )}
        {!editing && (
          <Button size="sm" variant="secondary" onClick={() => open('new')}>
            Add rule
          </Button>
        )}
        {editing && (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <h4 className="text-sm font-medium">{editing === 'new' ? 'Add rule' : 'Edit rule'}</h4>
            <Field id={`${id}-tool`} label="Tool name or pattern">
              <input
                id={`${id}-tool`}
                className={FIELD}
                value={tool}
                onChange={(event) => setTool(event.target.value)}
              />
            </Field>
            <Field id={`${id}-action`} label="Decision">
              <select
                id={`${id}-action`}
                className={FIELD}
                value={action}
                onChange={(event) => setAction(event.target.value as ApprovalRule['action'])}
              >
                <option value="allow">Allow</option>
                <option value="ask">Ask first</option>
                <option value="deny">Deny</option>
              </select>
            </Field>
            <Field
              id={`${id}-args`}
              label="Argument patterns (optional)"
              hint="One name=pattern per line, for example command=git status *. A star matches any characters. Leave empty for every call to this tool. Allow rules never cover compound shell commands or parent-directory paths."
            >
              <textarea
                id={`${id}-args`}
                className={`${FIELD} h-auto py-2 font-mono`}
                rows={3}
                value={args}
                onChange={(event) => setArgs(event.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" size="sm" variant="primary" disabled={busy}>
                Save rule
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {problem && <ErrorNotice>{problem}</ErrorNotice>}
        {builtinRules.length > 0 && (
          <>
            <h3 className="text-sm font-medium">Built in</h3>
            <ul className="space-y-2">{builtinRules.map((rule) => row(rule, true))}</ul>
          </>
        )}
      </div>
    </Panel>
  );
}

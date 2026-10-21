import { TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { type Agent, ApiError, errorMessage } from '~/api/client';
import { Panel, SaveBar, saveAgentChange } from '~/components/agent-manager/panel';
import { ErrorNotice, FIELD } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useAgentConfig, usePutAgentConfig } from '~/hooks/use-agent-manager';
import { cn } from '~/lib/utils';

/**
 * The server's reason a text can't be saved (bad YAML, or a setting there is
 * no such thing as), without the file name the notice already says.
 */
export function yamlProblem(message: string): string {
  return message.replace(/^agent\.yaml:\s*/i, '');
}

/** The agent's agent.yaml, as text: saving replaces its whole configuration. */
export function ConfigTab({ agent }: { agent: Agent }) {
  const config = useAgentConfig(agent.id, agent.revision);
  if (config.isPending)
    return (
      <div className="py-12">
        <Spinner className="mx-auto" />
      </div>
    );
  if (config.isError)
    return (
      <Panel>
        <ErrorNotice>{errorMessage(config.error, 'agent.yaml could not be read.')}</ErrorNotice>
        <Button type="button" variant="ghost" className="mt-3" onClick={() => config.refetch()}>
          Try again
        </Button>
      </Panel>
    );
  return <ConfigEditor key={config.dataUpdatedAt} agent={agent} yaml={config.data.yaml} />;
}

function ConfigEditor({ agent, yaml }: { agent: Agent; yaml: string }) {
  const id = useId();
  const [text, setText] = useState(yaml);
  const put = usePutAgentConfig(agent.id);
  const dirty = text !== yaml;
  const invalid = put.error instanceof ApiError && put.error.code === 'invalid_yaml';

  return (
    <Panel
      title="agent.yaml"
      description="Its whole configuration as the file on disk has it. The other tabs edit the same file."
    >
      <div className="flex flex-col gap-3">
        <p
          id={`${id}-warning`}
          className="flex items-start gap-2 rounded-lg bg-[var(--warning)]/10 px-3 py-2 text-sm text-[var(--warning)]"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Saving replaces the agent's configuration with this text
          {agent.running ? ' and restarts it' : ''}. Anything left out is gone.
        </p>
        <label htmlFor={`${id}-yaml`} className="sr-only">
          agent.yaml
        </label>
        <textarea
          id={`${id}-yaml`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          rows={22}
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-warning${put.error ? ` ${id}-error` : ''}`}
          className={cn(
            FIELD,
            'h-auto min-h-96 resize-y whitespace-pre py-2 font-mono text-xs leading-relaxed',
            invalid && 'border-[var(--danger)]',
          )}
        />
        {put.error && (
          <div id={`${id}-error`}>
            <ErrorNotice>
              {invalid ? (
                <>
                  <span className="font-medium">Can't save this agent.yaml: </span>
                  <span className="font-mono text-xs">{yamlProblem(put.error.message)}</span>
                </>
              ) : (
                errorMessage(put.error)
              )}
            </ErrorNotice>
          </div>
        )}
        <SaveBar
          dirty={dirty}
          busy={put.isPending}
          saveLabel="Replace configuration"
          onSave={() => saveAgentChange(agent, () => put.mutateAsync(text))}
          onReset={() => {
            setText(yaml);
            put.reset();
          }}
        />
      </div>
    </Panel>
  );
}

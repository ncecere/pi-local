import { useState } from 'react';
import { errorMessage } from '~/api/client';
import { SettingsSection } from '~/components/settings/settings-layout';
import { Spinner } from '~/components/ui/spinner';
import {
  DailyBars,
  RangePicker,
  Stat,
  StatStrip,
  TotalsStats,
  UsageTable,
  whole,
} from '~/components/usage/usage-parts';
import { useUsage } from '~/hooks/use-usage';
import { usePageTitle } from '~/lib/document-title';
import { byUse, fillDays, type UsageRange } from '~/lib/usage';
import { cn } from '~/lib/utils';

/** What the agents asked of their models: requests, tokens and an estimated cost. */
export function SettingsUsagePage() {
  usePageTitle('Usage · Settings');
  const [days, setDays] = useState<UsageRange>(30);
  const usage = useUsage(days);
  const data = usage.data;

  return (
    <SettingsSection title="Usage" first>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-[var(--text-muted)]">
          How much your agents use their models: requests, tokens and a cost estimated from the
          prices set in Settings → Models. Days are in this computer's time zone.
        </p>
        <RangePicker value={days} onChange={setDays} />
      </div>
      {usage.isError && !data ? (
        <p
          role="alert"
          className="rounded-xl bg-[var(--danger)]/15 px-4 py-3 text-sm text-[var(--danger-on-tint)]"
        >
          Usage could not be read: {errorMessage(usage.error)}
        </p>
      ) : !data ? (
        <div className="py-12">
          <Spinner className="mx-auto" />
        </div>
      ) : (
        <div
          aria-busy={usage.isPlaceholderData}
          className={cn('space-y-8', usage.isPlaceholderData && 'opacity-60')}
        >
          <StatStrip>
            <TotalsStats total={data.total} />
            <Stat
              label="Agents"
              value={whole.format(data.agents.length)}
              hint="used in this period"
            />
          </StatStrip>
          {data.total.unpricedRequests > 0 && (
            <p className="-mt-4 text-xs text-[var(--text-muted)]">
              The cost doesn't include {whole.format(data.total.unpricedRequests)} unpriced
              requests: requests to models without prices. Set a model's prices in Settings → Models
              to count them.
            </p>
          )}
          <section aria-labelledby="usage-days">
            <h3 id="usage-days" className="mb-3 text-base font-semibold">
              Tokens per day
            </h3>
            <DailyBars
              days={fillDays(data.byDay, data.from, data.to)}
              from={data.from}
              to={data.to}
            />
          </section>
          <section aria-labelledby="usage-agents">
            <h3 id="usage-agents" className="mb-3 text-base font-semibold">
              By agent
            </h3>
            {data.agents.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                Your agents haven't been used in these {days} days.
              </p>
            ) : (
              <UsageTable label="Agent" rows={byUse(data.agents)} rowKey={(row) => row.agentId} />
            )}
          </section>
          <section aria-labelledby="usage-models">
            <h3 id="usage-models" className="mb-3 text-base font-semibold">
              By model
            </h3>
            {data.models.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                No models have been used in these {days} days.
              </p>
            ) : (
              <UsageTable
                label="Model"
                rows={byUse(data.models)}
                rowKey={(row) => row.modelId}
                detail={(row) => (row.name !== row.modelId ? row.modelId : undefined)}
              />
            )}
          </section>
        </div>
      )}
    </SettingsSection>
  );
}

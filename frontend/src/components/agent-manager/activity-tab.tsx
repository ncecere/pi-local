import type { Agent } from '~/api/client';
import { ActivityList } from '~/components/activity/activity-list';
import { Panel } from '~/components/agent-manager/panel';

/** An agent's activity: the tools it called and everything else that happened to it. */
export function ActivityTab({ agent }: { agent: Agent }) {
  return (
    <Panel
      title="Activity"
      description={`What ${agent.name} did and what was done to it, newest first. Kept for 90 days.`}
    >
      <ActivityList agentId={agent.id} />
    </Panel>
  );
}

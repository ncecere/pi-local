import type { AgentTemplate, TemplateCategory, WebTools } from '~/api/types';
import { describeCron } from '~/lib/schedules';

/**
 * The New agent gallery: templates grouped by category, and what each one
 * brings, as short chips.
 */

export const CATEGORY_ORDER: TemplateCategory[] = ['everyday', 'work', 'life', 'meta', 'yours'];

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  everyday: 'Everyday',
  work: 'Work',
  life: 'Life',
  meta: 'Helpers',
  yours: 'Yours',
};

export interface TemplateGroup {
  category: TemplateCategory;
  label: string;
  templates: AgentTemplate[];
}

/** The templates by category, in the gallery's order, empty groups left out. Unknown categories go under Everyday. */
export function groupTemplates(templates: readonly AgentTemplate[]): TemplateGroup[] {
  const known = (category: string): TemplateCategory =>
    CATEGORY_ORDER.includes(category as TemplateCategory)
      ? (category as TemplateCategory)
      : 'everyday';
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    templates: templates.filter((template) => known(template.category) === category),
  })).filter((group) => group.templates.length > 0);
}

/** The web tools an agent made from it gets: a template that says nothing gets both. */
export function templateWeb(template: Pick<AgentTemplate, 'web'>): WebTools {
  return template.web ?? { search: true, fetch: true };
}

/** "weekdays 7:30", "daily 8:00", or the cron in words ("every Monday at 09:00"). */
export function shortSchedule(cron: string): string {
  const words = describeCron(cron);
  if (!words) return cron;
  const time = (text: string) => text.replace(/\b0(\d):/g, '$1:');
  const weekdays = /^Every weekday at (.+)$/.exec(words);
  if (weekdays) return `weekdays ${time(weekdays[1]!)}`;
  const daily = /^Every day at (.+)$/.exec(words);
  if (daily) return `daily ${time(daily[1]!)}`;
  return time(words.charAt(0).toLowerCase() + words.slice(1));
}

/** Whether `tool` asks first under these approval names or patterns (`*` matches anything). */
function asksFirst(tool: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const regex = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    );
    return regex.test(tool);
  });
}

/** What an agent made from the template gets, in a few words each. */
export function templateChips(template: AgentTemplate): string[] {
  const chips: string[] = [];
  const web = templateWeb(template);
  if (web.search || web.fetch) chips.push('Web');
  const tools = template.workspace?.tools ?? [];
  if (tools.some((tool) => tool === 'read' || tool === 'write' || tool === 'edit'))
    chips.push('Files');
  if (tools.includes('bash'))
    chips.push(
      asksFirst('bash', template.approvals?.tools ?? [])
        ? 'Runs commands (asks first)'
        : 'Runs commands',
    );
  if (template.schedule) chips.push(`Schedule: ${shortSchedule(template.schedule.cron)}`);
  if (template.schedules?.agentMade) chips.push('Sets its own reminders');
  if ((template.mcp?.length ?? 0) > 0) chips.push('Uses your connected apps');
  return chips;
}

/** It works best with a web search service set up. */
export const needsWebSearch = (template: Pick<AgentTemplate, 'needs'>) =>
  template.needs?.includes('web-search') ?? false;

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

/**
 * "weekdays 7:30 AM", "daily 8:00 AM", or the cron in words ("every Monday at
 * 9:00 AM"); times in the system's hour style.
 */
export function shortSchedule(cron: string, locale?: string): string {
  const words = describeCron(cron, locale);
  if (!words) return cron;
  const weekdays = /^Every weekday at (.+)$/.exec(words);
  if (weekdays) return `weekdays ${weekdays[1]!}`;
  const daily = /^Every day at (.+)$/.exec(words);
  if (daily) return `daily ${daily[1]!}`;
  return words.charAt(0).toLowerCase() + words.slice(1);
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

/** One thing an agent made from the template gets: a few words, and a sentence for its tooltip. */
export interface TemplateChip {
  label: string;
  /** "Web: can search the web and read pages". */
  title: string;
}

/** What an agent made from the template gets, each with what it means. */
export function templateChipDetails(template: AgentTemplate, locale?: string): TemplateChip[] {
  const chips: TemplateChip[] = [];
  const web = templateWeb(template);
  if (web.search || web.fetch)
    chips.push({
      label: 'Web',
      title: `Web: can ${
        web.search && web.fetch
          ? 'search the web and read pages'
          : web.search
            ? 'search the web'
            : 'read web pages'
      }`,
    });
  const tools = template.workspace?.tools ?? [];
  if (tools.some((tool) => tool === 'read' || tool === 'write' || tool === 'edit'))
    chips.push({
      label: 'Files',
      title: tools.some((tool) => tool === 'write' || tool === 'edit')
        ? 'Files: can read and change files in its project folder'
        : 'Files: can read files in its project folder',
    });
  if (tools.includes('bash')) {
    const asks = asksFirst('bash', template.approvals?.tools ?? []);
    chips.push({
      label: asks ? 'Runs commands (asks first)' : 'Runs commands',
      title: asks
        ? 'Runs commands: can run commands on this computer, and asks you before each one'
        : 'Runs commands: can run commands on this computer without asking you',
    });
  }
  if (template.schedule) {
    const when = shortSchedule(template.schedule.cron, locale);
    chips.push({
      label: `Schedule: ${when}`,
      title: `Schedule: starts a conversation by itself, ${when}`,
    });
  }
  if (template.schedules?.agentMade)
    chips.push({
      label: 'Sets its own reminders',
      title: 'Sets its own reminders: can schedule itself to run later',
    });
  if ((template.mcp?.length ?? 0) > 0)
    chips.push({
      label: 'Uses your connected apps',
      title: 'Uses your connected apps: can use the tools of the apps you connected (MCP servers)',
    });
  return chips;
}

/** What an agent made from the template gets, in a few words each. */
export const templateChips = (template: AgentTemplate, locale?: string): string[] =>
  templateChipDetails(template, locale).map((chip) => chip.label);

/** It works best with a web search service set up. */
export const needsWebSearch = (template: Pick<AgentTemplate, 'needs'>) =>
  template.needs?.includes('web-search') ?? false;

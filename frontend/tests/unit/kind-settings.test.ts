import { describe, expect, it } from 'vitest';
import {
  clampPlanSteps,
  formatToolList,
  hasKindSettings,
  parseToolList,
  readResearcherSettings,
  readTriageSettings,
} from '../../src/lib/kind-settings.ts';

describe('kind settings', () => {
  it("reads triage settings with the runtime's defaults", () => {
    expect(readTriageSettings({})).toEqual({
      listTools: [],
      readTools: [],
      writeTools: [],
      approveWrites: true,
    });
    expect(
      readTriageSettings({ listTools: ['gh_list', 3], approveWrites: false, writeTools: 'x' }),
    ).toEqual({ listTools: ['gh_list'], readTools: [], writeTools: [], approveWrites: false });
  });

  it("reads researcher settings with the runtime's defaults, steps kept within 1-20", () => {
    expect(readResearcherSettings(undefined)).toEqual({
      backgroundSubagents: true,
      maxPlanSteps: 8,
    });
    expect(readResearcherSettings({ backgroundSubagents: false, maxPlanSteps: 40 })).toEqual({
      backgroundSubagents: false,
      maxPlanSteps: 20,
    });
    expect(readResearcherSettings({ maxPlanSteps: 2.5 }).maxPlanSteps).toBe(8);
    expect(clampPlanSteps(0)).toBe(1);
  });

  it('parses tool lists typed one per line or with commas', () => {
    expect(parseToolList(' github_* ,\n\ngithub_get_issue\ngithub_*\n')).toEqual([
      'github_*',
      'github_get_issue',
    ]);
    expect(formatToolList(['a', 'b'])).toBe('a\nb');
  });

  it('has settings for triage and researcher only', () => {
    expect(hasKindSettings('triage')).toBe(true);
    expect(hasKindSettings('researcher')).toBe(true);
    expect(hasKindSettings('assistant')).toBe(false);
  });
});

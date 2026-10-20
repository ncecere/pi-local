import { describe, expect, it } from 'vitest';
import type { Team } from '../../src/api/types.ts';
import {
  applyTeamEvent,
  chattableTeams,
  MAX_TEAM_MEMBERS,
  memberCandidates,
  normalizeMembers,
  type TeamDraft,
  teamChanges,
  teamChatLabel,
  teamDraftProblem,
  toggleMember,
} from '../../src/lib/teams.ts';

const team = (id: string, extra: Partial<Team> = {}): Team => ({
  id,
  name: `Team ${id}`,
  description: '',
  leadId: 'ag_lead',
  memberIds: ['ag_a', 'ag_b'],
  membersTalk: false,
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
  ...extra,
});

const draft = (extra: Partial<TeamDraft> = {}): TeamDraft => ({
  name: 'Research',
  description: '',
  leadId: 'ag_lead',
  memberIds: ['ag_a'],
  membersTalk: false,
  ...extra,
});

describe('team member selection', () => {
  it('offers everyone but the lead as a member', () => {
    const agents = [{ id: 'ag_lead' }, { id: 'ag_a' }, { id: 'ag_b' }];
    expect(memberCandidates(agents, 'ag_lead').map((a) => a.id)).toEqual(['ag_a', 'ag_b']);
  });

  it('drops the lead, repeats and unknown agents from the members, keeping the order', () => {
    expect(
      normalizeMembers(
        ['ag_b', 'ag_lead', 'ag_a', 'ag_b', 'ag_gone', ''],
        'ag_lead',
        new Set(['ag_a', 'ag_b', 'ag_lead']),
      ),
    ).toEqual(['ag_b', 'ag_a']);
  });

  it('removes a member who becomes the lead', () => {
    expect(normalizeMembers(['ag_a', 'ag_b'], 'ag_a')).toEqual(['ag_b']);
  });

  it('adds and removes members, never past the limit', () => {
    expect(toggleMember(['ag_a'], 'ag_b', true)).toEqual(['ag_a', 'ag_b']);
    expect(toggleMember(['ag_a', 'ag_b'], 'ag_a', false)).toEqual(['ag_b']);
    expect(toggleMember(['ag_a'], 'ag_a', true)).toEqual(['ag_a']);
    const full = Array.from({ length: MAX_TEAM_MEMBERS }, (_, i) => `ag_${i}`);
    expect(toggleMember(full, 'ag_new', true)).toEqual(full);
  });
});

describe('teamDraftProblem', () => {
  it('accepts a named team with a lead and a member', () => {
    expect(teamDraftProblem(draft())).toBeNull();
  });

  it('needs a one-line name of at most 60 characters', () => {
    expect(teamDraftProblem(draft({ name: '  ' }))).toMatch(/name/);
    expect(teamDraftProblem(draft({ name: 'x'.repeat(61) }))).toMatch(/60/);
    expect(teamDraftProblem(draft({ name: 'a\nb' }))).toMatch(/one line/);
  });

  it('needs a lead and a member besides it', () => {
    expect(teamDraftProblem(draft({ leadId: '' }))).toMatch(/lead/);
    expect(teamDraftProblem(draft({ memberIds: [] }))).toMatch(/member/);
    expect(teamDraftProblem(draft({ memberIds: ['ag_lead'] }))).toMatch(/member/);
  });

  it('allows at most 20 members', () => {
    const many = Array.from({ length: MAX_TEAM_MEMBERS + 1 }, (_, i) => `ag_${i}`);
    expect(teamDraftProblem(draft({ memberIds: many }))).toMatch(/20/);
  });
});

describe('teamChanges', () => {
  it('sends only what changed', () => {
    const before = team('tm_1', { name: 'Research', memberIds: ['ag_a'] });
    expect(teamChanges(before, draft())).toEqual({});
    expect(teamChanges(before, draft({ name: ' New ', membersTalk: true }))).toEqual({
      name: 'New',
      membersTalk: true,
    });
    expect(teamChanges(before, draft({ memberIds: ['ag_a', 'ag_b'] }))).toEqual({
      memberIds: ['ag_a', 'ag_b'],
    });
  });

  it('sends the members again when the new lead was one', () => {
    const before = team('tm_1', { name: 'Research', memberIds: ['ag_a', 'ag_b'] });
    expect(teamChanges(before, draft({ leadId: 'ag_a', memberIds: ['ag_a', 'ag_b'] }))).toEqual({
      leadId: 'ag_a',
      memberIds: ['ag_b'],
    });
  });
});

describe('applyTeamEvent', () => {
  const list = [team('tm_1'), team('tm_2')];

  it('changes a team in place, adds a new one at the end, and removes a deleted one', () => {
    expect(applyTeamEvent(list, 'tm_1', team('tm_1', { name: 'X' }))?.[0]?.name).toBe('X');
    expect(applyTeamEvent(list, 'tm_3', team('tm_3'))?.map((t) => t.id)).toEqual([
      'tm_1',
      'tm_2',
      'tm_3',
    ]);
    expect(applyTeamEvent(list, 'tm_1', null)?.map((t) => t.id)).toEqual(['tm_2']);
  });

  it('leaves a list never loaded alone', () => {
    expect(applyTeamEvent(undefined, 'tm_1', team('tm_1'))).toBeUndefined();
  });
});

describe('chatting with a team', () => {
  it('names the team and its lead', () => {
    expect(teamChatLabel({ name: 'Research team' }, { name: 'Ada' })).toBe('Research team · Ada');
    expect(teamChatLabel({ name: 'Research team' }, undefined)).toBe('Research team');
  });

  it('offers only teams whose lead can be chatted with', () => {
    const teams = [team('tm_1'), team('tm_2', { leadId: 'ag_off' })];
    expect(chattableTeams(teams, [{ id: 'ag_lead' }]).map((t) => t.id)).toEqual(['tm_1']);
    expect(chattableTeams(undefined, [{ id: 'ag_lead' }])).toEqual([]);
  });
});

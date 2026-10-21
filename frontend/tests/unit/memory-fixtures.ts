import type { Agent, Basics, Fact, YouInfo } from '../../src/api/client';

/** Shared fixtures for the memory tests. */

export function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'ag_rex',
    name: 'Rex',
    description: 'Finds papers',
    instructions: '',
    kind: 'personal',
    agentKind: 'assistant',
    status: 'asleep',
    running: false,
    model: null,
    enabled: true,
    lastUsedAt: null,
    revision: 3,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    kindSettings: {},
    canCall: [],
    callable: [],
    dir: '/data/agents/ag_rex',
    piDurableVersion: null,
    workspace: { tools: [], folder: '', dir: '/data/agents/ag_rex/workspace' },
    approvals: { tools: [], timeoutSeconds: 3600 },
    mcp: [],
    web: { search: false, fetch: true },
    memory: { off: false, share: [] },
    ...overrides,
  };
}

export const CATEGORIES = [
  'preferences',
  'people',
  'projects',
  'work',
  'health',
  'family',
  'finances',
  'home',
  'interests',
];
export const SHAREABLE = CATEGORIES.slice(1);

export const basics = (change: Partial<Basics> = {}): Basics => ({
  name: 'Ada Lovelace',
  role: '',
  organization: '',
  timezone: 'Europe/London',
  language: 'English',
  addressAs: 'Ada',
  answerStyle: '',
  signOff: '',
  ...change,
});

export const you = (change: Partial<YouInfo> = {}): YouInfo => ({
  basics: basics(),
  saved: false,
  categories: CATEGORIES,
  shareable: SHAREABLE,
  ...change,
});

export const fact = (change: Partial<Fact> = {}): Fact => ({
  id: 'um_k1',
  category: 'preferences',
  text: 'Prefers short answers',
  trust: 'said',
  status: 'active',
  pinned: false,
  sourceAgent: null,
  sourceThread: null,
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_000_000,
  ...change,
});

// A throwaway in-memory stand-in for the Go backend's /api, enough to look at
// Settings → Models, Agents and Usage without it (docs/api.md). Development only.
//
//   node dev/fake-models-api.mjs            # listens on 127.0.0.1:5198
//   PI_LOCAL_API=http://127.0.0.1:5198 PORT=5197 pnpm dev
import { createServer } from 'node:http';

const port = Number(process.env.FAKE_API_PORT ?? 5198);
const now = () => new Date().toISOString();

const kinds = [
  {
    id: 'openai',
    name: 'OpenAI',
    api: 'openai-completions',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI-compatible',
    api: 'openai-completions',
    defaultBaseUrl: null,
  },
  {
    id: 'openai-responses',
    name: 'OpenAI Responses',
    api: 'openai-responses',
    defaultBaseUrl: null,
  },
  {
    id: 'anthropic-compatible',
    name: 'Anthropic-compatible',
    api: 'anthropic-messages',
    defaultBaseUrl: null,
  },
];
const presets = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    note: 'GPT models, with an API key from platform.openai.com.',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    needsKey: true,
    note: 'Claude models, with a key from console.anthropic.com.',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    note: 'Models running on this computer.',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    needsKey: false,
    note: "LM Studio's local server.",
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    note: 'Hundreds of models behind one key.',
  },
  {
    id: 'litellm',
    name: 'LiteLLM',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:4000',
    needsKey: true,
    note: 'A LiteLLM proxy.',
  },
  {
    id: 'other',
    name: 'Other…',
    kind: 'openai-compatible',
    baseUrl: '',
    needsKey: false,
    note: 'Any server that speaks the OpenAI or Anthropic API.',
  },
];

const model = (provider, modelId, extra = {}) => ({
  id: `${provider}/${modelId}`,
  provider,
  modelId,
  name: modelId,
  contextWindow: 128000,
  maxTokens: 16000,
  reasoning: false,
  images: false,
  inputPrice: null,
  outputPrice: null,
  enabled: true,
  usedBy: 0,
  ...extra,
});
const providers = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    hasKey: true,
    headerNames: ['HTTP-Referer'],
    enabled: true,
    createdAt: now(),
    updatedAt: now(),
    models: [
      model('openrouter', 'anthropic/claude-sonnet-4', {
        name: 'Claude Sonnet 4',
        contextWindow: 200000,
        reasoning: true,
        images: true,
        inputPrice: 3,
        outputPrice: 15,
        usedBy: 1,
      }),
      model('openrouter', 'openai/gpt-4.1-mini', {
        name: 'GPT-4.1 mini',
        inputPrice: 0.4,
        outputPrice: 1.6,
        enabled: false,
      }),
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    hasKey: false,
    headerNames: [],
    enabled: true,
    createdAt: now(),
    updatedAt: now(),
    models: [],
  },
];
let defaultModelId = 'openrouter/anthropic/claude-sonnet-4';

const agent = (id, name, modelRef, extra = {}) => ({
  id,
  name,
  description: '',
  instructions: '',
  kind: 'personal',
  agentKind: 'assistant',
  status: 'asleep',
  running: false,
  lastError: null,
  model: modelRef,
  enabled: true,
  lastUsedAt: null,
  revision: 1,
  createdAt: now(),
  updatedAt: now(),
  kindSettings: {},
  canCall: [],
  dir: `/Users/test/Library/Application Support/Pi Local/agents/${id}`,
  piDurableVersion: '0.14.2',
  workspace: { tools: [] },
  approvals: { tools: [], timeoutSeconds: 86400 },
  ...extra,
});
const agents = [
  agent('ag_aaaaaaaaaaaaaaaa', 'Research helper', {
    id: 'openrouter/anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    provider: 'openrouter',
  }),
  agent(
    'ag_bbbbbbbbbbbbbbbb',
    'Old helper',
    { id: 'gone/old-model', name: 'Old model', provider: 'gone' },
    {
      status: 'error',
      lastError:
        'The model gone/old-model is no longer available. Give this agent another model in Settings → Agents.',
    },
  ),
  agent(
    'ag_cccccccccccccccc',
    'Scout',
    { id: 'demo/demo-1', name: 'Demo (echo)', provider: 'demo' },
    {
      agentKind: 'researcher',
      description: 'Digs up sources and summarises them',
      kindSettings: { backgroundSubagents: true, maxPlanSteps: 6 },
      status: 'awake',
      running: true,
      lastUsedAt: now(),
    },
  ),
  agent(
    'ag_dddddddddddddddd',
    'Issue triage',
    { id: 'demo/demo-1', name: 'Demo (echo)', provider: 'demo' },
    {
      agentKind: 'triage',
      kindSettings: {
        listTools: ['github_list_issues'],
        readTools: ['github_get_issue', 'github_list_comments'],
        writeTools: ['github_add_comment', 'github_*_label'],
        approveWrites: true,
      },
      canCall: ['ag_cccccccccccccccc'],
    },
  ),
];
agents[0].description = 'Helps with research questions';
agents[0].workspace = { tools: ['read', 'write', 'edit', 'bash'] };
agents[0].approvals = { tools: ['bash', 'write', 'edit'], timeoutSeconds: 86400 };
agents[2].workspace = { tools: ['bash'] };
agents[2].approvals = { tools: ['bash', 'mcp__github__create_*'], timeoutSeconds: 5400 };
agents[0].lastUsedAt = new Date(Date.now() - 3 * 3600_000).toISOString();

const LEAD = 'ag_aaaaaaaaaaaaaaaa';
const SCOUT = 'ag_cccccccccccccccc';
const teams = [
  {
    id: 'tm_aaaaaaaaaaaaaaaa',
    name: 'Research team',
    description: 'Finds sources and writes them up',
    leadId: LEAD,
    memberIds: [SCOUT, 'ag_dddddddddddddddd'],
    membersTalk: false,
    createdAt: now(),
    updatedAt: now(),
  },
];

/** Everyone an agent may ask: its canCall, and its teams. */
function callableOf(a) {
  const out = new Map();
  for (const id of a.canCall) out.set(id, 'direct');
  for (const t of teams) {
    const ids = [];
    if (t.leadId === a.id) ids.push(...t.memberIds);
    else if (t.membersTalk && t.memberIds.includes(a.id))
      ids.push(t.leadId, ...t.memberIds.filter((m) => m !== a.id));
    for (const id of ids) if (!out.has(id)) out.set(id, 'team');
  }
  return [...out].flatMap(([id, via]) => {
    const other = agents.find((x) => x.id === id);
    return other ? [{ id, name: other.name, via }] : [];
  });
}
const view = (a) => ({
  ...a,
  running: a.status === 'awake',
  callable: callableOf(a),
  pendingApprovals: approvals.filter((x) => x.agentId === a.id && x.status === 'pending').length,
});

const t0 = Date.now() - 20 * 60_000;
const thread = (threadId, title, extra = {}) => ({
  threadId,
  title,
  createdAt: t0,
  updatedAt: t0 + 60_000,
  busy: false,
  lastReplyAt: t0 + 60_000,
  lastError: null,
  visibility: 'private',
  createdBy: null,
  participants: [],
  calledBy: null,
  ...extra,
});
const threads = {
  [LEAD]: [
    thread('th-lead-2', 'Tidy the notes folder', {
      busy: true,
      updatedAt: Date.now() - 4 * 60_000,
      lastReplyAt: null,
    }),
    thread('th-lead-1', 'Papers on durable agents'),
  ],
  [SCOUT]: [
    thread('th-scout-1', 'Search arXiv for durable agent runtimes', {
      calledBy: { agentId: LEAD, name: 'Research helper', threadId: 'th-lead-1' },
    }),
  ],
};
const chatViews = {
  'th-lead-1': {
    busy: false,
    tools: [],
    messages: [
      { id: 'u1', role: 'user', text: 'Find me papers on durable agent runtimes.', at: t0 },
      {
        id: 'a1',
        role: 'assistant',
        text: '',
        at: t0 + 1000,
        toolCalls: [
          {
            id: 'c0',
            name: 'list_agents',
            arguments: {},
            startedAt: t0 + 1000,
            endedAt: t0 + 1200,
          },
          {
            id: 'c1',
            name: 'ask_agent',
            arguments: {
              agent: SCOUT,
              message:
                'Search arXiv for papers on durable execution for LLM agents (2024-2026). List the 3 most relevant with one line each.',
            },
            startedAt: t0 + 1300,
            endedAt: t0 + 41_300,
          },
          {
            id: 'c2',
            name: 'bash',
            arguments: { command: 'ls -la' },
            startedAt: t0 + 41_400,
            endedAt: t0 + 41_500,
          },
        ],
      },
      {
        id: 't0',
        role: 'tool',
        toolCallId: 'c0',
        name: 'list_agents',
        text: 'Agents you may ask:\n- Scout (id: ag_cccccccccccccccc, researcher): Digs up sources',
        isError: false,
        details: { agents: [{ id: SCOUT, name: 'Scout' }] },
      },
      {
        id: 't1',
        role: 'tool',
        toolCallId: 'c1',
        name: 'ask_agent',
        text: '1. Durable Agents (2025): checkpoints every tool call.\n2. Resumable LLM Workflows (2024): replay-safe tools.\n3. Agent Journals (2026): event-sourced transcripts.',
        isError: false,
        details: { agentId: SCOUT, agentName: 'Scout', threadId: 'th-scout-1' },
      },
      { id: 't2', role: 'tool', toolCallId: 'c2', name: 'bash', text: 'total 0', isError: false },
      {
        id: 'a2',
        role: 'assistant',
        text: 'Scout found three papers: **Durable Agents**, **Resumable LLM Workflows** and **Agent Journals**.',
        at: t0 + 42_000,
      },
    ],
  },
  'th-scout-1': {
    busy: false,
    tools: [],
    messages: [
      {
        id: 'u1',
        role: 'user',
        text: 'Search arXiv for papers on durable execution for LLM agents (2024-2026).',
        author: { kind: 'service_account', id: LEAD, name: 'Research helper' },
        at: t0 + 1300,
      },
      { id: 'a1', role: 'assistant', text: '1. Durable Agents (2025) …', at: t0 + 2000 },
    ],
  },
};

// ── Approvals (Phase 4) ──────────────────────────────────────────────────────────────────
const tA = Date.now() - 4 * 60_000;
const approvals = [
  {
    id: 'ap_bbbbbbbbbbbbbbbb',
    agentId: LEAD,
    agentName: 'Research helper',
    threadId: 'th-lead-2',
    callId: 'n2',
    tool: 'write',
    arguments: {
      path: 'notes/INDEX.md',
      content:
        '# Notes\n\n- 2026-10-01 kickoff.md\n- 2026-10-08 retro.md\n- 2026-10-15 planning.md\n- ideas/\n- archive/\n\nGenerated by Research helper.\nLine 9\nLine 10\nLine 11\nLine 12\nLine 13\nLine 14',
    },
    summary: null,
    status: 'pending',
    requestedAt: tA + 2000,
    expiresAt: tA + 2000 + 86_400_000,
    decidedAt: null,
    reason: null,
  },
  {
    id: 'ap_aaaaaaaaaaaaaaaa',
    agentId: LEAD,
    agentName: 'Research helper',
    threadId: 'th-lead-2',
    callId: 'n1',
    tool: 'bash',
    arguments: { command: 'find notes -name "*.tmp" -mtime +30 -delete' },
    summary: 'Deletes temporary files older than 30 days in notes/.',
    status: 'pending',
    requestedAt: tA + 1000,
    expiresAt: tA + 1000 + 3_600_000,
    decidedAt: null,
    reason: null,
  },
];
const chatApproval = (x) => {
  const { agentId: _a, agentName: _n, threadId: _t, ...rest } = x;
  return {
    ...rest,
    ...(x.summary ? { summary: x.summary } : { summary: undefined }),
    ...(x.reason ? { reason: x.reason } : { reason: undefined }),
    ...(x.decidedAt ? { decidedAt: x.decidedAt } : { decidedAt: undefined }),
  };
};
chatViews['th-lead-2'] = {
  busy: true,
  tools: [],
  messages: [
    {
      id: 'u1',
      role: 'user',
      text: 'Tidy the notes folder: remove old temp files and write an index.',
      at: tA,
    },
    {
      id: 'a1',
      role: 'assistant',
      text: '',
      thinking: 'I will delete the old temp files and then write an index.',
      at: tA + 500,
      toolCalls: [
        {
          id: 'n0',
          name: 'read',
          arguments: { path: 'notes' },
          startedAt: tA + 600,
          endedAt: tA + 700,
        },
        {
          id: 'n3',
          name: 'edit',
          arguments: {
            path: 'notes/README.md',
            edits: [{ oldText: 'Status: draft', newText: 'Status: tidied' }],
          },
          startedAt: tA + 800,
          endedAt: tA + 900,
          approval: {
            id: 'ap_cccccccccccccccc',
            callId: 'n3',
            tool: 'edit',
            status: 'denied',
            requestedAt: tA + 800,
            decidedAt: tA + 850,
            reason: 'Leave the README alone',
          },
        },
        {
          id: 'n1',
          name: 'bash',
          arguments: { command: 'find notes -name "*.tmp" -mtime +30 -delete' },
          startedAt: tA + 1000,
        },
        {
          id: 'n2',
          name: 'write',
          arguments: { path: 'notes/INDEX.md', content: '…' },
          startedAt: tA + 2000,
        },
      ],
    },
    {
      id: 't0',
      role: 'tool',
      toolCallId: 'n0',
      name: 'read',
      text: 'kickoff.md\nretro.md\nplanning.md\nold.tmp',
      isError: false,
    },
    {
      id: 't3',
      role: 'tool',
      toolCallId: 'n3',
      name: 'edit',
      text: 'Denied: Leave the README alone',
      isError: true,
    },
  ],
};
const threadClients = new Map();
function syncThreadView(threadId) {
  const v = chatViews[threadId];
  if (!v) return;
  const pending = approvals.filter((x) => x.threadId === threadId && x.status === 'pending');
  for (const m of v.messages)
    for (const c of m.toolCalls ?? []) {
      const ap = approvals.find((x) => x.callId === c.id && x.threadId === threadId);
      if (ap) c.approval = chatApproval(ap);
    }
  if (pending.length) v.approvals = pending.map(chatApproval);
  else delete v.approvals;
  for (const res of threadClients.get(threadId) ?? [])
    res.write(`event: view\ndata: ${JSON.stringify(v)}\n\n`);
}
syncThreadView('th-lead-2');

const clients = new Set();
const broadcast = (event, data) => {
  for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};
const noteAgent = (a) => broadcast('agent', { agentId: a.id, deleted: false, agent: view(a) });
const logLines = (a) =>
  Array.from({ length: 40 }, (_, i) => {
    const at = new Date(Date.now() - (40 - i) * 1500).toISOString();
    return `${at} INFO  [${a.name}] ${i % 7 === 0 ? `runtime ready on port 41${i}` : i % 5 === 0 ? 'thread th-1: reply finished in 812ms' : 'heartbeat ok'}`;
  });
const yamlOf = (a) =>
  [
    `name: ${a.name}`,
    `description: ${a.description}`,
    `kind: ${a.agentKind}`,
    `model: ${a.model?.id ?? ''}`,
    'instructions: |',
    ...(a.instructions || '(default)').split('\n').map((l) => `  ${l}`),
    `canCall: [${a.canCall.join(', ')}]`,
  ].join('\n');
let nextId = 0;
const newAgentId = () => `ag_${String(++nextId).padStart(16, 'e')}`;

function catalog() {
  const models = [
    { id: 'demo/demo-1', name: 'Demo (echo)', provider: 'demo', providerName: 'Demo' },
  ];
  for (const p of providers)
    if (p.enabled)
      for (const m of p.models)
        if (m.enabled)
          models.push({ id: m.id, name: m.name, provider: p.id, providerName: p.name });
  return {
    templates: [{ id: 'assistant', name: 'Assistant', description: 'A general helper.' }],
    models,
    defaultModelId,
    allowModelChoice: true,
    limit: 1000,
    used: agents.length,
  };
}

function usage(days) {
  const byDay = [];
  const zero = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    unpricedRequests: 0,
  };
  const total = { ...zero };
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = d.toISOString().slice(0, 10);
    const r = i % 3 === 0 ? 0 : (i * 7) % 13;
    const row = {
      ...zero,
      day,
      requests: r,
      inputTokens: r * 1200,
      outputTokens: r * 300,
      cacheReadTokens: r * 4000,
      costUsd: r * 0.012,
      unpricedRequests: r ? 1 : 0,
    };
    byDay.push(row);
    for (const k of Object.keys(zero)) total[k] += row[k];
  }
  return {
    from: byDay[0].day,
    to: byDay.at(-1).day,
    days,
    total,
    byDay,
    agents: [{ ...total, agentId: 'ag_aaaaaaaaaaaaaaaa', name: 'Research helper' }],
    models: [
      {
        ...total,
        unpricedRequests: 0,
        modelId: 'openrouter/anthropic/claude-sonnet-4',
        name: 'Claude Sonnet 4',
      },
      {
        ...zero,
        requests: total.unpricedRequests,
        inputTokens: 900,
        outputTokens: 80,
        unpricedRequests: total.unpricedRequests,
        modelId: 'ollama/llama3.2',
        name: 'llama3.2',
      },
    ],
  };
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const ok = (res, data, status = 200) => send(res, status, { data });
const fail = (res, status, code, message, details) =>
  send(res, status, { error: { code, message, details } });
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (!String(req.headers['content-type'] ?? '').includes('json')) return resolve(raw);
      try {
        resolve(raw.length ? JSON.parse(raw.toString('utf8')) : {});
      } catch {
        resolve({});
      }
    });
  });
const usersOf = (modelIds) =>
  agents
    .filter((a) => a.model && modelIds.includes(a.model.id))
    .map(({ id, name }) => ({ id, name }));

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
  const m = req.method;

  if (path === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('event: ready\ndata: {}\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (path === '/api/me')
    return ok(res, {
      user: { id: 'local', name: 'Test Person', email: '', role: 'admin' },
      csrfToken: '',
      features: {},
      platform: { mode: 'local', account: null },
    });
  if (path === '/api/auth/config')
    return ok(res, {
      oidcEnabled: false,
      devAuthEnabled: false,
      devAccounts: [],
      instance: {
        name: 'Pi Local',
        logoUrl: null,
        colorTheme: 'neutral',
        defaultTheme: 'system',
        orgName: '',
        supportUrl: null,
      },
    });
  if (path === '/api/me/prefs') return ok(res, {});
  if (path.startsWith('/api/me/prefs/')) return ok(res, { ok: true });
  if (path === '/api/me/usage') return ok(res, usage(Number(url.searchParams.get('days') ?? 30)));
  if (path === '/api/agents' && m === 'GET') return ok(res, agents.map(view));
  if (path === '/api/agents/catalog') return ok(res, catalog());
  if (path === '/api/about')
    return ok(res, {
      version: '0.3.0-dev',
      dataDir: '/Users/test/Library/Application Support/Pi Local',
      runtime: {
        node: '/Users/test/.local/share/pi-node/bin/node',
        nodeVersion: 'v22.23.0',
        piDurableVersion: '0.14.2',
        contractVersion: 3,
      },
      agents: agents.length,
    });
  if (path === '/api/reveal' && m === 'POST') {
    console.log('reveal', body);
    return ok(res, { ok: true });
  }
  if (path === '/api/agents/import' && m === 'POST') {
    await new Promise((r) => setTimeout(r, 300));
    if (!Buffer.isBuffer(body) || body.subarray(0, 2).toString() !== 'PK')
      return fail(
        res,
        400,
        'invalid_archive',
        'This is not a zip file an export made (no agent.yaml in it).',
      );
    const a = { ...agent(newAgentId(), 'Imported agent', agents[0].model), canCall: [] };
    agents.unshift(a);
    noteAgent(a);
    return ok(res, view(a), 201);
  }
  if (path === '/api/teams' && m === 'GET') return ok(res, teams);
  if (path === '/api/teams' && m === 'POST') {
    if (!body.name?.trim()) return fail(res, 400, 'invalid_name', 'A team needs a name.');
    const t = {
      id: `tm_${String(teams.length + 1).padStart(16, 'b')}`,
      name: body.name,
      description: body.description ?? '',
      leadId: body.leadId,
      memberIds: body.memberIds ?? [],
      membersTalk: Boolean(body.membersTalk),
      createdAt: now(),
      updatedAt: now(),
    };
    teams.push(t);
    broadcast('team', { teamId: t.id, deleted: false, team: t });
    return ok(res, t, 201);
  }
  if (parts[1] === 'teams' && parts[2]) {
    const t = teams.find((x) => x.id === parts[2]);
    if (!t) return fail(res, 404, 'not_found', 'No such team.');
    if (m === 'PATCH') {
      Object.assign(t, body, { updatedAt: now() });
      broadcast('team', { teamId: t.id, deleted: false, team: t });
      return ok(res, t);
    }
    if (m === 'DELETE') {
      teams.splice(teams.indexOf(t), 1);
      broadcast('team', { teamId: t.id, deleted: true });
      return ok(res, { ok: true });
    }
  }
  if (path === '/api/approvals' && m === 'GET') {
    const all = url.searchParams.get('status') === 'all';
    return ok(
      res,
      approvals
        .filter((x) => all || x.status === 'pending')
        .sort((a, b) => b.requestedAt - a.requestedAt)
        .map(({ callId: _c, ...x }) => x),
    );
  }
  if (parts[1] === 'agents' && parts[2] && parts[3] === 'approvals') {
    if (parts.length === 4 && m === 'GET')
      return ok(
        res,
        approvals
          .filter((x) => x.agentId === parts[2])
          .filter(
            (x) => !url.searchParams.get('thread') || x.threadId === url.searchParams.get('thread'),
          ),
      );
    const ap = approvals.find((x) => x.agentId === parts[2] && x.id === parts[4]);
    if (!ap) return fail(res, 404, 'not_found', 'No such approval.');
    if (m === 'POST') {
      await new Promise((r) => setTimeout(r, 300));
      if (ap.status !== 'pending')
        return fail(res, 409, 'approval_decided', 'This request was already decided.');
      if (!['approve', 'deny'].includes(body.decision))
        return fail(res, 400, 'invalid_decision', 'decision must be approve or deny');
      ap.status = body.decision === 'approve' ? 'approved' : 'denied';
      ap.decidedAt = Date.now();
      ap.reason = body.reason ?? null;
      const v = chatViews[ap.threadId];
      if (v) {
        v.messages.push({
          id: `r-${ap.callId}`,
          role: 'tool',
          toolCallId: ap.callId,
          name: ap.tool,
          text: ap.status === 'approved' ? 'ok' : `Denied${ap.reason ? `: ${ap.reason}` : ''}`,
          isError: ap.status !== 'approved',
        });
        if (!approvals.some((x) => x.threadId === ap.threadId && x.status === 'pending')) {
          v.messages.push({
            id: `done-${Date.now()}`,
            role: 'assistant',
            text: 'Done: I did what you approved and skipped the rest.',
            at: Date.now(),
          });
          v.busy = false;
          const t = (threads[ap.agentId] ?? []).find((x) => x.threadId === ap.threadId);
          if (t) {
            t.busy = false;
            t.lastReplyAt = Date.now();
            t.updatedAt = Date.now();
            broadcast('thread', {
              agentId: ap.agentId,
              threadId: t.threadId,
              deleted: false,
              thread: t,
            });
          }
        }
      }
      syncThreadView(ap.threadId);
      const { callId: _c, ...out } = ap;
      broadcast('approval', { agentId: ap.agentId, approval: out });
      noteAgent(agents.find((x) => x.id === ap.agentId));
      return ok(res, out);
    }
  }
  if (parts[1] === 'agents' && parts[2] && parts[3] === 'attachments' && m === 'POST') {
    const a = agents.find((x) => x.id === parts[2]);
    if (!a) return fail(res, 404, 'not_found', 'No such agent.');
    if (!a.workspace.tools.includes('read'))
      return fail(res, 409, 'no_read_tool', `${a.name} doesn't have the read tool.`);
    const name = url.searchParams.get('name') ?? '';
    if (!name.trim()) return fail(res, 400, 'invalid_name', 'A file needs a name.');
    await new Promise((r) => setTimeout(r, 900));
    const day = new Date().toISOString().slice(0, 10);
    return ok(
      res,
      {
        path: `attachments/${day}/${name}`,
        name,
        size: Buffer.isBuffer(body) ? body.length : 0,
        mediaType: req.headers['content-type'] ?? 'application/octet-stream',
      },
      201,
    );
  }
  if (parts[1] === 'agents' && parts[2] && parts[3] === 'threads') {
    const list = threads[parts[2]] ?? [];
    if (parts.length === 4) return ok(res, list);
    if (parts[5] === 'messages' && m === 'POST') {
      if (!chatViews[parts[4]]) {
        chatViews[parts[4]] = { busy: false, tools: [], messages: [] };
        const t = thread(parts[4], String(body.text).split('\n')[0].slice(0, 60), {
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        threads[parts[2]] = [t, ...list];
        broadcast('thread', { agentId: parts[2], threadId: parts[4], deleted: false, thread: t });
      }
      const cv = chatViews[parts[4]];
      cv.messages.push({ id: `u-${Date.now()}`, role: 'user', text: body.text, at: Date.now() });
      cv.busy = true;
      syncThreadView(parts[4]);
      setTimeout(() => {
        cv.messages.push({
          id: `a-${Date.now()}`,
          role: 'assistant',
          text: `You said:\n\n${body.text}`,
          at: Date.now(),
        });
        cv.busy = false;
        syncThreadView(parts[4]);
      }, 800);
      return ok(res, { submissionId: `s-${Date.now()}` }, 202);
    }
    const v = chatViews[parts[4]];
    if (!v) return fail(res, 404, 'not_found', 'No such conversation.');
    if (parts[5] === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`event: view\ndata: ${JSON.stringify(v)}\n\n`);
      const set = threadClients.get(parts[4]) ?? new Set();
      set.add(res);
      threadClients.set(parts[4], set);
      req.on('close', () => set.delete(res));
      return;
    }
    if (parts.length === 5 && m === 'GET') return ok(res, v);
  }
  if (parts[1] === 'agents' && parts[2] && parts[3]) {
    const a = agents.find((x) => x.id === parts[2]);
    if (!a) return fail(res, 404, 'not_found', 'No such agent.');
    if (parts[3] === 'config' && m === 'GET') return ok(res, { yaml: yamlOf(a) });
    if (parts[3] === 'config' && m === 'PUT') {
      const lines = String(body.yaml ?? '').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim() || line.trim().startsWith('#') || /^\s/.test(line)) continue;
        if (!line.includes(':'))
          return fail(res, 400, 'invalid_yaml', `line ${i + 1}: could not find expected ':'`);
      }
      const name = lines
        .find((l) => l.startsWith('name:'))
        ?.slice(5)
        .trim();
      if (name) a.name = name;
      a.revision++;
      noteAgent(a);
      return ok(res, view(a));
    }
    if (parts[3] === 'logs')
      return ok(res, { path: `${a.dir}/logs/runtime.log`, lines: logLines(a) });
    if (parts[3] === 'wake' || parts[3] === 'sleep') {
      if (parts[3] === 'wake' && a.status === 'error') return ok(res, view(a));
      a.status = parts[3] === 'wake' ? 'starting' : 'asleep';
      noteAgent(a);
      if (parts[3] === 'wake')
        await new Promise((r) => setTimeout(r, 700)).then(() => {
          a.status = 'awake';
          noteAgent(a);
        });
      return ok(res, view(a));
    }
    if (parts[3] === 'duplicate') {
      const copy = {
        ...structuredClone(a),
        id: newAgentId(),
        name: body.name ?? `${a.name} copy`,
        status: 'asleep',
        lastUsedAt: null,
        createdAt: now(),
      };
      copy.dir = copy.dir.replace(a.id, copy.id);
      agents.unshift(copy);
      noteAgent(copy);
      return ok(res, view(copy), 201);
    }
    if (parts[3] === 'export') {
      const withConversations = url.searchParams.get('conversations') === 'true';
      const name = `${a.name}${withConversations ? ' with conversations' : ''}.zip`;
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="agent.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      res.end(Buffer.from('PK\u0003\u0004fake zip'));
      return;
    }
  }
  if (parts[1] === 'agents' && parts[2] && parts.length === 3 && m === 'DELETE') {
    const a = agents.find((x) => x.id === parts[2]);
    if (!a) return fail(res, 404, 'not_found', 'No such agent.');
    agents.splice(agents.indexOf(a), 1);
    for (const t of [...teams]) {
      if (t.leadId === a.id) {
        teams.splice(teams.indexOf(t), 1);
        broadcast('team', { teamId: t.id, deleted: true });
      } else t.memberIds = t.memberIds.filter((x) => x !== a.id);
    }
    for (const other of agents) other.canCall = other.canCall.filter((x) => x !== a.id);
    broadcast('agent', { agentId: a.id, deleted: true });
    return ok(res, { ok: true });
  }
  if (parts[1] === 'agents' && parts[2] && m === 'PATCH') {
    const a = agents.find((x) => x.id === parts[2]);
    if (!a) return fail(res, 404, 'not_found', 'No such agent.');
    if (body.canCall !== undefined) {
      if (
        body.canCall.includes(a.id) ||
        body.canCall.some((id) => !agents.some((x) => x.id === id))
      )
        return fail(
          res,
          400,
          'invalid_can_call',
          'An agent cannot ask itself or an unknown agent.',
        );
      a.canCall = body.canCall;
    }
    if (body.kindSettings !== undefined) a.kindSettings = body.kindSettings;
    if (body.workspace !== undefined) {
      const tools = body.workspace?.tools;
      if (
        !Array.isArray(tools) ||
        tools.some((t) => !['read', 'write', 'edit', 'bash'].includes(t))
      )
        return fail(
          res,
          400,
          'invalid_workspace_tools',
          'Workspace tools are read, write, edit and bash.',
        );
      a.workspace = { tools };
    }
    if (body.approvals !== undefined) {
      const { tools, timeoutSeconds } = body.approvals ?? {};
      if (
        !Array.isArray(tools) ||
        tools.length > 100 ||
        tools.some((t) => typeof t !== 'string' || !/^[A-Za-z0-9_.*-]{1,200}$/.test(t))
      )
        return fail(
          res,
          400,
          'invalid_approval_tools',
          'Approval tools must be names or patterns of [A-Za-z0-9_.*-].',
        );
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 2_592_000)
        return fail(
          res,
          400,
          'invalid_approval_timeout',
          'The timeout must be between 60 seconds and 30 days.',
        );
      // A demo of a refused list: "forbidden" is refused as the backend might refuse something.
      if (tools.includes('forbidden'))
        return fail(
          res,
          400,
          'invalid_approval_tools',
          '"forbidden" is not allowed (fake API demo).',
        );
      a.approvals = { tools, timeoutSeconds };
    }
    if (body.description !== undefined) a.description = body.description;
    if (body.instructions !== undefined) a.instructions = body.instructions;
    a.revision++;
    if (body.modelId) {
      const c = catalog().models.find((x) => x.id === body.modelId);
      if (!c) return fail(res, 400, 'invalid_model', 'No such model.');
      a.model = { id: c.id, name: c.name, provider: c.provider };
      a.status = 'asleep';
      a.lastError = null;
    }
    Object.assign(a, body.name ? { name: body.name } : {});
    noteAgent(a);
    return ok(res, view(a));
  }
  if (path === '/api/settings/default-model' && m === 'PUT') {
    defaultModelId = body.modelId;
    return ok(res, { defaultModelId });
  }
  if (path === '/api/providers' && m === 'GET')
    return ok(res, { kinds, presets, providers, defaultModelId });
  if (path === '/api/providers' && m === 'POST') {
    const id =
      body.id ??
      String(body.name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);
    if (providers.some((p) => p.id === id))
      return fail(res, 409, 'id_taken', `There is already a provider called ${id}.`);
    const p = {
      id,
      name: body.name,
      kind: body.kind,
      baseUrl: body.baseUrl ?? kinds.find((k) => k.id === body.kind)?.defaultBaseUrl ?? '',
      hasKey: Boolean(body.apiKey),
      headerNames: Object.keys(body.headers ?? {}),
      enabled: true,
      models: [],
      createdAt: now(),
      updatedAt: now(),
    };
    providers.push(p);
    return ok(res, p, 201);
  }
  if (parts[1] === 'providers' && parts[2]) {
    const p = providers.find((x) => x.id === parts[2]);
    if (!p) return fail(res, 404, 'not_found', 'No such provider.');
    if (parts.length === 3 && m === 'PATCH') {
      if (body.name !== undefined) p.name = body.name;
      if (body.baseUrl !== undefined) p.baseUrl = body.baseUrl;
      if (body.apiKey !== undefined) p.hasKey = body.apiKey !== '';
      if (body.headers !== undefined) p.headerNames = Object.keys(body.headers);
      if (body.enabled !== undefined) p.enabled = body.enabled;
      return ok(res, p);
    }
    if (parts.length === 3 && m === 'DELETE') {
      const users = usersOf(p.models.map((x) => x.id));
      if (users.length)
        return fail(res, 409, 'in_use', 'Agents use its models.', { agents: users });
      providers.splice(providers.indexOf(p), 1);
      return ok(res, { ok: true });
    }
    if (parts[3] === 'discover') {
      await new Promise((r) => setTimeout(r, 400));
      if (p.id === 'ollama')
        return fail(
          res,
          502,
          'discovery_failed',
          "Couldn't reach http://localhost:11434/v1: connection refused. Is Ollama running?",
        );
      const vendors = [
        'anthropic',
        'openai',
        'google',
        'meta-llama',
        'mistralai',
        'qwen',
        'deepseek',
      ];
      const list = [];
      for (let i = 0; i < 320; i++) {
        const modelId = `${vendors[i % vendors.length]}/model-${i}`;
        list.push({
          modelId,
          name: `${vendors[i % vendors.length]} Model ${i}`,
          contextWindow: i % 4 ? 32000 * (1 + (i % 5)) : null,
          added: p.models.some((x) => x.modelId === modelId),
        });
      }
      for (const x of p.models)
        if (!list.some((y) => y.modelId === x.modelId))
          list.unshift({
            modelId: x.modelId,
            name: x.name,
            contextWindow: x.contextWindow,
            added: true,
          });
      return ok(res, { models: list });
    }
    if (parts[3] === 'models' && parts.length > 4) {
      const modelId = parts.slice(4).join('/');
      const existing = p.models.find((x) => x.modelId === modelId);
      if (m === 'PUT') {
        const next = { ...(existing ?? model(p.id, modelId)), ...body };
        if (existing) Object.assign(existing, next);
        else p.models.push(next);
        return ok(res, next);
      }
      if (m === 'DELETE') {
        if (!existing) return fail(res, 404, 'not_found', 'No such model.');
        const users = usersOf([existing.id]);
        if (users.length)
          return fail(res, 409, 'in_use', 'Agents use this model.', { agents: users });
        p.models.splice(p.models.indexOf(existing), 1);
        return ok(res, { ok: true });
      }
    }
  }
  fail(res, 404, 'not_found', `No route for ${m} ${path}`);
}).listen(port, '127.0.0.1', () => console.log(`fake api on http://127.0.0.1:${port}`));

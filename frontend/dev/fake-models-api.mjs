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
];

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
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
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
  if (path === '/api/agents' && m === 'GET') return ok(res, agents);
  if (path === '/api/agents/catalog') return ok(res, catalog());
  if (parts[1] === 'agents' && parts[2] && m === 'PATCH') {
    const a = agents.find((x) => x.id === parts[2]);
    if (!a) return fail(res, 404, 'not_found', 'No such agent.');
    if (body.modelId) {
      const c = catalog().models.find((x) => x.id === body.modelId);
      if (!c) return fail(res, 400, 'invalid_model', 'No such model.');
      a.model = { id: c.id, name: c.name, provider: c.provider };
      a.status = 'asleep';
      a.lastError = null;
    }
    Object.assign(a, body.name ? { name: body.name } : {});
    return ok(res, a);
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

import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/errors.ts';
import type { DiscoveredModel } from '../../src/api/types.ts';
import {
  filterDiscovered,
  formatPrice,
  formatTokens,
  groupModelsByProvider,
  headersFromRows,
  inUseAgents,
  listNames,
  modelIdProblem,
  modelPath,
  parsePrice,
  parseTokens,
  providerPath,
  splitModelId,
} from '../../src/lib/models.ts';

describe('modelPath', () => {
  it('encodes each segment and keeps the slashes as separators', () => {
    expect(modelPath('openrouter', 'anthropic/claude-sonnet-4')).toBe(
      '/api/providers/openrouter/models/anthropic/claude-sonnet-4',
    );
  });

  it('encodes what a path segment cannot hold', () => {
    expect(modelPath('lm', 'qwen2.5 7b:q4?x#y')).toBe(
      '/api/providers/lm/models/qwen2.5%207b%3Aq4%3Fx%23y',
    );
    expect(modelPath('a b', 'm%1/n')).toBe('/api/providers/a%20b/models/m%251/n');
  });

  it('builds provider paths', () => {
    expect(providerPath('openai')).toBe('/api/providers/openai');
    expect(providerPath('openai', '/discover')).toBe('/api/providers/openai/discover');
  });
});

describe('modelIdProblem', () => {
  it('accepts ordinary and nested IDs', () => {
    expect(modelIdProblem('gpt-4.1')).toBeNull();
    expect(modelIdProblem('anthropic/claude-sonnet-4')).toBeNull();
  });

  it('refuses empty, spaced and empty-segment IDs', () => {
    expect(modelIdProblem('')).toMatch(/Enter/);
    expect(modelIdProblem('a b')).toMatch(/spaces/);
    expect(modelIdProblem('/a')).toMatch(/\//);
    expect(modelIdProblem('a/')).toMatch(/\//);
    expect(modelIdProblem('a//b')).toMatch(/\//);
  });
});

describe('splitModelId', () => {
  it('splits at the first slash only', () => {
    expect(splitModelId('openrouter/anthropic/claude-sonnet-4')).toEqual({
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
    });
    expect(splitModelId('demo/demo-1')).toEqual({ provider: 'demo', modelId: 'demo-1' });
  });

  it('is null without a provider or model', () => {
    expect(splitModelId('nothing')).toBeNull();
    expect(splitModelId('/x')).toBeNull();
    expect(splitModelId('x/')).toBeNull();
  });
});

describe('groupModelsByProvider', () => {
  it('groups by provider in the order they came, named by providerName', () => {
    const groups = groupModelsByProvider([
      { id: 'demo/demo-1', name: 'Demo' },
      { id: 'openai/gpt-4.1', name: 'GPT-4.1', provider: 'openai', providerName: 'OpenAI' },
      { id: 'ollama/llama3', name: 'Llama 3', provider: 'ollama', providerName: 'Ollama' },
      { id: 'openai/o3', name: 'o3', provider: 'openai', providerName: 'OpenAI' },
    ]);
    expect(groups.map((group) => [group.label, group.models.map((model) => model.id)])).toEqual([
      ['Demo', ['demo/demo-1']],
      ['OpenAI', ['openai/gpt-4.1', 'openai/o3']],
      ['Ollama', ['ollama/llama3']],
    ]);
  });

  it('falls back to the ID prefix without provider fields', () => {
    const groups = groupModelsByProvider([{ id: 'work/x', name: 'X' }]);
    expect(groups).toEqual([{ key: 'work', label: 'work', models: [{ id: 'work/x', name: 'X' }] }]);
  });
});

describe('filterDiscovered', () => {
  const models: DiscoveredModel[] = [
    {
      modelId: 'anthropic/claude-sonnet-4',
      name: 'Claude Sonnet 4',
      contextWindow: 200000,
      added: true,
    },
    { modelId: 'openai/gpt-4.1-mini', name: 'GPT-4.1 mini', contextWindow: null, added: false },
    { modelId: 'meta/llama-3-70b', name: 'Llama 3 70B', contextWindow: 8192, added: false },
  ];

  it('matches every word in the ID or name, ignoring case', () => {
    expect(filterDiscovered(models, 'CLAUDE').map((m) => m.modelId)).toEqual([
      'anthropic/claude-sonnet-4',
    ]);
    expect(filterDiscovered(models, 'llama 70b').map((m) => m.modelId)).toEqual([
      'meta/llama-3-70b',
    ]);
    expect(filterDiscovered(models, 'gpt claude')).toEqual([]);
    expect(filterDiscovered(models, '  ')).toHaveLength(3);
  });

  it('can hide the ones already added', () => {
    expect(filterDiscovered(models, '', true).map((m) => m.modelId)).toEqual([
      'openai/gpt-4.1-mini',
      'meta/llama-3-70b',
    ]);
  });
});

describe('headersFromRows', () => {
  it('builds the headers, skipping empty rows and trimming', () => {
    expect(
      headersFromRows([
        { name: ' X-Org ', value: ' acme ' },
        { name: '', value: '' },
        { name: 'Authorization', value: 'Bearer t' },
      ]),
    ).toEqual({ headers: { 'X-Org': 'acme', Authorization: 'Bearer t' } });
    expect(headersFromRows([])).toEqual({ headers: {} });
  });

  it('refuses a missing name or value, a bad name, and duplicates', () => {
    expect(headersFromRows([{ name: '', value: 'v' }]).error).toMatch(/name/);
    expect(headersFromRows([{ name: 'X-A', value: '' }]).error).toMatch(/value/);
    expect(headersFromRows([{ name: 'Bad Name', value: 'v' }]).error).toMatch(/valid/);
    expect(
      headersFromRows([
        { name: 'X-A', value: '1' },
        { name: 'x-a', value: '2' },
      ]).error,
    ).toMatch(/twice/);
  });
});

describe('parsePrice', () => {
  it('reads dollars, empty as unpriced, and refuses the rest', () => {
    expect(parsePrice('')).toBeNull();
    expect(parsePrice('  ')).toBeNull();
    expect(parsePrice('3')).toBe(3);
    expect(parsePrice('$0.15')).toBe(0.15);
    expect(parsePrice('0')).toBe(0);
    expect(parsePrice('-1')).toBeUndefined();
    expect(parsePrice('abc')).toBeUndefined();
  });
});

describe('parseTokens', () => {
  it('reads whole numbers, separators and k/m', () => {
    expect(parseTokens('128000')).toBe(128000);
    expect(parseTokens('128,000')).toBe(128000);
    expect(parseTokens('128k')).toBe(128000);
    expect(parseTokens('1.5M')).toBe(1500000);
  });

  it('refuses zero, negatives and text', () => {
    expect(parseTokens('0')).toBeUndefined();
    expect(parseTokens('-5')).toBeUndefined();
    expect(parseTokens('lots')).toBeUndefined();
    expect(parseTokens('')).toBeUndefined();
  });
});

describe('inUseAgents', () => {
  it('reads the agents of a 409 in_use', () => {
    const error = new ApiError(409, 'in_use', 'In use', {
      agents: [{ id: 'ag_1', name: 'Ada' }, { id: 'ag_2' }, 'junk'],
    });
    expect(inUseAgents(error)).toEqual([
      { id: 'ag_1', name: 'Ada' },
      { id: 'ag_2', name: 'ag_2' },
    ]);
    expect(inUseAgents(new ApiError(409, 'in_use', 'In use'))).toEqual([]);
  });

  it('is null for other errors', () => {
    expect(inUseAgents(new ApiError(502, 'discovery_failed', 'x'))).toBeNull();
    expect(inUseAgents(new Error('x'))).toBeNull();
  });
});

describe('listNames', () => {
  it('joins names readably', () => {
    expect(listNames([])).toBe('');
    expect(listNames(['Ada'])).toBe('Ada');
    expect(listNames(['Ada', 'Bob'])).toBe('Ada and Bob');
    expect(listNames(['Ada', 'Bob', 'Cy'])).toBe('Ada, Bob and Cy');
    expect(listNames(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 others');
  });
});

describe('formatting', () => {
  it('formats tokens and prices', () => {
    expect(formatTokens(128000)).toBe('128K');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatPrice(null)).toBe('—');
    expect(formatPrice(3)).toBe('$3');
    expect(formatPrice(0.15)).toBe('$0.15');
    expect(formatPrice(0.4)).toBe('$0.40');
    expect(formatPrice(0.075)).toBe('$0.075');
    expect(formatPrice(2.5)).toBe('$2.50');
  });
});

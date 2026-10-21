import { ApiError } from '~/api/errors';
import type { AgentRef, CatalogModel, DiscoveredModel, ProviderKind } from '~/api/types';

/** The demo model: always there, needs nothing. */
export const DEMO_MODEL_ID = 'demo/demo-1';

/** `/api/providers/{p}…`, the provider ID encoded. */
export const providerPath = (providerId: string, rest = '') =>
  `/api/providers/${encodeURIComponent(providerId)}${rest}`;

/**
 * `/api/providers/{p}/models/{modelId...}`. A model ID may itself contain slashes
 * (OpenRouter's "anthropic/claude-sonnet-4"): each segment is encoded and the
 * slashes stay separators, as the route takes the rest of the path.
 */
export function modelPath(providerId: string, modelId: string): string {
  return providerPath(
    providerId,
    `/models/${modelId.split('/').map(encodeURIComponent).join('/')}`,
  );
}

/** Why a model ID typed in can't be used, or null when it can. */
export function modelIdProblem(modelId: string): string | null {
  if (!modelId) return 'Enter the model ID.';
  if (/\s/.test(modelId)) return 'A model ID has no spaces.';
  if (modelId.split('/').some((segment) => !segment))
    return 'A model ID can\'t start or end with "/", or have "//" in it.';
  return null;
}

/** "<provider>/<modelId>", split at the first slash; null without one. */
export function splitModelId(id: string): { provider: string; modelId: string } | null {
  const at = id.indexOf('/');
  if (at <= 0 || at === id.length - 1) return null;
  return { provider: id.slice(0, at), modelId: id.slice(at + 1) };
}

/**
 * Whether the catalog has nothing but the built-in demo model: no model
 * provider is set up yet.
 */
export function onlyDemoModel(models: readonly CatalogModel[]): boolean {
  return models.every(
    (model) =>
      model.id === DEMO_MODEL_ID || (model.provider ?? splitModelId(model.id)?.provider) === 'demo',
  );
}

export interface ModelGroup<T> {
  /** The provider's ID. */
  key: string;
  /** The provider's name, for an <optgroup> label. */
  label: string;
  models: T[];
}

/**
 * Catalog models grouped by provider, groups and models in the order they came.
 * A model without `provider` is placed by its ID's prefix; the demo model's
 * group reads "Demo".
 */
export function groupModelsByProvider<T extends CatalogModel>(
  models: readonly T[],
): ModelGroup<T>[] {
  const groups = new Map<string, ModelGroup<T>>();
  for (const model of models) {
    const key = model.provider ?? splitModelId(model.id)?.provider ?? '';
    let group = groups.get(key);
    if (!group) {
      const label = model.providerName || (key === 'demo' ? 'Demo' : key || 'Other');
      group = { key, label, models: [] };
      groups.set(key, group);
    }
    group.models.push(model);
  }
  return [...groups.values()];
}

/**
 * Discovered models matching a search: every word of it in the model's ID or
 * name, ignoring case. `hideAdded` leaves out the ones already added.
 */
export function filterDiscovered(
  models: readonly DiscoveredModel[],
  query: string,
  hideAdded = false,
): DiscoveredModel[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((model) => {
    if (hideAdded && model.added) return false;
    const text = `${model.modelId} ${model.name}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export interface HeaderRow {
  name: string;
  value: string;
}

/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * The extra headers to send, from the form's rows: fully empty rows are
 * skipped; every other row needs a valid name and a value, once each.
 */
export function headersFromRows(
  rows: readonly HeaderRow[],
): { headers: Record<string, string>; error?: undefined } | { error: string } {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name && !value) continue;
    if (!name) return { error: 'Each header needs a name.' };
    if (!HEADER_NAME.test(name)) return { error: `“${name}” is not a valid header name.` };
    if (!value) return { error: `Enter a value for ${name}.` };
    if (seen.has(name.toLowerCase())) return { error: `${name} is listed twice.` };
    seen.add(name.toLowerCase());
    headers[name] = value;
  }
  return { headers };
}

/**
 * A price field: empty is null (unpriced), a number of dollars at least 0 is
 * itself, anything else undefined (not valid).
 */
export function parsePrice(text: string): number | null | undefined {
  const trimmed = text.trim().replace(/^\$/, '');
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A token count field: a whole number above 0, or undefined. Accepts "128,000" and "128k". */
export function parseTokens(text: string): number | undefined {
  const trimmed = text
    .trim()
    .toLowerCase()
    .replace(/[,_\s]/g, '');
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(trimmed);
  if (!match) return undefined;
  const scale = match[2] === 'k' ? 1_000 : match[2] === 'm' ? 1_000_000 : 1;
  const value = Math.round(Number(match[1]) * scale);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The agents a `409 in_use` names, or null for any other error. */
export function inUseAgents(error: unknown): AgentRef[] | null {
  if (!(error instanceof ApiError) || error.code !== 'in_use') return null;
  const agents = error.details?.agents;
  if (!Array.isArray(agents)) return [];
  return agents
    .filter(
      (agent): agent is AgentRef =>
        typeof agent === 'object' && agent !== null && typeof agent.id === 'string',
    )
    .map((agent) => ({
      id: agent.id,
      name: typeof agent.name === 'string' ? agent.name : agent.id,
    }));
}

/** "Ada and Bob", "Ada, Bob and 3 others". */
export function listNames(names: readonly string[], max = 3): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const rest = names.length - max;
  return `${names.slice(0, max).join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
}

export const kindName = (kinds: readonly ProviderKind[], id: string) =>
  kinds.find((kind) => kind.id === id)?.name ?? id;

const tokensFormat = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** 128000 → "128K", 1048576 → "1M". */
export const formatTokens = (tokens: number) => tokensFormat.format(tokens);

/** "$3", "$0.40" or "$0.075" per million tokens; "—" unpriced. */
export function formatPrice(price: number | null): string {
  if (price === null) return '—';
  if (Number.isInteger(price)) return `$${price}`;
  const exact = Number.parseFloat(price.toFixed(4));
  return `$${exact.toFixed(Math.max(2, (String(exact).split('.')[1] ?? '').length))}`;
}

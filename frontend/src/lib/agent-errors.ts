/**
 * Why a reply failed, in words people can act on. The platform passes the
 * model provider's error through as it came ("400: {"code":"upstream_rejected",
 * …}"); the sentence says what happened, and the raw text stays available as
 * the details, for whoever has to look into it.
 */
export interface ExplainedFailure {
  /** One sentence, ending in a full stop. */
  summary: string;
  /** The error as it came, when the summary is not simply it. */
  detail: string | null;
}

interface Parsed {
  status: number | null;
  code: string;
  message: string;
}

/** "400: {json}", "Error 429: text", "{json}", or plain text. */
function parse(raw: string): Parsed {
  const text = raw.trim();
  const match = /^(?:[a-z ]*?)?(\d{3})\b[:\s-]*(.*)$/is.exec(text);
  const status = match ? Number(match[1]) : null;
  const rest = match ? (match[2] ?? '') : text;
  let code = '';
  let message = rest;
  const json = rest.slice(rest.indexOf('{'));
  if (json.startsWith('{')) {
    try {
      const body = JSON.parse(json) as Record<string, unknown>;
      const inner = (typeof body.error === 'object' && body.error ? body.error : body) as Record<
        string,
        unknown
      >;
      code = String(inner.code ?? inner.type ?? '');
      message = typeof inner.message === 'string' ? inner.message : rest;
    } catch {
      // Not JSON after all: keep the text.
    }
  }
  return { status, code: code.toLowerCase(), message: message.trim() };
}

const sentence = (text: string) => {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

const RULES: Array<{ test: (p: Parsed, raw: string) => boolean; summary: string }> = [
  {
    test: (p, raw) => /context|too many tokens|maximum.*tokens|too long/i.test(`${p.code} ${raw}`),
    summary:
      'The conversation is too long for this model. Start a new conversation, or ask a shorter question.',
  },
  {
    test: (p, raw) =>
      p.status === 429 || /rate.?limit|quota|too many requests/i.test(`${p.code} ${raw}`),
    summary: 'The model is busy or over its limit right now. Try again in a minute.',
  },
  {
    test: (p, raw) => /timeout|timed out|deadline/i.test(`${p.code} ${raw}`),
    summary: 'The model took too long to answer. Try again.',
  },
  {
    test: (p) =>
      p.status === 401 || p.status === 403 || /unauthori|forbidden|api.?key/i.test(p.code),
    summary:
      "The platform couldn't use this model: it was refused access. An administrator needs to check the model's settings.",
  },
  {
    test: (p, raw) =>
      /upstream_rejected|invalid_request|bad_request/i.test(p.code) ||
      (p.status === 400 && /upstream/i.test(raw)),
    summary:
      "The model's provider rejected the request. This model may not support what the agent asked of it; try again, or an administrator can pick another model.",
  },
  {
    test: (p, raw) =>
      /not.?found|model_not|unknown model/i.test(`${p.code} ${raw}`) || p.status === 404,
    summary: "The model isn't available. An administrator may need to pick another one.",
  },
  {
    test: (p, raw) =>
      (p.status !== null && p.status >= 500) ||
      /overloaded|unavailable|internal/i.test(`${p.code} ${raw}`),
    summary: "The model's provider had a problem. Try again in a moment.",
  },
  {
    test: (_p, raw) => /network|fetch failed|econn|socket/i.test(raw),
    summary: "The agent couldn't reach the model. Try again in a moment.",
  },
];

export function explainFailure(raw: string | null | undefined): ExplainedFailure {
  const text = (raw ?? '').trim();
  if (!text) return { summary: 'The reply could not be generated.', detail: null };
  const parsed = parse(text);
  const rule = RULES.find((candidate) => candidate.test(parsed, text));
  if (rule) return { summary: rule.summary, detail: text };
  // Unrecognised: its own words, without the transport wrapping, when it has them.
  const plain = parsed.message && parsed.message !== text ? parsed.message : text;
  const readable = plain.length <= 200 && !/[{}]/.test(plain);
  return readable
    ? { summary: sentence(plain), detail: plain === text ? null : text }
    : { summary: 'The model request failed.', detail: text };
}

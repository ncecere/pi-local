/**
 * A bounded, redacted view of a tool call's arguments, for the people who decide an approval (docs/approvals.md). The
 * platform applies the same rules again (internal/agents/redact.go, which must agree): the runtime is not trusted to.
 *
 * - A value is redacted when its key clearly names a credential (`isSecretKey`) or when it looks like one
 *   (`isSecretValue`), and reads `[redacted, N characters]` (N: the string's length in characters, or its JSON's for
 *   another value). A value already redacted so is kept.
 * - A string that holds a credential among other text (a command with a token in it) is redacted in place by
 *   `redactText`, the same rules the secret scrubbing of tool results uses (scrub.ts), so the two agree.
 * - Strings are cut at 2,000 characters, arrays at 100 items, objects at 100 keys, nesting at 6 levels.
 * - A view whose JSON is still over 16 KiB is replaced by `{"[truncated]": "<the first 2,000 characters>"}`.
 */
const MAX_STRING = 2000;
const MAX_ITEMS = 100;
const MAX_DEPTH = 6;
export const MAX_ARGUMENTS_BYTES = 16 * 1024;

/**
 * Keys (lower case, letters and digits only) that name a credential, whole or as their end. Names that only might
 * (`key`, `auth`, `headers`, `signature`) are left to the value checks: an S3 object's key is not a secret.
 */
const SECRET_EXACT = new Set(["authorization", "proxyauthorization", "cookie", "setcookie", "credentials", "credential", "bearer", "sessionid", "xapikey"]);
const SECRET_SUFFIX = ["password", "passwd", "passphrase", "secret", "apikey", "secretkey", "privatekey", "secretaccesskey", "token"];
/** Names ending in "token" that are not credentials (pagination). */
const NOT_SECRET = new Set(["pagetoken", "nextpagetoken", "prevpagetoken", "previouspagetoken", "continuationtoken", "synctoken", "nexttoken", "cursortoken"]);

/**
 * Values that look like credentials: known token prefixes (the platform's own, OpenAI and Stripe, GitHub, GitLab, Slack,
 * AWS key IDs, Google API keys, Hugging Face, npm), an Authorization header's value, a JWT, a PEM private key, and a long
 * random-looking string (32-512 characters of base64 or base64url with upper and lower case letters and digits, and at
 * least 4 bits of entropy per character).
 */
const SECRET_PREFIX = /^(?:pdp[a-z]{0,3}[_.]|sk-|sk_(?:live|test)_|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[abeprs]-|AKIA|ASIA|AIza|hf_|npm_)[A-Za-z0-9_.-]{16,}$/;
const AUTH_VALUE = /^(?:bearer|basic|token)\s+\S{8,}$/i;
const JWT = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;
const RANDOM = /^[A-Za-z0-9+/=_-]{32,512}$/;
const REDACTED_MARK = /^\[redacted(?:, [0-9]{1,9} characters?)?\]$/;

/** Whether a key names a credential: `Authorization`, `api_key`, `clientSecret`, `refresh-token`, `password`, ... */
export function isSecretKey(key: string): boolean {
	const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (SECRET_EXACT.has(k)) return true;
	if (NOT_SECRET.has(k)) return false;
	return SECRET_SUFFIX.some((s) => k.endsWith(s));
}

/** Whether a string looks like a credential. Conservative: identifiers, paths, one-case hashes, UUIDs and prose show. */
export function isSecretValue(value: string): boolean {
	const v = value.trim();
	if (SECRET_PREFIX.test(v) || AUTH_VALUE.test(v) || JWT.test(v)) return true;
	if (v.includes("-----BEGIN") && v.includes("PRIVATE KEY")) return true;
	return RANDOM.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9]/.test(v) && entropy(v) >= 4;
}

/** A string's Shannon entropy in bits per character. */
function entropy(s: string): number {
	const chars = [...s];
	const counts = new Map<string, number>();
	for (const c of chars) counts.set(c, (counts.get(c) ?? 0) + 1);
	let h = 0;
	for (const n of counts.values()) {
		const p = n / chars.length;
		h -= p * Math.log2(p);
	}
	return h;
}

/** What a redacted value reads: its length in characters (a string's, or its JSON's), never any of it. */
export function redactedMark(value: unknown): string {
	if (typeof value === "string" && REDACTED_MARK.test(value)) return value;
	const n = typeof value === "string" ? [...value].length : [...(JSON.stringify(value) ?? "")].length;
	return n === 1 ? "[redacted, 1 character]" : `[redacted, ${n} characters]`;
}

export function redactArguments(value: unknown): unknown {
	const view = redact(value, 0);
	const json = JSON.stringify(view) ?? "null";
	if (Buffer.byteLength(json, "utf8") <= MAX_ARGUMENTS_BYTES) return view;
	return { "[truncated]": json.slice(0, MAX_STRING) };
}

function redact(value: unknown, depth: number): unknown {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		if (isSecretValue(value)) return redactedMark(value);
		const text = redactText(value, ARGUMENT_MARKS);
		return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text;
	}
	if (depth >= MAX_DEPTH) return "[…]";
	if (Array.isArray(value)) {
		const items = value.slice(0, MAX_ITEMS).map((item) => redact(item, depth + 1));
		if (value.length > MAX_ITEMS) items.push(`[… ${value.length - MAX_ITEMS} more]`);
		return items;
	}
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		const entries = Object.entries(value as Record<string, unknown>);
		for (const [key, item] of entries.slice(0, MAX_ITEMS)) {
			const name = key.length > 200 ? `${key.slice(0, 200)}…` : key;
			out[name] = isSecretKey(key) ? redactedMark(item) : redact(item, depth + 1);
		}
		if (entries.length > MAX_ITEMS) out["[…]"] = `${entries.length - MAX_ITEMS} more keys`;
		return out;
	}
	return null;
}

// ── Free text ─────────────────────────────────────────────────────────────────────────────────────────────────
// The same rules applied to what is found in text: a tool's output, a command, a log line. A port of RedactText in
// internal/agents/redact.go (the two share the cases in internal/agents/testdata/redact-text.json).

/** What a redacted part reads. */
export type RedactMarks = {
	/** A credential found: the value's mark. */
	value(found: string): string;
	/** A private key block. */
	pem: string;
	/** A bearer or basic token after the word. */
	bearer: string;
};

/** The approvals view's marks: the length of what was hidden. */
export const ARGUMENT_MARKS: RedactMarks = { value: redactedMark, pem: "[redacted private key]", bearer: "[redacted]" };

const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const HEADER_LINE = /\b(authorization|proxy-authorization|cookie|set-cookie)(["']?[ \t]*[:=][ \t]*["']?)([^\r\n"']+)/gi;
const BEARER_TEXT = /\b(bearer|basic)[ \t]+[^\s"',;]{8,}/gi;
// The lookbehind starts a key only at the start of a run of name characters (a long run is then scanned once).
const ASSIGNMENT = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(["']?[ \t]*[:=][ \t]*)("[^"\r\n]*"|'[^'\r\n]*'|\[redacted[^\]\r\n]*\]|[^\s,;&"'\]})]+)/g;
const URL_USERINFO = /(:\/\/[^/\s:@]+:)([^@\s/]+)(@)/g;
const TEXT_TOKEN = /[^\s"'`<>()[\]{},;|]+/g;
const WORD_PIECE = /[^/?&=@#:]+/g;
const PATH_LIKE = /\/.*\//;

/** Whether a value has a known credential's shape: a token prefix, an Authorization value, a JWT. */
export function knownTokenShape(v: string): boolean {
	return SECRET_PREFIX.test(v) || AUTH_VALUE.test(v) || JWT.test(v);
}

/**
 * Redacts the credentials in free text: PEM private keys, Authorization and Cookie header lines, bearer tokens,
 * `name: value` and `name=value` where the name is a credential's (including in URLs and JSON), passwords in URLs, and
 * any word that looks like a credential (`isSecretValue`). A long path is never mistaken for a random string, and
 * prose ("basic understanding", `token: true`) is left alone.
 */
export function redactText(text: string, marks: RedactMarks): string {
	if (text === "") return text;
	let out = text.replace(PEM_BLOCK, marks.pem);
	out = out.replace(HEADER_LINE, (_m, name: string, sep: string, value: string) => `${name}${sep}${marks.value(value.replace(/[ \t]+$/, ""))}`);
	out = out.replace(BEARER_TEXT, (m: string) => {
		const i = m.search(/[ \t]/);
		return tokenLike(m.slice(i).replace(/^[ \t]+/, "")) ? `${m.slice(0, i)} ${marks.bearer}` : m;
	});
	out = redactAssignments(out, marks);
	out = out.replace(URL_USERINFO, `$1${marks.bearer}$3`);
	return out.replace(TEXT_TOKEN, (word) => redactWord(word, marks));
}

function redactAssignments(text: string, marks: RedactMarks): string {
	ASSIGNMENT.lastIndex = 0;
	let out = "";
	let pos = 0;
	for (;;) {
		ASSIGNMENT.lastIndex = pos;
		const m = ASSIGNMENT.exec(text);
		if (m === null) break;
		const end = m.index + m[0].length;
		const valueStart = m.index + m[1]!.length + m[2]!.length;
		const value = m[3]!;
		if (!isSecretKey(m[1]!) || REDACTED_MARK_IN_TEXT.test(value.replace(/^["']|["']$/g, "")) || benignValue(value)) {
			out += text.slice(pos, valueStart);
			pos = Math.max(valueStart, pos + 1);
			if (pos > text.length) break;
			continue;
		}
		out += text.slice(pos, valueStart);
		const quote = value[0];
		out += value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote) ? `${quote}${marks.value(value.slice(1, -1))}${quote}` : marks.value(value);
		pos = end;
	}
	return out + text.slice(pos);
}

/** An already redacted value: either mark (`[redacted, N characters]`, `[redacted secret]`, `[redacted]`). */
const REDACTED_MARK_IN_TEXT = /^\[redacted(?:[^\]\r\n]*)\]$/;

function redactWord(word: string, marks: RedactMarks): string {
	const lead = word.match(/^[.:]*/)![0];
	const core = word.slice(lead.length);
	const body = core.replace(/[.:!?]+$/, "");
	const trail = core.slice(body.length);
	if (body === "" || REDACTED_MARK_IN_TEXT.test(body)) return word;
	const pathLike = PATH_LIKE.test(body);
	// A word with a separator inside (`NAME=value`, a URL's query) is judged by its parts, not as one random string.
	const joined = /[?&=@#:]/.test(body.replace(/=+$/, ""));
	if (knownTokenShape(body) || (!pathLike && !joined && isSecretValue(body))) return lead + marks.value(body) + trail;
	if (!/[/?&=@#:]/.test(body)) return word;
	const pieces = body.replace(WORD_PIECE, (piece) => {
		if (REDACTED_MARK_IN_TEXT.test(piece)) return piece;
		return knownTokenShape(piece) || (!pathLike && isSecretValue(piece)) ? marks.value(piece) : piece;
	});
	return lead + pieces + trail;
}

/** Whether the word after "Bearer" or "Basic" reads like a credential and not like prose. */
function tokenLike(v: string): boolean {
	v = v.replace(/[.:!?]+$/, "");
	if (v.length < 8) return false;
	let caps = 0;
	for (let i = 0; i < v.length; i++) {
		const c = v[i]!;
		if ((c >= "0" && c <= "9") || "_+/=.-".includes(c)) return true;
		if (c >= "A" && c <= "Z" && i > 0) caps++;
	}
	return caps >= 2;
}

/** What a credential's name is often given that is no credential: a flag, a number, empty, a placeholder. */
function benignValue(raw: string): boolean {
	const v = raw.replace(/^["']+|["']+$/g, "").trim();
	if (["", "true", "false", "null", "nil", "none", "undefined", "yes", "no", "on", "off"].includes(v.toLowerCase())) return true;
	if (v.startsWith("$") || v.startsWith("<") || v.startsWith("{") || v.startsWith("[") || v.startsWith("%") || /^[*x•]+$/.test(v)) return true;
	if (!/[\p{L}\p{N}]/u.test(v)) return true; // only punctuation: [], (), ---
	return /^[0-9.]+$/.test(v);
}

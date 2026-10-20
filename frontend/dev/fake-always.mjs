// The fake API's Phase 7 (docs/api.md, "Always on"): schedules and their runs, message search, forking a
// conversation, and the desktop settings. In memory, development only; see fake-models-api.mjs.
//
//   FAKE_BROWSER=1   /api/settings/desktop says available: false (as the headless server does)
import { randomUUID } from 'node:crypto';

const MIN = 60_000;

/** The minutes of an hour, hours of a day… a cron field allows (*, lists, ranges, steps, names). */
function cronField(field, min, max, names = []) {
  const values = new Set();
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let from = min;
    let to = max;
    if (range !== '*' && range !== '?') {
      const value = (v) => {
        const named = names.indexOf(v.toLowerCase());
        if (named >= 0) return named + min;
        return /^\d+$/.test(v) ? Number(v) : Number.NaN;
      };
      const [a, b] = range.split('-');
      from = value(a);
      to = b === undefined ? (stepText === undefined ? from : max) : value(b);
      if (Number.isNaN(from) || Number.isNaN(to) || from < min || to > max || to < from)
        return null;
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

/** The next time a cron expression fires after `after`, in `timezone`; null when it is not one. */
function nextCron(expression, timezone, after) {
  const expr = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = cronField(fields[0], 0, 59);
  const hours = cronField(fields[1], 0, 23);
  const doms = cronField(fields[2], 1, 31);
  const months = cronField(fields[3], 1, 12, [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ]);
  const dows = cronField(fields[4], 0, 7, ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  if (!minutes || !hours || !doms || !months || !dows) return null;
  if (dows.has(7)) dows.add(0);
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let t = Math.floor(after / MIN) * MIN + MIN;
  for (let i = 0; i < 366 * 24 * 60; i++, t += MIN) {
    const p = Object.fromEntries(format.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    if (
      minutes.has(Number(p.minute)) &&
      hours.has(Number(p.hour) % 24) &&
      doms.has(Number(p.day)) &&
      months.has(Number(p.month)) &&
      dows.has(days.indexOf(p.weekday))
    )
      return t;
  }
  return null;
}

/** The instant a wall-clock time ("2026-10-21T09:00") names in `timezone` (or the ISO time with an offset). */
function parseAt(text, timezone) {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) return Date.parse(text);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!m) return Number.NaN;
  const wanted = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });
  const offsetAt = (ms) => {
    const p = Object.fromEntries(format.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - ms;
  };
  let guess = wanted - offsetAt(wanted);
  guess = wanted - offsetAt(guess);
  return guess;
}

const validZone = (zone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** Words of 2+ letters, accents and case aside. */
const fold = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function createAlways({
  agents,
  threads,
  chatViews,
  thread,
  broadcast,
  startReply,
  syncThreadView,
  ok,
  fail,
}) {
  const now = Date.now();
  const LEAD = agents[0].id;
  const SCOUT = agents[2].id;
  const schedules = [];
  const runs = new Map(); // scheduleId -> Run[] (newest first)
  const failures = new Map();

  const view = (s) => ({
    ...s,
    agentName: agents.find((a) => a.id === s.agentId)?.name ?? 'An agent',
  });
  const note = (s) =>
    broadcast('schedule', { scheduleId: s.id, deleted: false, schedule: view(s) });
  const sorted = () =>
    schedules
      .slice()
      .sort(
        (a, b) =>
          (a.nextFireAt ?? Number.POSITIVE_INFINITY) - (b.nextFireAt ?? Number.POSITIVE_INFINITY),
      )
      .map(view);

  const base = (extra) => ({
    id: `sc_${randomUUID().slice(0, 12)}`,
    name: '',
    once: false,
    at: null,
    cron: null,
    timezone: 'America/New_York',
    message: '',
    threadMode: 'new',
    threadId: null,
    originThreadId: null,
    madeBy: 'user',
    missedPolicy: 'run_once',
    paused: false,
    pausedReason: null,
    nextFireAt: null,
    lastFireAt: null,
    lastRun: null,
    createdAt: now,
    ...extra,
  });

  // A seeded run whose conversation exists.
  const seedThread = 'sched-seed-briefing';
  threads[LEAD].push(
    thread(seedThread, 'Morning briefing', {
      createdAt: now - 3 * 3600_000,
      updatedAt: now - 3 * 3600_000 + 9000,
    }),
  );
  chatViews[seedThread] = {
    busy: false,
    tools: [],
    messages: [
      {
        id: 'su1',
        role: 'user',
        text: '[Message from trigger Morning briefing]\nSummarise my unread issues and what changed since yesterday.',
        author: { kind: 'trigger', id: 'sc_seed1', name: 'Morning briefing' },
        at: now - 3 * 3600_000,
      },
      {
        id: 'sa1',
        role: 'assistant',
        text: 'Three issues changed overnight: the **flaky upload test** was fixed, two new bug reports came in.',
        at: now - 3 * 3600_000 + 2000,
      },
    ],
  };
  const seedRun = {
    id: 'run_seed1',
    scheduleId: 'sc_seed1',
    threadId: seedThread,
    firedAt: now - 3 * 3600_000,
    status: 'done',
    error: null,
    finishedAt: now - 3 * 3600_000 + 9000,
  };
  schedules.push(
    base({
      id: 'sc_seed1',
      agentId: LEAD,
      name: 'Morning briefing',
      cron: '0 9 * * 1-5',
      message: 'Summarise my unread issues and what changed since yesterday.',
      nextFireAt: nextCron('0 9 * * 1-5', 'America/New_York', now),
      lastFireAt: seedRun.firedAt,
      lastRun: seedRun,
      createdAt: now - 7 * 86_400_000,
    }),
    base({
      id: 'sc_seed2',
      agentId: SCOUT,
      name: 'Check the arXiv listing again',
      once: true,
      at: now + 26 * 3600_000,
      timezone: 'Europe/London',
      message: 'Look for new papers on durable agent runtimes and tell me what is new.',
      madeBy: 'agent',
      originThreadId: 'th-scout-1',
      nextFireAt: now + 26 * 3600_000,
    }),
    base({
      id: 'sc_seed3',
      agentId: LEAD,
      name: 'Sync the notes folder',
      cron: '*/30 9-17 * * 1-5',
      threadMode: 'this',
      threadId: 'th-lead-2',
      message: 'Tidy the notes folder and commit.',
      missedPolicy: 'skip',
      paused: true,
      pausedReason: 'It failed 5 times in a row: the model provider refused the key (401).',
      nextFireAt: nextCron('*/30 9-17 * * 1-5', 'America/New_York', now),
      lastFireAt: now - 26 * 60_000,
      lastRun: {
        id: 'run_seed3',
        scheduleId: 'sc_seed3',
        threadId: 'th-lead-2',
        firedAt: now - 26 * 60_000,
        status: 'failed',
        error: 'The model provider refused the key (401).',
        finishedAt: now - 25 * 60_000,
      },
    }),
  );
  runs.set('sc_seed1', [
    seedRun,
    {
      ...seedRun,
      id: 'run_seed0',
      firedAt: seedRun.firedAt - 86_400_000,
      finishedAt: seedRun.finishedAt - 86_400_000,
    },
  ]);
  runs.set('sc_seed3', [schedules[2].lastRun]);

  /** Sends the schedule's message (as a trigger) and ends the run a few seconds later. */
  function fire(s, manual) {
    const threadId = s.threadMode === 'this' && s.threadId ? s.threadId : `sched-${randomUUID()}`;
    threads[s.agentId] ??= [];
    const list = threads[s.agentId];
    let t = list.find((x) => x.threadId === threadId);
    if (!t) {
      t = thread(threadId, s.name, { createdAt: Date.now(), updatedAt: Date.now() });
      list.unshift(t);
      chatViews[threadId] = { busy: false, tools: [], messages: [] };
    }
    t.busy = true;
    t.updatedAt = Date.now();
    broadcast('thread', { agentId: s.agentId, threadId, deleted: false, thread: t });
    const text = `[Message from trigger ${s.name}]\n${s.message}`;
    const cv = chatViews[threadId];
    if (cv && !cv.busy) {
      cv.messages.push({
        id: `u-${Date.now()}`,
        role: 'user',
        text,
        at: Date.now(),
        author: { kind: 'trigger', id: s.id, name: s.name },
      });
      syncThreadView(threadId);
      startReply(threadId, s.message);
    }
    const run = {
      id: `run_${randomUUID().slice(0, 10)}`,
      scheduleId: s.id,
      threadId,
      firedAt: Date.now(),
      status: 'running',
      error: null,
      finishedAt: null,
    };
    runs.set(s.id, [run, ...(runs.get(s.id) ?? [])]);
    s.lastRun = run;
    s.lastFireAt = run.firedAt;
    if (!manual) {
      s.nextFireAt = s.once ? null : nextCron(s.cron, s.timezone, Date.now());
    }
    note(s);
    // FAKE_FAIL_RUNS=1: runs fail (5 in a row pause the schedule).
    const failing = process.env.FAKE_FAIL_RUNS === '1';
    setTimeout(() => {
      run.status = failing ? 'failed' : 'done';
      run.error = failing ? 'The agent could not be started (fake failure).' : null;
      run.finishedAt = Date.now();
      t.busy = false;
      t.lastReplyAt = Date.now();
      broadcast('thread', { agentId: s.agentId, threadId, deleted: false, thread: t });
      const n = failing ? (failures.get(s.id) ?? 0) + 1 : 0;
      failures.set(s.id, n);
      if (n >= 5) {
        s.paused = true;
        s.pausedReason = `It failed 5 times in a row: ${run.error}`;
      }
      broadcast('schedule_run', { scheduleId: s.id, agentId: s.agentId, name: s.name, run });
      note(s);
    }, 6000);
    return run;
  }

  setInterval(() => {
    const t = Date.now();
    for (const s of schedules)
      if (!s.paused && s.nextFireAt !== null && s.nextFireAt <= t) fire(s, false);
  }, 5000);

  /** Applies a create/patch body to `s`; an error to answer, or null. */
  function apply(s, body, creating) {
    const d = { ...s };
    if (body.name !== undefined) d.name = String(body.name).trim();
    if (body.timezone) d.timezone = body.timezone;
    if (body.message !== undefined) d.message = String(body.message).trim();
    if (body.threadMode !== undefined) d.threadMode = body.threadMode;
    if (body.threadId !== undefined) d.threadId = body.threadId || null;
    if (body.missedPolicy !== undefined) d.missedPolicy = body.missedPolicy;
    if (body.paused !== undefined) {
      d.paused = Boolean(body.paused);
      if (!d.paused) {
        d.pausedReason = null;
        failures.set(s.id, 0);
      }
    }
    if (!validZone(d.timezone)) return ['invalid_timezone', `"${d.timezone}" isn't a time zone.`];
    if (!d.message || d.message.length > 32_000)
      return ['invalid_message', 'The message is 1 to 32,000 characters.'];
    if (!d.name) d.name = d.message.split('\n')[0].slice(0, 80);
    if (d.threadMode !== 'new' && d.threadMode !== 'this')
      return [
        'invalid_thread_mode',
        'A schedule fires in a new conversation each time (new) or in one conversation (this).',
      ];
    if (d.threadMode === 'this' && !d.threadId)
      return ['invalid_thread_mode', 'Name the conversation it fires in.'];
    if (body.at && body.cron)
      return ['invalid_when', 'A schedule is a one-time time (at) or a cron expression, not both.'];
    let changedWhen = false;
    if (body.cron) {
      if (nextCron(body.cron, d.timezone, Date.now()) === null)
        return [
          'invalid_cron',
          `"${body.cron}" isn't a cron expression (five fields: minute hour day month weekday, or @daily).`,
        ];
      d.cron = body.cron.trim();
      d.once = false;
      d.at = null;
      changedWhen = true;
    }
    if (body.at) {
      const at = parseAt(body.at, d.timezone);
      if (Number.isNaN(at)) return ['invalid_time', `"${body.at}" isn't a date and time.`];
      if (at < Date.now() - MIN) return ['invalid_time', 'That time has passed.'];
      d.at = at;
      d.once = true;
      d.cron = null;
      changedWhen = true;
    }
    if (creating && !changedWhen)
      return ['invalid_when', 'Say when: a date and time, or a cron expression.'];
    if (changedWhen || body.timezone)
      d.nextFireAt = d.once ? d.at : nextCron(d.cron, d.timezone, Date.now());
    Object.assign(s, d);
    return null;
  }

  /** Every conversation's indexed text, searched as the backend does (word starts, accents aside). */
  function search(q) {
    const words = fold(q).match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    if (words.length === 0) return [];
    const results = [];
    for (const [agentId, list] of Object.entries(threads))
      for (const t of list) {
        const cv = chatViews[t.threadId];
        if (!cv) continue;
        for (const message of cv.messages) {
          if (message.role === 'tool' || !message.text) continue;
          const text = message.text.replace(/\s+/g, ' ');
          const folded = fold(text);
          const hits = [];
          let all = true;
          for (const word of words) {
            const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${word}[\\p{L}\\p{N}]*)`, 'gu');
            let found = false;
            for (const m of folded.matchAll(re)) {
              found = true;
              hits.push([m.index + m[1].length, m.index + m[1].length + m[2].length]);
            }
            all &&= found;
          }
          if (!all) continue;
          hits.sort((a, b) => a[0] - b[0]);
          const from = Math.max(0, hits[0][0] - 40);
          const to = Math.min(text.length, hits[0][1] + 80);
          let snippet = '';
          let at = from;
          for (const [a, b] of hits) {
            if (a < at || b > to) continue;
            snippet += `${text.slice(at, a)}\u0001${text.slice(a, b)}\u0002`;
            at = b;
          }
          snippet += text.slice(at, to);
          results.push({
            agentId,
            threadId: t.threadId,
            snippet: `${from > 0 ? '…' : ''}${snippet}${to < text.length ? '…' : ''}`,
            indexedAt: new Date(t.updatedAt).toISOString(),
          });
          break;
        }
      }
    return results.slice(0, 30);
  }

  let launchAtLogin = false;

  /** Answers a Phase 7 route; false when it isn't one. */
  return function handle(res, { path, parts, m, body, url }) {
    const json = (data, status = 200) => {
      ok(res, data, status);
      return true;
    };
    const refuse = (status, code, message) => {
      fail(res, status, code, message);
      return true;
    };
    if (path === '/api/settings/desktop') {
      const available = process.env.FAKE_BROWSER !== '1';
      if (m === 'PUT') {
        if (!available) return refuse(409, 'unavailable', 'Only the desktop app opens at login.');
        launchAtLogin = Boolean(body.launchAtLogin);
      }
      return json({ available, launchAtLogin: available && launchAtLogin });
    }
    if (path === '/api/search' && m === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      if (q.length > 200) return refuse(400, 'invalid_query', 'At most 200 characters.');
      return json({ results: search(q) });
    }
    if (path === '/api/schedules' && m === 'GET') return json(sorted());
    if (parts[1] === 'agents' && parts[2] && parts[3] === 'schedules' && parts.length === 4) {
      const a = agents.find((x) => x.id === parts[2]);
      if (!a) return refuse(404, 'not_found', 'No such agent.');
      if (m === 'GET') return json(sorted().filter((s) => s.agentId === a.id));
      if (m === 'POST') {
        const s = base({ agentId: a.id, createdAt: Date.now() });
        const problem = apply(s, { timezone: 'UTC', ...body }, true);
        if (problem) return refuse(400, ...problem);
        schedules.push(s);
        note(s);
        return json(view(s), 201);
      }
    }
    if (parts[1] === 'schedules' && parts[2]) {
      const s = schedules.find((x) => x.id === parts[2]);
      if (!s) return refuse(404, 'not_found', 'No such schedule.');
      if (parts.length === 3 && m === 'PATCH') {
        const problem = apply(s, body, false);
        if (problem) return refuse(400, ...problem);
        note(s);
        return json(view(s));
      }
      if (parts.length === 3 && m === 'DELETE') {
        schedules.splice(schedules.indexOf(s), 1);
        broadcast('schedule', { scheduleId: s.id, deleted: true });
        return json({ ok: true });
      }
      if (parts[3] === 'run' && m === 'POST') return json(fire(s, true));
      if (parts[3] === 'runs' && m === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 50) || 50;
        return json((runs.get(s.id) ?? []).slice(0, limit));
      }
    }
    // POST /api/agents/{a}/threads/{t}/fork {beforeMessageId | afterMessageId}
    if (parts[1] === 'agents' && parts[3] === 'threads' && parts[5] === 'fork' && m === 'POST') {
      const source = (threads[parts[2]] ?? []).find((x) => x.threadId === parts[4]);
      const cv = chatViews[parts[4]];
      if (!source || !cv) return refuse(404, 'thread_not_found', 'Conversation not found');
      const before = body.beforeMessageId;
      const after = body.afterMessageId;
      if (Boolean(before) === Boolean(after))
        return refuse(400, 'invalid_message_id', 'Give beforeMessageId or afterMessageId.');
      const index = cv.messages.findIndex((x) => x.id === (before ?? after));
      if (index < 0 || (before && cv.messages[index].role !== 'user'))
        return refuse(400, 'invalid_message_id', 'No such message in this conversation.');
      const kept = structuredClone(cv.messages.slice(0, before ? index : index + 1));
      const threadId = randomUUID();
      chatViews[threadId] = { busy: false, tools: [], messages: kept };
      const t = thread(threadId, source.title, {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastReplyAt: null,
      });
      threads[parts[2]] = [t, ...(threads[parts[2]] ?? [])];
      broadcast('thread', { agentId: parts[2], threadId, deleted: false, thread: t });
      return json(t, 201);
    }
    return false;
  };
}

import {Events, JSONStream} from "@wailsio/runtime";

const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");
const log = (msg, cls) => {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
    logEl.appendChild(line);
    console.log(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

const results = {
    env: {
        href: location.href,
        origin: location.origin,
        isSecureContext: window.isSecureContext,
        userAgent: navigator.userAgent,
        startedAt: new Date().toISOString(),
    },
    tests: {},
};

function withTimeout(p, ms, label) {
    return Promise.race([p, sleep(ms).then(() => { throw new Error(`timeout ${label} after ${ms}ms`); })]);
}

function pct(arr, p) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// Summarize per-event arrival data: [{n, t (server ms), recv (client ms)}]
function summarize(events, startedAt, expectedSpanMs) {
    const lat = events.map((e) => e.recv - e.t);
    const recvs = events.map((e) => e.recv);
    const span = recvs.length ? recvs[recvs.length - 1] - recvs[0] : 0;
    const serverSpan = events.length ? events[events.length - 1].t - events[0].t : 0;
    // count distinct arrival bursts (gap > 100ms between consecutive arrivals)
    let bursts = events.length ? 1 : 0;
    for (let i = 1; i < recvs.length; i++) if (recvs[i] - recvs[i - 1] > 100) bursts++;
    return {
        count: events.length,
        firstArrivalAfterOpenMs: recvs.length ? recvs[0] - startedAt : null,
        arrivalSpanMs: span,
        serverSpanMs: serverSpan,
        bursts,
        latencyMs: {min: Math.min(...lat), p50: pct(lat, 50), p95: pct(lat, 95), max: Math.max(...lat), mean: lat.length ? +(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(2) : null},
        incremental: events.length > 2 && span > 0.7 * (expectedSpanMs ?? serverSpan) && bursts > events.length / 2,
        sample: events.slice(0, 3).concat(events.slice(-2)),
    };
}

async function streamInfo(id) {
    const r = await fetch(`/api/stream-info?id=${id}`);
    return r.json();
}

// ---- EventSource consumer --------------------------------------------------
function runEventSource(url, {closeAfterMs, expectedSpanMs} = {}) {
    return new Promise((resolve) => {
        const events = [];
        const startedAt = Date.now();
        let opened = null;
        const errors = [];
        const es = new EventSource(url);
        const finish = (why) => {
            es.close();
            resolve({why, openedAfterMs: opened, errors, readyState: es.readyState, ...summarize(events, startedAt, expectedSpanMs)});
        };
        es.onopen = () => { opened = Date.now() - startedAt; };
        es.addEventListener("tick", (ev) => {
            const d = JSON.parse(ev.data);
            events.push({n: d.n, t: d.t, recv: Date.now()});
        });
        es.addEventListener("done", () => finish("done"));
        es.onerror = () => {
            errors.push({atMs: Date.now() - startedAt, readyState: es.readyState});
            if (es.readyState === EventSource.CLOSED || errors.length > 3) finish("error");
        };
        if (closeAfterMs) setTimeout(() => finish("closed-by-client"), closeAfterMs);
    });
}

// ---- fetch() + ReadableStream reader consumer ------------------------------
async function runFetchStream(url, {abortAfterMs, cancelReaderAfterMs, expectedSpanMs} = {}) {
    const events = [];
    const chunks = [];
    const startedAt = Date.now();
    const ac = new AbortController();
    if (abortAfterMs) setTimeout(() => ac.abort(), abortAfterMs);
    const res = await fetch(url, {signal: ac.signal, headers: {Accept: "text/event-stream"}});
    const headersAfterMs = Date.now() - startedAt;
    const reader = res.body.getReader();
    if (cancelReaderAfterMs) setTimeout(() => reader.cancel("client cancel"), cancelReaderAfterMs);
    const dec = new TextDecoder();
    let buf = "";
    let why = "eof";
    try {
        for (;;) {
            const {value, done} = await reader.read();
            if (done) break;
            const now = Date.now();
            chunks.push({atMs: now - startedAt, bytes: value.byteLength});
            buf += dec.decode(value, {stream: true});
            let idx;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
                const block = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                let ev = "message", data = "";
                for (const line of block.split("\n")) {
                    if (line.startsWith("event:")) ev = line.slice(6).trim();
                    else if (line.startsWith("data:")) data += line.slice(5).trim();
                }
                if (ev === "tick") {
                    const d = JSON.parse(data);
                    events.push({n: d.n, t: d.t, recv: now});
                }
            }
        }
    } catch (e) {
        why = `${e.name}: ${e.message}`;
    }
    return {
        why, status: res.status, contentType: res.headers.get("content-type"), headersAfterMs,
        chunkCount: chunks.length, firstChunks: chunks.slice(0, 5), lastChunks: chunks.slice(-3),
        ...summarize(events, startedAt, expectedSpanMs),
    };
}

// ---- tests -----------------------------------------------------------------
async function test(name, fn, timeoutMs = 30000) {
    statusEl.textContent = `running ${name}…`;
    log(`▶ ${name}`);
    try {
        const r = await withTimeout(fn(), timeoutMs, name);
        results.tests[name] = r;
        log(`✔ ${name}: ${JSON.stringify(compact(r))}`, "ok");
    } catch (e) {
        results.tests[name] = {error: `${e.name}: ${e.message}`};
        log(`✘ ${name}: ${e.name}: ${e.message}`, "bad");
    }
}

function compact(r) {
    if (!r || typeof r !== "object") return r;
    const {sample, firstChunks, lastChunks, ...rest} = r;
    return rest;
}

async function main() {
    await test("ping", async () => {
        const t0 = performance.now();
        const r = await fetch("/api/ping");
        const body = await r.json();
        document.getElementById("mode").textContent = body.mode;
        return {status: r.status, rttMs: +(performance.now() - t0).toFixed(2), body};
    });

    await test("echo-small", async () => {
        const payload = {hello: "world", n: 42, nested: {arr: [1, 2, 3]}, unicode: "héllo ✓"};
        const r = await fetch("/api/echo", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
        const body = await r.json();
        return {status: r.status, bytes: body.bytes, roundTripEqual: JSON.stringify(body.echo) === JSON.stringify(payload)};
    });

    await test("echo-1MB", async () => {
        const payload = {big: "x".repeat(1024 * 1024)};
        const t0 = performance.now();
        const r = await fetch("/api/echo", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
        const body = await r.json();
        return {status: r.status, bytes: body.bytes, roundTripEqual: body.echo?.big?.length === payload.big.length, ms: +(performance.now() - t0).toFixed(1)};
    });

    await test("echo-blob-body", async () => {
        // Blob/stream-ish bodies may arrive via HTTPBodyStream instead of HTTPBody.
        const payload = {kind: "blob", v: [1, 2, 3]};
        const r = await fetch("/api/echo", {method: "POST", headers: {"Content-Type": "application/json"}, body: new Blob([JSON.stringify(payload)])});
        const body = await r.json();
        return {status: r.status, bytes: body.bytes, roundTripEqual: JSON.stringify(body.echo) === JSON.stringify(payload)};
    });

    await test("echo-body-variants", async () => {
        const payload = {kind: "variant", v: [1, 2, 3]};
        const json = JSON.stringify(payload);
        const enc = new TextEncoder().encode(json);
        const variants = {
            string: () => json,
            blob: () => new Blob([json], {type: "application/json"}),
            arrayBuffer: () => enc.buffer.slice(0),
            uint8array: () => new Uint8Array(enc),
            formData: () => { const f = new FormData(); f.append("j", json); return f; },
            urlSearchParams: () => new URLSearchParams({j: json}),
        };
        const out = {};
        for (const [k, mk] of Object.entries(variants)) {
            try {
                const r = await fetch(`/api/echo?raw=1&v=${k}`, {method: "POST", headers: k === "formData" || k === "urlSearchParams" ? {} : {"Content-Type": "application/json"}, body: mk()});
                const body = await r.json();
                out[k] = {status: r.status, bytesReceivedByGo: body.bytes};
            } catch (e) { out[k] = {error: `${e.name}: ${e.message}`}; }
        }
        return out;
    });

    let id = uid("es");
    await test("sse-eventsource-10s", async () => {
        const r = await runEventSource(`/api/stream?id=${id}&client=eventsource&dur=10000`, {expectedSpanMs: 9750});
        r.server = await streamInfo(id);
        return r;
    });

    id = uid("fetch");
    await test("sse-fetch-reader-10s", async () => {
        const r = await runFetchStream(`/api/stream?id=${id}&client=fetch&dur=10000`, {expectedSpanMs: 9750});
        r.server = await streamInfo(id);
        return r;
    });

    id = uid("noflush");
    await test("sse-fetch-reader-noflush-3s", async () => {
        const r = await runFetchStream(`/api/stream?id=${id}&client=fetch-noflush&dur=3000&flush=0`, {expectedSpanMs: 2750});
        r.server = await streamInfo(id);
        return r;
    });

    id = uid("escancel");
    await test("cancel-eventsource-close", async () => {
        const r = await runEventSource(`/api/stream?id=${id}&client=es-cancel&dur=10000`, {closeAfterMs: 1200});
        await sleep(1000);
        return {received: r.count, why: r.why, server: await streamInfo(id)};
    });

    id = uid("abort");
    await test("cancel-fetch-abortcontroller", async () => {
        const r = await runFetchStream(`/api/stream?id=${id}&client=fetch-abort&dur=10000`, {abortAfterMs: 1200});
        await sleep(1000);
        return {received: r.count, why: r.why, server: await streamInfo(id)};
    });

    id = uid("rcancel");
    await test("cancel-fetch-reader-cancel", async () => {
        const r = await runFetchStream(`/api/stream?id=${id}&client=reader-cancel&dur=10000`, {cancelReaderAfterMs: 1200});
        await sleep(1000);
        return {received: r.count, why: r.why, server: await streamInfo(id)};
    });

    await test("concurrency-6-streams-plus-ping", async () => {
        const ps = [];
        for (let i = 0; i < 6; i++) ps.push(runEventSource(`/api/stream?id=${uid("conc")}&client=conc&dur=3000`, {expectedSpanMs: 2750}));
        await sleep(1500);
        const t0 = performance.now();
        await (await fetch("/api/ping")).json();
        const pingDuringStreamsMs = +(performance.now() - t0).toFixed(2);
        const rs = await Promise.all(ps);
        return {pingDuringStreamsMs, streams: rs.map((r) => ({count: r.count, incremental: r.incremental, p50: r.latencyMs.p50, max: r.latencyMs.max}))};
    });

    await test("wails-events-10s", async () => {
        const evId = uid("evt");
        const events = [];
        const startedAt = Date.now();
        const done = new Promise((resolve) => {
            const off = Events.On("tick", (ev) => {
                const d = ev.data;
                if (d.id !== evId) return;
                if (d.done) { off(); resolve(); return; }
                events.push({n: d.n, t: d.t, recv: Date.now()});
            });
        });
        await fetch(`/api/events/start?id=${evId}&dur=10000`, {method: "POST"});
        await done;
        return summarize(events, startedAt, 9750);
    });

    await test("wails-streams-JSONStream-10s", async () => {
        const events = [];
        const startedAt = Date.now();
        await new Promise((resolve, reject) => {
            const s = JSONStream("ticks");
            s.onmessage = (ev) => {
                const d = ev.data;
                if (d.done) { s.close(); resolve(); return; }
                events.push({n: d.n, t: d.t, recv: Date.now()});
            };
            s.onerror = (e) => reject(new Error("stream error"));
            s.onclose = () => resolve();
        });
        return summarize(events, startedAt, 9750);
    });

    await test("loopback", async () => {
        const {base} = await (await fetch("/api/loopback")).json();
        const out = {base};
        try {
            const r = await fetch(`${base}/ping`);
            out.noCors = {ok: true, status: r.status, body: await r.text()};
        } catch (e) { out.noCors = {ok: false, error: `${e.name}: ${e.message}`}; }
        try {
            const r = await fetch(`${base}/ping-cors`);
            out.withCors = {ok: true, status: r.status, body: await r.json()};
        } catch (e) { out.withCors = {ok: false, error: `${e.name}: ${e.message}`}; }
        try {
            out.eventSourceCors = await withTimeout(runEventSource(`${base}/stream-cors?dur=3000`, {expectedSpanMs: 2750}), 8000, "loopback-es");
        } catch (e) { out.eventSourceCors = {error: `${e.name}: ${e.message}`}; }
        try {
            out.fetchStreamCors = await withTimeout(runFetchStream(`${base}/stream-cors?dur=3000`, {expectedSpanMs: 2750}), 8000, "loopback-fetch");
        } catch (e) { out.fetchStreamCors = {error: `${e.name}: ${e.message}`}; }
        out.serverSeen = (await (await fetch("/api/loopback")).json()).seen;
        return out;
    }, 30000);

    results.env.finishedAt = new Date().toISOString();
    statusEl.textContent = "done — reporting";
    const r = await fetch("/api/report", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(results)});
    statusEl.textContent = `done — report status ${r.status}`;
    log(`report posted: ${r.status}`, r.ok ? "ok" : "bad");
}

main().catch((e) => log(`fatal: ${e}`, "bad"));

#!/usr/bin/env node
// Source graph evidence only. Never executes the application or consumes binary build info.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { targetDescriptor, selectNoticeTarget } from './target-policy.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENTRYPOINT = './cmd/pi-local';
const VERSION = 'go1.26.10';
export const limits = Object.freeze({ stdoutBytes: 64 * 1024 * 1024, receiptBytes: 64 * 1024 * 1024,
  records: 4096, modules: 256, depth: 64, tokens: 2000000, files: 100000,
  fileBytes: 64 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, commandMs: 120000, collectionMs: 300000 });
export const fileTypes = Object.freeze(['GoFiles', 'CgoFiles', 'CFiles', 'CXXFiles', 'HFiles', 'MFiles', 'FFiles', 'SFiles', 'SwigFiles', 'SwigCXXFiles', 'SysoFiles', 'EmbedFiles']);
const controlledEnvironment = Object.freeze({ GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GOFLAGS: '-mod=readonly', GOPROXY: 'off', GOSUMDB: 'off' });
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function need(ok) { if (!ok) throw new Error('Invalid Go graph evidence'); }
function object(value) { need(value !== null && typeof value === 'object' && !Array.isArray(value)); }
export function canonicalJSON(value) {
  function sort(v) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') { need(Number.isFinite(v)); return v; }
    if (Array.isArray(v)) return v.map(sort);
    object(v);
    return Object.fromEntries(Object.keys(v).sort(order).map(k => [k, sort(v[k])]));
  }
  return JSON.stringify(sort(value), null, 2) + '\n';
}

// Go emits adjacent JSON objects, not an array. Scan JSON grammar, including quoted
// braces/escapes and nested arrays; reject duplicate keys at every depth before JSON.parse.
// Bounds are fixed in production; there is no parser/record-limit CLI switch.
export function parseGoJSON(text) {
  need(typeof text === 'string' && Buffer.byteLength(text) <= limits.stdoutBytes);
  let i = 0, tokens = 0;
  const ws = () => { while (i < text.length && /[\t\r\n ]/.test(text[i])) i++; };
  function string() {
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') return JSON.parse(text.slice(start, i));
      if (c === '\\') { need(i < text.length); i++; }
    }
    need(false);
  }
  function value(depth) {
    need(depth <= limits.depth && ++tokens <= limits.tokens);
    ws();
    if (text[i] === '"') { string(); return; }
    if (text[i] === '{' || text[i] === '[') {
      const isObject = text[i++] === '{', end = isObject ? '}' : ']';
      const keys = new Set();
      ws();
      if (text[i] === end) { i++; return; }
      for (;;) {
        ws();
        if (isObject) {
          need(text[i] === '"'); const key = string();
          need(!keys.has(key)); keys.add(key); ws(); need(text[i++] === ':');
        }
        value(depth + 1); ws();
        if (text[i] === end) { i++; return; }
        need(text[i++] === ',');
      }
    }
    const literal = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
    literal.lastIndex = i;
    need(literal.exec(text)); i = literal.lastIndex;
  }
  const records = [];
  ws();
  while (i < text.length) {
    need(records.length < limits.records && text[i] === '{');
    const start = i; value(0);
    const record = JSON.parse(text.slice(start, i)); object(record); records.push(record); ws();
  }
  need(records.length > 0);
  return records;
}

// Pure policy only: the CLI supplies the actual process host, never a caller host.
export function graphSelection(target, env, host) {
  need(['windows-amd64', 'linux-amd64'].includes(target));
  const descriptor = targetDescriptor(target);
  need(host.platform === descriptor.node.platform && host.arch === descriptor.node.arch);
  need(env.NOTICE_TARGET === undefined || env.NOTICE_TARGET === target);
  selectNoticeTarget({ ...env, NOTICE_TARGET: target }, host);
  need(env.GOFLAGS === undefined || ['', '-mod=readonly'].includes(env.GOFLAGS.trim()));
  for (const [key, allowed] of Object.entries({ GOTOOLCHAIN: ['', 'local'], GOWORK: ['', 'off'],
    GO111MODULE: ['', 'on'], GOAMD64: ['', 'v1'], GOEXPERIMENT: [''] })) {
    need(env[key] === undefined || allowed.includes(env[key]));
  }
  // GOROOT itself is a trusted SDK location, not a claim of binary provenance.
  for (const key of ['GOTOOLDIR', 'GCCGO']) need(!env[key]);
  return descriptor;
}

function portable(value) {
  need(typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !/[\\:\x00-\x1f\x7f]/.test(value) && !value.startsWith('/') &&
    value.split('/').every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p)));
  return value;
}
function importID(value) { portable(value); need(/^[A-Za-z0-9_~.+/-]+$/.test(value)); return value; }
function version(value) { need(typeof value === 'string' && /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+incompatible)?$/.test(value)); return value; }
function strings(value = []) {
  need(Array.isArray(value) && value.length <= limits.files && value.every(v => typeof v === 'string'));
  need(new Set(value).size === value.length);
  return [...value].sort(order);
}
function escapeCache(value) { return value.replace(/[A-Z]/g, c => '!' + c.toLowerCase()); }
function absolute(value) { need(typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value); return value; }
function sameDir(actual, expected) { need(absolute(actual) === expected); }
function healthy(record) {
  object(record);
  need(record.Error === undefined && record.Replace === undefined && (record.Incomplete === undefined || record.Incomplete === false));
  need(strings(record.DepsErrors).length === 0);
}
function identity(m) { return { path: m.Path, version: m.Main ? null : m.Version, main: m.Main === true }; }
function moduleContract(m) {
  healthy(m); importID(m.Path);
  need(m.Main === undefined || typeof m.Main === 'boolean');
  if (m.Main) {
    for (const key of ['Version', 'Sum', 'GoModSum']) need(m[key] === undefined || m[key] === '');
  }
  else {
    version(m.Version);
    for (const key of ['Sum', 'GoModSum']) need(typeof m[key] === 'string' && /^h1:[A-Za-z0-9+/]{43}=$/.test(m[key]));
  }
}

// Pure read plan: SDK/cache/root are trusted physical anchors. No filesystem access,
// Go execution, host simulation or receipt-provided graph enters the native collector.
export function planGraph(packages, modules, roots) {
  need(Array.isArray(packages) && packages.length > 0 && packages.length <= limits.records);
  need(Array.isArray(modules) && modules.length > 0 && modules.length <= limits.modules);
  for (const key of ['root', 'goroot', 'cache']) absolute(roots[key]);
  const mods = new Map(), moduleDirs = new Set();
  for (const m of modules) {
    moduleContract(m); need(!mods.has(m.Path));
    const dir = m.Main ? roots.root : path.join(roots.cache, escapeCache(m.Path) + '@' + escapeCache(m.Version));
    sameDir(m.Dir, dir); need(!moduleDirs.has(dir)); moduleDirs.add(dir);
    if (m.Main) sameDir(m.GoMod, path.join(roots.root, 'go.mod'));
    // GoMod may be outside Dir (the downloaded cache .mod file); it is never
    // mistaken for a selected source file. CLI metadata supplies GoModSum.
    mods.set(m.Path, m);
  }
  const mains = modules.filter(m => m.Main); need(mains.length === 1);
  const entry = mains[0].Path + '/cmd/pi-local';
  const ids = new Set(), selected = new Set(), planned = [];
  let fileCount = 0;
  for (const p of packages) {
    healthy(p); importID(p.ImportPath);
    need(!ids.has(p.ImportPath)); ids.add(p.ImportPath);
    need(typeof p.Name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(p.Name));
    need(!p.ForTest && !p.BinaryOnly && !p.ConflictDir && !p.Export && !p.BuildID);
    need(strings(p.CompiledGoFiles).length === 0 && strings(p.InvalidGoFiles).length === 0);
    need(p.Standard === undefined || typeof p.Standard === 'boolean');
    const standard = p.Standard === true;
    let owner, anchor, dir;
    if (standard) {
      need(!p.Module && p.Goroot === true);
      anchor = roots.goroot; dir = path.join(anchor, 'src', p.ImportPath);
    } else {
      object(p.Module); healthy(p.Module);
      const m = mods.get(p.Module.Path); need(m);
      need(isDeepStrictEqual(identity(p.Module), identity(m)));
      need((p.Module.Version ?? '') === (m.Version ?? ''));
      sameDir(p.Module.Dir, m.Dir);
      for (const key of ['Sum', 'GoModSum']) if (p.Module[key] !== undefined) need(p.Module[key] === m[key]);
      need(!p.Goroot);
      need(p.ImportPath === m.Path || p.ImportPath.startsWith(m.Path + '/'));
      // A package must belong to the longest selected module-path prefix.
      for (const other of modules) if (other.Path !== m.Path && other.Path.startsWith(m.Path + '/'))
        need(p.ImportPath !== other.Path && !p.ImportPath.startsWith(other.Path + '/'));
      owner = identity(m); selected.add(m.Path);
      anchor = m.Main ? roots.root : roots.cache;
      dir = path.join(m.Dir, p.ImportPath === m.Path ? '' : p.ImportPath.slice(m.Path.length + 1));
    }
    const files = [];
    for (const type of fileTypes) for (const name of strings(p[type])) {
      need(++fileCount <= limits.files);
      portable(name);
      if (type !== 'EmbedFiles') need(!name.includes('/'));
      if (type === 'GoFiles' || type === 'CgoFiles') need(!name.endsWith('_test.go'));
      files.push({ type, name, relative: path.relative(anchor, path.join(dir, name)).split(path.sep).join('/') });
    }
    // unsafe is compiler-provided; Go's valid no-Dir/no-files representation
    // must not be "repaired" by guessing a source path.
    if (p.ImportPath === 'unsafe' && !p.Dir) need(standard && files.length === 0);
    else { sameDir(p.Dir, dir); need(files.length > 0); }
    const imports = strings(p.Imports); for (const id of imports) importID(id);
    if (imports.includes('C')) need(strings(p.CgoFiles).length > 0);
    for (const id of strings(p.Deps)) importID(id);
    if (p.ImportMap !== undefined) {
      object(p.ImportMap);
      for (const [from, to] of Object.entries(p.ImportMap)) { importID(from); importID(to); need(imports.includes(to)); }
    }
    planned.push({ importPath: p.ImportPath, name: p.Name, standard, module: owner ?? null,
      imports, files: files.sort((a, b) => order(a.type + '/' + a.name, b.type + '/' + b.name)), anchor });
  }
  need(selected.size === mods.size && ids.has(entry));
  const rootPackage = packages.find(p => p.ImportPath === entry);
  need(rootPackage.Name === 'main' && !rootPackage.DepOnly);
  need(isDeepStrictEqual(strings(rootPackage.Match), [ENTRYPOINT]));
  need(isDeepStrictEqual(strings(rootPackage.Deps), [...ids].filter(id => id !== entry).sort(order)));
  for (const p of packages) {
    const deps = strings(p.Deps);
    for (const id of deps) need(ids.has(id) && id !== p.ImportPath);
    for (const id of strings(p.Imports)) if (id !== 'C') need(ids.has(id) && deps.includes(id));
  }
  return { modules: modules.map(m => ({ ...identity(m), sum: m.Sum ?? null, goModSum: m.GoModSum ?? null })).sort((a, b) => order(a.path, b.path)),
    packages: planned.sort((a, b) => order(a.importPath, b.importPath)) };
}

export function evidenceSnapshot({ target, descriptor, observed, modFiles, artifacts, graph }) {
  return { schema: 1, kind: 'native-go-graph-evidence', distributionComplete: false, target, entrypoint: ENTRYPOINT,
    targetContract: descriptor, descriptorSha256: hash(canonicalJSON(descriptor)),
    invocationPolicy: { toolchain: VERSION, environment: controlledEnvironment,
      verify: ['mod', 'verify'], packages: ['list', '-mod=readonly', '-deps', '-json', ENTRYPOINT],
      modules: ['list', '-mod=readonly', '-m', '-json', '<sorted selected module paths>'],
      buildTags: [], sourceFileTypes: fileTypes, limits },
    observed, modFiles, artifacts, ...graph, graphSha256: hash(canonicalJSON(graph)) };
}
export function assertSnapshot(bytes, expected) {
  if (Buffer.isBuffer(bytes)) {
    need(bytes.length <= limits.receiptBytes);
    const decoded = bytes.toString('utf8');
    need(Buffer.from(decoded, 'utf8').equals(bytes)); // no lossy UTF-8 canonicalization
    bytes = decoded;
  }
  need(typeof bytes === 'string' && Buffer.byteLength(bytes) <= limits.receiptBytes);
  const records = parseGoJSON(bytes);
  need(records.length === 1 && isDeepStrictEqual(records[0], expected) && bytes === canonicalJSON(expected));
}

// Filesystem primitives are separate from pure projection and from fixed native CLI.
// Lexical lstat checks include junctions. Physical anchors are resolved by the caller;
// this is not protection against concurrent hostile filesystem substitution (TOCTOU).
export function guardedPath(root, relative, missing = false) {
  portable(relative); absolute(root);
  need(!fs.lstatSync(root).isSymbolicLink() && fs.realpathSync(root) === root);
  let file = root, existing = root;
  for (const part of relative.split('/')) {
    file = path.join(file, part);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (e) { if (missing && e.code === 'ENOENT') break; throw e; }
    need(!stat.isSymbolicLink()); existing = file;
  }
  // Refuse physical aliases reported by the resolver as well as explicit
  // symlinks. portable() separately excludes Win32 trailing-dot/space aliases.
  // realpath is NOT a portable case-canonicalization API (e.g. on APFS).
  need(fs.realpathSync(existing) === existing);
  return path.join(root, relative);
}
export function newBudget() { return { files: 0, bytes: 0, deadline: Date.now() + limits.collectionMs }; }
function tick(budget) { need(Date.now() <= budget.deadline); }
export function readOwnedFile(root, relative, budget, max = limits.fileBytes) {
  tick(budget);
  const file = guardedPath(root, relative), stat = fs.lstatSync(file);
  need(stat.isFile() && stat.size <= max && ++budget.files <= limits.files);
  need(budget.bytes + stat.size <= limits.totalBytes);
  const bytes = fs.readFileSync(file);
  need(bytes.length === stat.size); budget.bytes += bytes.length;
  return bytes;
}
function modSnapshot(root) {
  // Independent, bounded guard budget: exhausted graph/time/file budgets must NOT
  // prevent the final module-file check, including after a subprocess failure.
  const guardBudget = newBudget();
  return Object.fromEntries(['go.mod', 'go.sum'].map(f => [f, hash(readOwnedFile(root, f, guardBudget, 8 * 1024 * 1024))]));
}
// Always guard even when the action throws; mutation is reported, never restored.
export function withModuleGuard(root, expected, action) {
  need(isDeepStrictEqual(modSnapshot(root), expected));
  try { return action(); }
  finally { need(isDeepStrictEqual(modSnapshot(root), expected)); }
}
export function artifactSnapshot(root, budget) {
  return Object.fromEntries(['runtime', 'frontend'].map(area => {
    const base = area + '/dist', entries = [];
    let count = 0;
    function visit(relative, depth) {
      tick(budget); need(depth <= limits.depth);
      const dir = guardedPath(root, relative); need(fs.lstatSync(dir).isDirectory());
      const handle = fs.opendirSync(dir);
      try {
        for (let e; (e = handle.readSync()) !== null;) {
          need(++count <= limits.files); portable(e.name); need(!e.isSymbolicLink());
          const next = relative + '/' + e.name;
          if (e.isDirectory()) visit(next, depth + 1);
          else { need(e.isFile()); entries.push([next.slice(base.length + 1), hash(readOwnedFile(root, next, budget))]); }
        }
      } finally { handle.closeSync(); }
    }
    visit(base, 0); need(entries.length > 0);
    return [area, Object.fromEntries(entries.sort(([a], [b]) => order(a, b)))];
  }));
}
export function publishEvidence(root, relative, bytes) {
  need(Buffer.byteLength(bytes) <= limits.receiptBytes);
  const dest = guardedPath(root, relative, true);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  guardedPath(root, relative, true);
  const stage = fs.mkdtempSync(path.join(path.dirname(dest), '.go-graph-'));
  try {
    fs.writeFileSync(path.join(stage, 'production.json'), bytes, { flag: 'wx' });
    guardedPath(root, relative, true);
    fs.renameSync(path.join(stage, 'production.json'), dest);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

export function observedGo(probe, descriptor) {
  object(probe);
  need(probe.GOHOSTOS === descriptor.go.GOOS && probe.GOHOSTARCH === descriptor.go.GOARCH && probe.GOVERSION === VERSION);
  for (const key of ['GOOS', 'GOARCH', 'CGO_ENABLED']) need(probe[key] === descriptor.go[key]);
  need(probe.GOAMD64 === 'v1' && probe.GOEXPERIMENT === '');
  return { hostOS: probe.GOHOSTOS, hostArch: probe.GOHOSTARCH, version: probe.GOVERSION,
    GOOS: probe.GOOS, GOARCH: probe.GOARCH, CGO_ENABLED: probe.CGO_ENABLED,
    GOAMD64: probe.GOAMD64, GOEXPERIMENT: probe.GOEXPERIMENT, buildTags: [], GOFLAGS: '-mod=readonly' };
}

// No root, binary, host, tags, tool executor or output injection API. Only actual
// Windows/Linux native CLI paths can reach this collector. Go is a trusted CI tool.
function collectNative(command, target) {
  const host = { platform: process.platform, arch: process.arch };
  const descriptor = graphSelection(target, process.env, host); // BEFORE any Go or write
  need(command === 'write' || command === 'assert');
  const root = fs.realpathSync(ROOT), budget = newBudget(), before = modSnapshot(root);
  return withModuleGuard(root, before, () => {
    const env = { ...process.env, ...controlledEnvironment };
    function go(args) {
      return withModuleGuard(root, before, () => {
        tick(budget);
        return execFileSync('go', args, { cwd: root, env, encoding: 'utf8',
          timeout: Math.min(limits.commandMs, Math.max(1, budget.deadline - Date.now())),
          maxBuffer: limits.stdoutBytes, stdio: ['ignore', 'pipe', 'pipe'] });
      });
    }
    const probe = parseGoJSON(go(['env', '-json', 'GOHOSTOS', 'GOHOSTARCH', 'GOVERSION', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GOAMD64', 'GOEXPERIMENT']));
    need(probe.length === 1);
    const observed = { node: { ...host, version: process.versions.node }, go: observedGo(probe[0], descriptor) };
    const locations = parseGoJSON(go(['env', '-json', 'GOROOT', 'GOMODCACHE', 'GOMOD', 'GOWORK']));
    need(locations.length === 1 && locations[0].GOWORK === 'off');
    sameDir(locations[0].GOMOD, path.join(root, 'go.mod'));
    const roots = { root, goroot: fs.realpathSync(absolute(locations[0].GOROOT)), cache: fs.realpathSync(absolute(locations[0].GOMODCACHE)) };
    // Built embeds must already exist. No install, download, repair or fallback.
    const artifacts = artifactSnapshot(root, budget);
    need(go(['mod', 'verify']).trim() === 'all modules verified');
    const packages = parseGoJSON(go(['list', '-mod=readonly', '-deps', '-json', ENTRYPOINT]));
    const names = [...new Set(packages.filter(p => p.Module).map(p => { healthy(p.Module); return importID(p.Module.Path); }))].sort(order);
    need(names.length > 0 && names.length <= limits.modules);
    const modules = parseGoJSON(go(['list', '-mod=readonly', '-m', '-json', ...names]));
    need(isDeepStrictEqual(modules.map(m => m.Path).sort(order), names));
    const plan = planGraph(packages, modules, roots);
    const graph = { modules: plan.modules, packages: plan.packages.map(({ anchor, files, ...p }) => ({ ...p,
      files: files.map(({ type, name, relative }) => ({ type, name, sha256: hash(readOwnedFile(anchor, relative, budget)) })) })) };
    const expected = evidenceSnapshot({ target, descriptor, observed, modFiles: before, artifacts, graph });
    const bytes = canonicalJSON(expected);
    const relative = `.cache/licenses/go-graph/${target}/production.json`;
    need(isDeepStrictEqual(artifactSnapshot(root, budget), artifacts));
    return withModuleGuard(root, before, () => {
      if (command === 'write') publishEvidence(root, relative, bytes);
      else assertSnapshot(readOwnedFile(root, relative, budget, limits.receiptBytes), expected);
      return { kind: expected.kind, target, modules: graph.modules.length, packages: graph.packages.length, distributionComplete: false };
    });
  });
}

export function nativeGraphEvidence(command, target) {
  try { return collectNative(command, target); }
  catch { throw new Error('Native Go graph evidence failed'); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    need(args.length === 3 && ['write', 'assert'].includes(args[0]) && args[1] === '--target');
    const result = nativeGraphEvidence(args[0], args[2]);
    console.log(`Native Go graph evidence: ${result.target}; ${result.modules} modules; ${result.packages} packages; distributionComplete=false`);
  } catch { console.error('Native Go graph evidence failed'); process.exitCode = 1; }
}

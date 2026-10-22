import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { targetDescriptor } from './target-policy.mjs';
import { artifactSnapshot, assertSnapshot, canonicalJSON, evidenceSnapshot, fileTypes, goEnvironment, graphSelection,
  guardedPath, limits, nativeGraphEvidence, newBudget, observedGo, parseGoJSON, planGraph, publishEvidence,
  readOwnedFile, withModuleGuard } from './go-graph-evidence.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
const checksum = 'h1:' + Buffer.alloc(32, 7).toString('base64');
const nativeTarget = process.arch === 'x64' ? ({ win32: 'windows-amd64', linux: 'linux-amd64' })[process.platform] : undefined;
const cli = fileURLToPath(new URL('./go-graph-evidence.mjs', import.meta.url));
const encode = records => records.map(r => JSON.stringify(r, null, '\t')).join('\n');
function bundle(prefix = path.resolve('/synthetic/private work')) {
  const roots = { root: path.join(prefix, 'repo'), goroot: path.join(prefix, 'sdk'), cache: path.join(prefix, 'cache') };
  const main = { Path: 'example.test/app', Main: true, Dir: roots.root, GoMod: path.join(roots.root, 'go.mod') };
  const external = { Path: 'example.test/Dep/v2', Version: 'v2.3.4', Dir: path.join(roots.cache, 'example.test/!dep/v2@v2.3.4'), Sum: checksum, GoModSum: checksum };
  const packages = [
    { ImportPath: 'unsafe', Name: 'unsafe', Goroot: true, Standard: true, DepOnly: true },
    { ImportPath: 'example.test/Dep/v2/sub', Name: 'sub', Module: structuredClone(external), Dir: path.join(external.Dir, 'sub'), GoFiles: ['sub.go'], Imports: ['unsafe'], Deps: ['unsafe'], DepOnly: true },
    { ImportPath: 'example.test/app/cmd/pi-local', Name: 'main', Module: structuredClone(main), Dir: path.join(roots.root, 'cmd/pi-local'), GoFiles: ['main.go'], EmbedFiles: ['data/π.json'],
      Imports: ['example.test/Dep/v2/sub'], Deps: ['example.test/Dep/v2/sub', 'unsafe'], Match: ['./cmd/pi-local'],
      TestGoFiles: ['not-selected_test.go'], IgnoredGoFiles: ['not-selected.go'], Doc: 'braces } { and quote " and \\ escapes' },
  ];
  return { roots, modules: [external, main], packages };
}
function projected(b = bundle()) {
  const plan = planGraph(b.packages, b.modules, b.roots);
  return { modules: plan.modules, packages: plan.packages.map(({ anchor, files, ...p }) => ({ ...p,
    files: files.map(({ type, name }) => ({ type, name, sha256: hash('synthetic bytes: ' + name) })) })) };
}
function receipt() {
  const target = 'linux-amd64';
  return evidenceSnapshot({ target, descriptor: targetDescriptor(target),
    observed: { node: { platform: 'linux', arch: 'x64', version: '22.23.0' },
      go: { hostOS: 'linux', hostArch: 'amd64', version: 'go1.26.10', GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '1', GOAMD64: 'v1', GOEXPERIMENT: '', buildTags: [], GOFLAGS: '-mod=readonly' } },
    modFiles: { 'go.mod': hash('mod'), 'go.sum': hash('sum') },
    artifacts: { runtime: { 'runtime.mjs': hash('runtime') }, frontend: { 'index.html': hash('html'), 'assets/app.js': hash('js') } }, graph: projected() });
}
function write(root, relative, data) {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file;
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'go-graph-unit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'go.mod', 'module example.test/app\n'); write(root, 'go.sum', 'frozen\n');
  for (const area of ['runtime', 'frontend']) { write(root, area + '/dist/z.js', 'z'); write(root, area + '/dist/nested/a.js', 'a'); }
  return root;
}
const rel = '.cache/licenses/go-graph/linux-amd64/production.json';

test('pure parser consumes actual Go-style adjacent objects, nested braces, strings and escapes', () => {
  const records = bundle().packages;
  assert.deepEqual(parseGoJSON(encode(records)), records);
  assert.deepEqual(parseGoJSON(' {"s":"\\\"} {\\\\", "a":[true,false,null,-1.5e2,{"x":1}]}\n{} '), [{ s: '"} {\\', a: [true, false, null, -150, { x: 1 }] }, {}]);
  for (const input of ['', '[]', '{}[]', '{}garbage', '{', '{"a":1,}', '{"a":1 "b":2}', '{"a":"unterminated}', '{"a":01}', '{"a":NaN}', '{"a":1,"a":2}', '{"a":{"x":1,"x":2}}', '{"a":1,"\\u0061":2}']) assert.throws(() => parseGoJSON(input));
});

test('pure parser enforces byte, depth, record and token bounds', () => {
  assert.throws(() => parseGoJSON(' '.repeat(limits.stdoutBytes + 1)));
  assert.throws(() => parseGoJSON('{}\n'.repeat(limits.records + 1)));
  assert.throws(() => parseGoJSON('{"a":' + '['.repeat(limits.depth + 1) + '0' + ']'.repeat(limits.depth + 1) + '}'));
  assert.throws(() => parseGoJSON('{"a":[' + '0,'.repeat(limits.tokens) + '0]}'));
});

test('pure target policy rejects cross-host/tag/experiment/toolchain/selection overrides without mutating environment', () => {
  for (const [target, platform] of [['windows-amd64', 'win32'], ['linux-amd64', 'linux']]) {
    const host = { platform, arch: 'x64' };
    const base = { GOFLAGS: '-mod=readonly', GOTOOLCHAIN: 'local', GOWORK: 'off' };
    assert.deepEqual(graphSelection(target, base, host), targetDescriptor(target));
    const copy = structuredClone(base); graphSelection(target, base, host); assert.deepEqual(base, copy);
    for (const changes of [
      { GOFLAGS: '-tags=server' }, { GOFLAGS: '-tags=mcp' }, { GOFLAGS: '-tags=gtk3' }, { GOFLAGS: '-overlay=secret.json' },
      { GOFLAGS: '-mod=mod' }, { GOFLAGS: '-toolexec=other' }, { GOFLAGS: '-race' },
      { GOFLAGS: '-mod=readonly -tags=gtk4' }, { GOFLAGS: '-modfile=other.mod' },
      { GOEXPERIMENT: 'arenas' }, { GOEXPERIMENT: 'none' }, { GOAMD64: 'v2' },
      { GOTOOLCHAIN: 'auto' }, { GOTOOLCHAIN: 'go1.26.10' }, { GOWORK: '/private/workspace' },
      { GO111MODULE: 'off' }, { GOTOOLDIR: '/private/tools' }, { GCCGO: 'gccgo' },
      { GOOS: target === 'windows-amd64' ? 'linux' : 'windows' }, { GOARCH: 'arm64' },
      { CGO_ENABLED: target === 'linux-amd64' ? '0' : '1' }, { NOTICE_TARGET: 'darwin-arm64' },
      { npm_config_target_arch: 'arm64' }, { npm_config_target_platform: 'darwin' },
    ]) assert.throws(() => graphSelection(target, { ...base, ...changes }, host));
    for (const wrongHost of [{ platform: 'darwin', arch: 'arm64' }, { platform, arch: 'arm64' }, { platform: 'foreign', arch: 'x64' }]) assert.throws(() => graphSelection(target, base, wrongHost));
  }
  for (const target of ['darwin-arm64', 'darwin-amd64', '', '../linux-amd64', 'server', 'constructor', null]) assert.throws(() => graphSelection(target, {}, { platform: 'linux', arch: 'x64' }));
});

test('child environment neutralizes inherited private-module routing without mutating globals', () => {
  for (const inherited of [{ GOPRIVATE: '*' }, { GONOPROXY: '*' }, { GOPRIVATE: 'private.example/*', GONOPROXY: '*', GOPROXY: 'direct' }]) {
    const before = structuredClone(inherited);
    const child = goEnvironment(inherited);
    assert.deepEqual(inherited, before);
    assert.equal(child.GOPROXY, 'off');
    assert.equal(child.GOSUMDB, 'off');
    assert.equal(child.GOPRIVATE, '');
    assert.equal(child.GONOPROXY, 'none');
    assert.equal(child.GOENV, 'off');
    assert.equal(child.GOWORK, 'off');
    assert.equal(child.GOTOOLCHAIN, 'local');
    assert.equal(child.GOFLAGS, '-mod=readonly');
    const policy = receipt().invocationPolicy.environment;
    assert.equal(policy.GOPRIVATE, child.GOPRIVATE);
    assert.equal(policy.GONOPROXY, child.GONOPROXY);
  }
});

test('isolated missing-cache Go routing refuses offline even with inherited private settings', (t) => {
  const root = fixture(t);
  write(root, 'go.mod', 'module example.test/app\n\ngo 1.26.10\n');
  write(root, 'go.sum', '');
  // Go 1.26.10 vcs.go explicitly rejects example.net before dynamic lookup;
  // the old-route control cannot issue HTTP/DNS or invoke a VCS executable.
  // GOVCS=*:off additionally forbids VCS execution. This is a routing probe,
  // not a native production graph or an OS network-isolation test.
  const isolated = { PATH: process.env.PATH, GOVCS: '*:off' };
  if (process.platform === 'win32') isolated.SystemRoot = process.env.SystemRoot;
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'GOPATH', 'GOCACHE']) {
    const dir = path.join(root, key.toLowerCase()); fs.mkdirSync(dir); isolated[key] = dir;
  }
  const base = goEnvironment(isolated);
  const probe = spawnSync('go', ['env', 'GOVERSION'], { cwd: root, env: base, encoding: 'utf8', timeout: 10000 });
  assert.equal(probe.status, 0); assert.equal(probe.stdout.trim(), 'go1.26.10');
  const before = Object.fromEntries(['go.mod', 'go.sum'].map(f => [f, fs.readFileSync(path.join(root, f))]));
  let index = 0;
  for (const inherited of [{ GOPRIVATE: '*' }, { GONOPROXY: '*' }, { GOPRIVATE: '*', GONOPROXY: '*' }]) {
    const old = { ...base, ...inherited };
    if (!Object.hasOwn(inherited, 'GONOPROXY')) delete old.GONOPROXY;
    for (const fixed of [false, true]) {
      const cache = path.join(root, `empty-module-cache-${index++}`); fs.mkdirSync(cache);
      const env = { ...(fixed ? goEnvironment(old) : old), GOMODCACHE: cache };
      const result = spawnSync('go', ['mod', 'download', '-json', 'example.net/native-graph-offline-fixture@v1.0.0'],
        { cwd: root, env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
      assert.equal(result.status, 1, 'missing-cache routing probe must refuse');
      const error = JSON.parse(result.stdout).Error;
      assert.equal(typeof error, 'string');
      assert.ok(error.includes(fixed ? 'module lookup disabled by GOPROXY=off' : 'no modules on example.net'));
    }
  }
  for (const [file, bytes] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
});

test('pure Go identity projection rejects wrong host, effective selection and toolchain version without native execution', () => {
  for (const target of ['windows-amd64', 'linux-amd64']) {
    const descriptor = targetDescriptor(target);
    const probe = { GOHOSTOS: descriptor.go.GOOS, GOHOSTARCH: 'amd64', GOVERSION: 'go1.26.10',
      GOOS: descriptor.go.GOOS, GOARCH: 'amd64', CGO_ENABLED: descriptor.go.CGO_ENABLED, GOAMD64: 'v1', GOEXPERIMENT: '' };
    assert.equal(observedGo(probe, descriptor).version, 'go1.26.10');
    for (const change of [{ GOHOSTOS: 'darwin' }, { GOHOSTARCH: 'arm64' }, { GOVERSION: 'go1.26.9' },
      { GOVERSION: 'devel go1.26.10' }, { GOOS: 'darwin' }, { GOARCH: 'arm64' },
      { CGO_ENABLED: target === 'linux-amd64' ? '0' : '1' }, { GOAMD64: 'v2' }, { GOEXPERIMENT: 'none' }])
      assert.throws(() => observedGo({ ...probe, ...change }, descriptor));
  }
});

test('pure graph is sorted, relocation/cache independent, binds selected file types and accepts compiler unsafe', () => {
  const first = projected();
  const relocated = bundle(path.resolve('/unrelated relocated unicode π'));
  relocated.packages.reverse(); relocated.modules.reverse(); relocated.packages.find(p => p.Name === 'main').Deps.reverse();
  assert.deepEqual(projected(relocated), first);
  assert.deepEqual(first.modules.map(m => m.path), ['example.test/Dep/v2', 'example.test/app']);
  assert.deepEqual(first.packages.find(p => p.importPath === 'unsafe'), { importPath: 'unsafe', name: 'unsafe', standard: true, module: null, imports: [], files: [] });
  assert.equal(canonicalJSON(first).includes('not-selected'), false);
  assert.equal(canonicalJSON(first).includes('/synthetic'), false);
  const b = bundle(), p = b.packages[1];
  const extensions = ['go', 'go', 'c', 'cpp', 'h', 'm', 'f', 's', 'swig', 'swigcxx', 'syso', 'txt'];
  for (const [i, type] of fileTypes.entries()) p[type] = ['selected-' + i + '.' + extensions[i]];
  p.Imports.push('C');
  assert.deepEqual(new Set(projected(b).packages.find(p => p.name === 'sub').files.map(f => f.type)), new Set(fileTypes));
});

test('pure graph refuses package/module errors, replacements, duplicate/conflicting identities and malformed references', () => {
  const mutations = [
    b => b.packages.push(structuredClone(b.packages[0])), b => b.modules.push(structuredClone(b.modules[0])),
    b => { b.packages[1].Error = { Err: '/private/package-id must not surface' }; },
    b => { b.packages[1].DepsErrors = [{ Err: 'dependency error' }]; }, b => { b.packages[1].Incomplete = true; },
    b => { b.modules[0].Error = { Err: 'module error' }; }, b => { b.modules[0].Replace = {}; },
    b => { b.modules[0].Replace = false; }, b => { b.modules[0].Replace = null; },
    b => { b.packages[1].Module.Replace = {}; }, b => { b.packages[1].Module.Version = 'v2.3.5'; },
    b => { b.packages[2].Module.Version = 'v1.0.0'; }, b => { b.modules[1].Version = null; },
    b => { b.modules[0].Version = 'garbage'; }, b => { b.modules[0].Sum = 'h1:unverified'; },
    b => { delete b.modules[0].GoModSum; }, b => { b.packages[1].Module.GoModSum = 'wrong'; },
    b => { b.packages[1].Module.Main = true; }, b => { b.packages[1].Module.Path = 'foreign.test/module'; },
    b => { b.packages[1].Module = undefined; }, b => { b.packages[1].Dir = b.roots.root; },
    b => { b.modules[0].Dir = path.join(b.roots.cache, 'wrong@v2.3.4'); },
    b => { b.modules[1].GoMod = path.join(b.roots.root, 'other.mod'); },
    b => { b.packages[1].Imports.push('unlisted/package'); }, b => { b.packages[1].Deps.push('unlisted/package'); },
    b => { b.packages[1].Imports.push('C'); }, b => { b.packages[1].Imports.push('unsafe'); },
    b => { b.packages[1].ImportMap = { 'raw/path': 'missing/path' }; },
    b => { b.packages[1].ImportPath = 'path [test]'; }, b => { b.packages[1].ForTest = 'test'; },
    b => { b.packages[1].BinaryOnly = true; }, b => { b.packages[1].CompiledGoFiles = ['/cache/generated.go']; },
    b => { b.packages[1].InvalidGoFiles = ['broken.go']; }, b => { b.packages[1].GoFiles = ['source_test.go']; },
    b => { b.packages[1].GoFiles = []; }, b => { b.packages[0].Module = structuredClone(b.modules[1]); },
    b => { b.packages[0].GoFiles = ['unsafe.go']; }, b => { b.packages[0].Standard = false; },
    b => { b.packages[2].Deps = ['unsafe']; }, b => { b.packages[2].Match = ['./...']; },
    b => { b.packages[2].Name = 'server'; }, b => { b.packages[2].DepOnly = true; },
  ];
  for (const mutate of mutations) { const b = bundle(); mutate(b); assert.throws(() => planGraph(b.packages, b.modules, b.roots)); }
});

test('pure source ownership binds real standard directories and nested module ownership without guessing paths', () => {
  const b = bundle();
  const standard = b.packages[0];
  standard.Dir = path.join(b.roots.goroot, 'src/unsafe'); standard.GoFiles = ['unsafe.go'];
  assert.equal(planGraph(b.packages, b.modules, b.roots).packages.find(p => p.standard).files[0].relative, 'src/unsafe/unsafe.go');
  standard.Dir = path.join(b.roots.root, 'unsafe');
  assert.throws(() => planGraph(b.packages, b.modules, b.roots));
  const c = bundle();
  c.modules.push({ ...c.modules[0], Path: 'example.test/Dep/v2/sub', Dir: path.join(c.roots.cache, 'example.test/!dep/v2/sub@v2.3.4') });
  assert.throws(() => planGraph(c.packages, c.modules, c.roots));
});

test('pure graph refuses source path escapes, absolute/cache paths and record bounds', () => {
  for (const bad of ['../outside.go', '/private/secret.go', 'C:/cache/file.go', 'C:\\cache\\file.go', 'nested/../../secret', 'x\u0000go', 'x\ngo', './sub.go', 'sub//file.go', 'sub/../file.go', 'dir./file.go', '.. /outside.go', 'trailing ', '']) {
    const b = bundle(); b.packages[1].EmbedFiles = [bad];
    assert.throws(() => planGraph(b.packages, b.modules, b.roots));
  }
  const b = bundle();
  assert.throws(() => planGraph(Array(limits.records + 1).fill(b.packages[0]), b.modules, b.roots));
  assert.throws(() => planGraph(b.packages, Array(limits.modules + 1).fill(b.modules[0]), b.roots));
});

test('pure full-object assertions reject every stale input, policy, descriptor, graph, observation, artifact and unknown field', () => {
  const expected = receipt(), bytes = canonicalJSON(expected);
  assertSnapshot(bytes, expected);
  assertSnapshot(Buffer.from(bytes), expected);
  const unicode = structuredClone(expected); unicode.packages[0].files[0].name = 'replacement-\ufffd';
  const validUTF8 = Buffer.from(canonicalJSON(unicode));
  assertSnapshot(validUTF8, unicode);
  const offset = validUTF8.indexOf(Buffer.from('\ufffd'));
  const invalidUTF8 = Buffer.concat([validUTF8.subarray(0, offset), Buffer.from([0xff]), validUTF8.subarray(offset + 3)]);
  assert.throws(() => assertSnapshot(invalidUTF8, unicode));
  assert.equal(bytes.includes('/synthetic'), false);
  const changes = [
    r => { r.schema = 2; }, r => { r.kind = 'third-party-notice'; }, r => { r.distributionComplete = true; },
    r => { r.entrypoint = './cmd/pi-local-server'; }, r => { r.target = 'windows-amd64'; },
    r => { r.targetContract.go.CGO_ENABLED = '0'; }, r => { r.descriptorSha256 = '0'.repeat(64); },
    r => { r.invocationPolicy.environment.GOPROXY = 'https://network'; }, r => { r.invocationPolicy.buildTags = ['server']; },
    r => { r.invocationPolicy.limits.files++; }, r => { r.observed.go.hostOS = 'darwin'; },
    r => { r.observed.go.version = 'go1.26.9'; }, r => { r.observed.go.GOAMD64 = 'v2'; },
    r => { r.observed.node.version = '22.23.1'; }, r => { r.observed.node.arch = 'arm64'; },
    ...['go.mod', 'go.sum'].map(f => r => { r.modFiles[f] = hash('changed'); }),
    ...['runtime', 'frontend'].map(area => r => { r.artifacts[area]['extra.js'] = hash('new'); }),
    r => { r.artifacts.frontend['index.html'] = hash('changed'); }, r => { delete r.artifacts.runtime['runtime.mjs']; },
    r => { r.modules[0].version = 'v2.3.5'; }, r => { r.modules[0].goModSum = checksum; r.modules[0].sum = 'other'; },
    r => { r.packages[0].imports.push('other/import'); }, r => { r.packages[0].files[0].sha256 = hash('changed source'); },
    r => { r.packages.pop(); }, r => { r.graphSha256 = '0'.repeat(64); },
    r => { r.extraClaim = true; }, r => { r.packages[0].fullSourceIntegrity = true; }, r => { delete r.observed; },
  ];
  for (const mutate of changes) {
    const stale = structuredClone(expected); mutate(stale);
    assert.throws(() => assertSnapshot(canonicalJSON(stale), expected));
    // Equally important: changing current snapshots invalidates an old receipt.
    assert.throws(() => assertSnapshot(bytes, stale));
  }
  for (const bad of [bytes.replace('"schema": 1', '"schema": 1, "schema": 1'), bytes.trim(), JSON.stringify(expected), '{}\n', bytes + '{}', '{"unknown":true}\n']) assert.throws(() => assertSnapshot(bad, expected));
  assert.throws(() => assertSnapshot(' '.repeat(limits.receiptBytes + 1), expected));
});

test('filesystem primitives hash both current artifact maps, detect changes/removal and refuse symlinks', (t) => {
  const root = fixture(t), initial = artifactSnapshot(root, newBudget());
  assert.deepEqual(initial.runtime, { 'nested/a.js': hash('a'), 'z.js': hash('z') });
  write(root, 'runtime/dist/new.js', 'new');
  assert.notDeepEqual(artifactSnapshot(root, newBudget()), initial);
  fs.unlinkSync(path.join(root, 'runtime/dist/new.js')); fs.unlinkSync(path.join(root, 'frontend/dist/z.js'));
  assert.notDeepEqual(artifactSnapshot(root, newBudget()), initial);
  const dest = path.join(root, 'frontend/dist/redirect');
  fs.symlinkSync(path.join(root, 'runtime/dist'), dest, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => artifactSnapshot(root, newBudget()));
});

test('filesystem source and receipt guards reject symlinks/junctions without overwriting good bytes', (t) => {
  const root = fixture(t), outside = fixture(t);
  const bytes = canonicalJSON(receipt()); publishEvidence(root, rel, bytes);
  assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), bytes);
  publishEvidence(root, rel, bytes);
  assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), bytes);
  assert.deepEqual(fs.readdirSync(path.dirname(path.join(root, rel))), ['production.json']);
  const good = fs.readFileSync(path.join(root, rel));
  assert.throws(() => publishEvidence(root, rel, Buffer.alloc(limits.receiptBytes + 1)));
  assert.deepEqual(fs.readFileSync(path.join(root, rel)), good);
  assert.throws(() => {
    // The native flow snapshots before publishing. A snapshot error never enters publish.
    artifactSnapshot(path.join(root, 'missing'), newBudget()); publishEvidence(root, rel, 'bad');
  });
  assert.deepEqual(fs.readFileSync(path.join(root, rel)), good);
  const selected = write(root, 'source/file.go', 'selected');
  assert.equal(readOwnedFile(root, 'source/file.go', newBudget()).toString(), 'selected');
  assert.throws(() => readOwnedFile(root, 'source./file.go', newBudget()));
  fs.renameSync(path.join(root, 'source'), path.join(root, 'real-source'));
  fs.symlinkSync(path.join(root, 'real-source'), path.join(root, 'source'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readOwnedFile(root, 'source/file.go', newBudget()));
  assert.equal(fs.existsSync(selected), true);
  const parent = path.dirname(path.join(root, rel));
  fs.rmSync(parent, { recursive: true });
  const sentinel = write(outside, 'production.json', bytes);
  fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => publishEvidence(root, rel, 'replacement'));
  assert.throws(() => readOwnedFile(root, rel, newBudget()));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), bytes);
  assert.equal(fs.readdirSync(outside).some(n => n.startsWith('.go-graph-')), false);
  for (const bad of ['../outside', '/absolute', 'C:/absolute', 'nested/../escape']) assert.throws(() => guardedPath(root, bad, true));
});

test('selected source-byte changes invalidate independently rebuilt snapshots, not only stored digests', (t) => {
  const root = fixture(t);
  write(root, 'source/selected.go', 'first source bytes');
  const first = receipt();
  first.packages[0].files[0].sha256 = hash(readOwnedFile(root, 'source/selected.go', newBudget()));
  const bytes = canonicalJSON(first);
  write(root, 'source/selected.go', 'changed selected source bytes');
  const current = receipt();
  current.packages[0].files[0].sha256 = hash(readOwnedFile(root, 'source/selected.go', newBudget()));
  assert.throws(() => assertSnapshot(bytes, current));
});

test('bounded file reads and module guards cover success, thrown actions, exhausted budgets and mutation without repair', (t) => {
  const root = fixture(t);
  const expected = Object.fromEntries(['go.mod', 'go.sum'].map(f => [f, hash(fs.readFileSync(path.join(root, f)))]));
  assert.equal(withModuleGuard(root, expected, () => 42), 42);
  assert.throws(() => withModuleGuard(root, expected, () => { throw new Error('action failed'); }), /action failed/);
  const before = fs.readFileSync(path.join(root, 'go.sum'));
  const badBudget = newBudget(); badBudget.files = limits.files;
  assert.throws(() => readOwnedFile(root, 'go.sum', badBudget));
  assert.throws(() => readOwnedFile(root, 'go.sum', newBudget(), 1));
  const full = newBudget(); full.bytes = limits.totalBytes;
  assert.throws(() => readOwnedFile(root, 'go.sum', full));
  const expired = newBudget(); expired.deadline = 0;
  assert.throws(() => readOwnedFile(root, 'go.sum', expired));
  for (const fail of [false, true]) {
    assert.throws(() => withModuleGuard(root, expected, () => { write(root, 'go.sum', 'mutated'); if (fail) throw new Error('original failure'); }));
    assert.equal(fs.readFileSync(path.join(root, 'go.sum'), 'utf8'), 'mutated');
    fs.writeFileSync(path.join(root, 'go.sum'), before);
  }
  fs.unlinkSync(path.join(root, 'go.sum'));
  assert.throws(() => withModuleGuard(root, expected, () => assert.fail('must not run')));
});

test('CLI shape and real wrong-host refusals are sanitized and preserve the entire process environment', () => {
  const before = { ...process.env };
  for (const target of ['windows-amd64', 'linux-amd64'].filter(t => t !== nativeTarget)) assert.throws(() => nativeGraphEvidence('write', target), /^Error: Native Go graph evidence failed$/);
  assert.deepEqual({ ...process.env }, before);
  for (const args of [[], ['write'], ['assert', '--target', 'darwin-arm64'], ['write', '--target', '../../private'],
    ['write', '--target', 'linux-amd64', '--root', '/private'], ['write', '--target', 'linux-amd64', '--output', '/private'],
    ['assert', '--target', 'linux-amd64', '--binary', '/private'], ['write', '--target', 'linux-amd64', '--tags', 'gtk3']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'Native Go graph evidence failed\n');
  }
});

// These are actual matching-host CLI refusals, registered ONLY on Windows/Linux.
// The successful offline write/assert/repeat is a separate post-asset native CI step.
if (nativeTarget) test('native CLI rejects selection overrides before graph commands and does not fake a host', () => {
  for (const change of [{ GOFLAGS: '-tags=server' }, { GOFLAGS: '-tags=mcp' }, { GOFLAGS: '-tags=gtk3' }, { GOEXPERIMENT: 'none' }, { GOAMD64: 'v3' }, { GOTOOLCHAIN: 'auto' }, { CGO_ENABLED: nativeTarget === 'linux-amd64' ? '0' : '1' }]) {
    const result = spawnSync(process.execPath, [cli, 'write', '--target', nativeTarget], { env: { ...process.env, ...change }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'Native Go graph evidence failed\n');
  }
});

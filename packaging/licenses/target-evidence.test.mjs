import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { targets, selectNoticeTarget, targetDescriptor } from './target-policy.mjs';
import { assertBuildEvidenceSnapshot, validateBuildEvidence, writeBuildReceipt } from './build-receipt.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const host = { platform: process.platform, arch: process.arch };
const fakeWin = { platform: 'win32', arch: 'x64' }, fakeLinux = { platform: 'linux', arch: 'x64' };
const nativeTarget = process.arch === 'x64' ? ({ win32: 'windows-amd64', linux: 'linux-amd64' })[process.platform] : undefined;
const envKeys = ['NOTICE_TARGET', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GOFLAGS', 'npm_config_platform', 'npm_config_arch', 'npm_config_target_platform', 'npm_config_target_arch', 'npm_config_user_agent'];
function env(values, fn) {
  const saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];
  Object.assign(process.env, values);
  try { return fn(); }
  finally { for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
function write(root, file, bytes) {
  const dest = path.join(root, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  return dest;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'target-evidence-π '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const area of ['runtime', 'frontend']) {
    write(root, `${area}/package.json`, '{"packageManager":"pnpm@11.18.0","devDependencies":{"example":"1.0.0"}}');
    for (const f of ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml']) write(root, `${area}/${f}`, 'frozen\n');
    write(root, `${area}/node_modules/.pnpm/example@1.0.0/node_modules/example/package.json`, '{"name":"example","version":"1.0.0"}');
    write(root, `${area}/node_modules/.pnpm/example@1.0.0/node_modules/example/LICENSE`, 'full notice fingerprint bytes');
    write(root, `${area}/dist/z.js`, 'z');
    write(root, `${area}/dist/nested/a.js`, 'a');
    write(root, `${area}/src/main.ts`, 'source');
  }
  return root;
}
const relativeReceipt = (target, area = 'frontend') => `.cache/licenses/inventory/${target}/receipts/${area}-build.json`;

test('reviewed descriptors preserve legacy Darwin and exact Windows/Linux Go target contracts', () => {
  assert.deepEqual(Object.keys(targets), ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64']);
  for (const arch of ['arm64', 'amd64']) {
    assert.deepEqual(targets[`darwin-${arch}`], { mode: 'legacy-schema1', go: { GOOS: 'darwin', GOARCH: arch, CGO_ENABLED: '1', buildTags: [] }, node: { platform: 'darwin', arch: arch === 'amd64' ? 'x64' : 'arm64' }, desktop: 'darwin' });
  }
  assert.deepEqual(targets['windows-amd64'].go, { GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0', buildTags: [] });
  assert.deepEqual(targets['linux-amd64'].go, { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '1', buildTags: [] });
  assert.equal(targets['linux-amd64'].desktop, 'default-gtk4');
  assert.ok(Object.isFrozen(targets['linux-amd64'].go.buildTags));
  assert.throws(() => { targets['linux-amd64'].go.CGO_ENABLED = '0'; }, TypeError);
});

test('pure fake-host policy requires explicit native OS/arch and rejects unknown targets/conflicting flags', () => {
  assert.equal(selectNoticeTarget({ GOOS: 'arbitrary legacy env' }, fakeWin), null);
  for (const [target, native] of [['windows-amd64', fakeWin], ['linux-amd64', fakeLinux]]) {
    assert.equal(selectNoticeTarget({ NOTICE_TARGET: target }, native).target, target);
    for (const other of [{ platform: 'darwin', arch: 'arm64' }, { ...native, arch: 'arm64' }, native === fakeWin ? fakeLinux : fakeWin]) assert.throws(() => selectNoticeTarget({ NOTICE_TARGET: target }, other), /native Node/);
    for (const flags of [{ GOOS: 'darwin' }, { GOARCH: 'arm64' }, { CGO_ENABLED: target === 'linux-amd64' ? '0' : '1' }, { npm_config_arch: 'arm64' }, { npm_config_target_arch: 'amd64' }, { npm_config_platform: 'darwin' }, { npm_config_target_platform: 'other' }, { GOFLAGS: '-mod=readonly -tags=gtk3' }, { GOFLAGS: '-tags server' }, { GOFLAGS: '"-tags=gtk4"' }, { GOFLAGS: "'-tags' 'gtk3'" }]) assert.throws(() => selectNoticeTarget({ NOTICE_TARGET: target, ...flags }, native), /Conflicting|build tags/);
    const before = { NOTICE_TARGET: target, GOFLAGS: '-mod=readonly', ...targetDescriptor(target).go };
    const copy = structuredClone(before);
    selectNoticeTarget(before, native);
    assert.deepEqual(before, copy);
  }
  for (const target of ['', 'windows-x64', 'linux-arm64', '../linux-amd64', ' linux-amd64', 'linux-amd64,windows-amd64', '__proto__', 'constructor', null, 42]) assert.throws(() => targetDescriptor(target), /Unknown/);
});

test('unset and explicit Darwin selectors retain exact Schema 1 golden bytes with no target directories', (t) => {
  const root = fixture(t);
  // Golden encoding from the unmodified Schema 1 writer, not a new serializer.
  const golden = '{\n  "schema": 1,\n  "inputs": [\n    "\\u0000virtual:opaque",\n    "frontend/src/main.ts"\n  ],\n  "artifacts": {\n    "nested/a.js": "' + hash('a') + '",\n    "z.js": "' + hash('z') + '"\n  }\n}\n';
  const file = path.join(root, '.cache/licenses/frontend-build.json');
  for (const selector of [undefined, 'darwin-arm64', 'darwin-amd64']) {
    env(selector === undefined ? {} : { NOTICE_TARGET: selector }, () => writeBuildReceipt(root, 'frontend', ['src/main.ts', '\0virtual:opaque', 'src/main.ts']));
    assert.equal(fs.readFileSync(file, 'utf8'), golden);
    assert.equal(fs.existsSync(path.join(root, '.cache/licenses/inventory')), false);
  }
});

function syntheticExpected() {
  const descriptor = targetDescriptor('linux-amd64');
  const installation = { declaredPackageManager: 'pnpm@11.18.0', rootManifestSha256: hash('root'), lockSha256: hash('lock'), installedPackageIdentity: { sha256: hash('identity'), identities: [{ id: 'example@1.0.0', packageManifestSha256: hash('manifest'), noticeFingerprint: hash('notice') }] } };
  return { schema: 2, kind: 'build-evidence', target: 'linux-amd64', area: 'frontend', targetContract: descriptor, descriptorSha256: hash(JSON.stringify(descriptor)), observed: { ...fakeLinux, nodeVersion: '22.23.0' }, installations: { runtime: structuredClone(installation), frontend: structuredClone(installation) }, inputs: ['frontend/src/main.ts'], inputsSha256: hash(JSON.stringify(['frontend/src/main.ts'])), artifacts: { 'z.js': hash('z') }, distributionComplete: false };
}
const mutations = [
  r => { r.schema = 1; }, r => { r.schema = '2'; }, r => { r.kind = 'license-coverage'; },
  r => { r.target = 'windows-amd64'; }, r => { r.area = 'runtime'; },
  r => { r.targetContract.go.CGO_ENABLED = '0'; }, r => { r.targetContract.go.buildTags.push('gtk3'); },
  r => { r.descriptorSha256 = '0'.repeat(64); }, r => { r.observed.platform = 'darwin'; },
  r => { r.observed.arch = 'arm64'; }, r => { r.observed.nodeVersion = '22.23.1'; },
  r => { r.observed.pnpmVersion = '11.18.0'; },
  ...['runtime', 'frontend'].flatMap(area => [
    r => { r.installations[area].lockSha256 = '0'.repeat(64); },
    r => { r.installations[area].rootManifestSha256 = '0'.repeat(64); },
    r => { r.installations[area].declaredPackageManager = 'pnpm@0.0.0'; },
    r => { r.installations[area].installedPackageIdentity.sha256 = '0'.repeat(64); },
    r => { r.installations[area].installedPackageIdentity.identities[0].id = 'other@1.0.0'; },
    r => { r.installations[area].installedPackageIdentity.identities[0].noticeFingerprint = '0'.repeat(64); },
    r => { r.installations[area].installedPackageIdentity.identities[0].packageManifestSha256 = '0'.repeat(64); },
    r => { r.installations[area].sourceIntegrityComplete = true; },
  ]),
  r => { r.inputs.push('frontend/src/extra.ts'); }, r => { r.inputs = []; },
  r => { r.inputs = [null]; }, r => { r.inputs = { path: 'main.ts' }; },
  r => { r.inputs = ['../../outside.ts']; }, r => { r.inputs = ['/outside.ts']; },
  r => { r.inputsSha256 = '0'.repeat(64); }, r => { r.artifacts['z.js'] = '0'.repeat(64); },
  r => { r.artifacts = {}; }, r => { r.distributionComplete = true; },
  r => { r.goGraphComplete = true; }, r => { r.legalCoverage = []; },
  r => { delete r.observed; }, r => { r.targetContract.extra = 'ambiguous'; },
];

test('synthetic exact-schema comparison rejects schema/contract/locks/manifests/IDs/notices/artifacts/version and unknown claims', () => {
  const expected = syntheticExpected(); // Deliberately synthetic; NO native writer or filesystem claim.
  assertBuildEvidenceSnapshot(structuredClone(expected), expected);
  for (const change of mutations) {
    const bad = structuredClone(expected);
    change(bad);
    assert.throws(() => assertBuildEvidenceSnapshot(bad, expected), /snapshot mismatch/);
  }
  for (const bad of [null, [], {}, 'receipt', { schema: 1 }]) assert.throws(() => assertBuildEvidenceSnapshot(bad, expected), /snapshot mismatch/);
});

test('real-host writer refuses unknown/wrong-host targets before writes and never redirects to legacy', (t) => {
  const root = fixture(t);
  const file = write(root, '.cache/licenses/frontend-build.json', 'legacy sentinel');
  for (const target of ['../../foreign', 'windows-x64', '', ...Object.keys(targets).filter(k => targets[k].mode === 'phase1-build-evidence' && k !== nativeTarget)]) {
    env({ NOTICE_TARGET: target }, () => {
      assert.throws(() => writeBuildReceipt(root, 'frontend', ['src/main.ts']), /Unknown NOTICE_TARGET|native Node/);
      assert.throws(() => validateBuildEvidence(root, target, 'frontend'), /^Error: Phase 1 build-evidence validation failed$/);
    });
  }
  assert.equal(fs.existsSync(path.join(root, '.cache/licenses/inventory')), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'legacy sentinel');
});

// Registered only on a genuinely native Phase 1 target. No skips, host overrides,
// Mac-written fake Windows/Linux receipts, or claims that Mac covers this lane.
if (nativeTarget) {
  test('native Schema 2 writes/validates both areas, repeats bytes and rejects every receipt mutation', (t) => {
    const root = fixture(t);
    env({ NOTICE_TARGET: nativeTarget, npm_config_user_agent: 'pnpm/999.0.0 node/v1.0.0' }, () => {
      for (const area of ['runtime', 'frontend']) {
        writeBuildReceipt(root, area, ['src/main.ts', '\0virtual:opaque', 'src/main.ts']);
        const file = path.join(root, relativeReceipt(nativeTarget, area));
        const before = fs.readFileSync(file);
        const receipt = JSON.parse(before);
        assert.equal(receipt.schema, 2);
        assert.deepEqual(receipt.observed, { ...host, nodeVersion: process.versions.node });
        for (const snapshot of Object.values(receipt.installations)) assert.equal(snapshot.declaredPackageManager, 'pnpm@11.18.0');
        assert.equal(receipt.targetContract.go.GOOS, nativeTarget === 'linux-amd64' ? 'linux' : 'windows');
        assert.equal(before.includes(Buffer.from(root)), false);
        assert.deepEqual(validateBuildEvidence(root, nativeTarget, area), { kind: 'build-evidence', target: nativeTarget, area, artifactCount: 2, distributionComplete: false });
        writeBuildReceipt(root, area, ['\0virtual:opaque', 'src/main.ts']);
        assert.deepEqual(fs.readFileSync(file), before);
        for (const change of mutations) {
          const bad = structuredClone(receipt);
          change(bad);
          // Some synthetic fixed values match a real target/area; ensure mutation.
          if (JSON.stringify(bad) === JSON.stringify(receipt)) continue;
          fs.writeFileSync(file, JSON.stringify(bad, null, 2) + '\n');
          assert.throws(() => validateBuildEvidence(root, nativeTarget, area), /^Error: Phase 1 build-evidence validation failed$/);
        }
        fs.writeFileSync(file, before);
        validateBuildEvidence(root, nativeTarget, area);
        fs.writeFileSync(file, before.toString().replace('"schema": 2,', '"schema": 1, "schema": 2,'));
        assert.throws(() => validateBuildEvidence(root, nativeTarget, area), /validation failed/);
        fs.writeFileSync(file, before);
      }
      assert.equal(fs.existsSync(path.join(root, '.cache/licenses/frontend-build.json')), false);
      assert.equal(fs.existsSync(path.join(root, '.cache/licenses/runtime-build.json')), false);
    });
  });

  test('native writer sanitizes invalid input/stale-install failures without overwriting good evidence', (t) => {
    const root = fixture(t);
    env({ NOTICE_TARGET: nativeTarget }, () => {
      writeBuildReceipt(root, 'frontend', ['src/main.ts']);
      const file = path.join(root, relativeReceipt(nativeTarget));
      const before = fs.readFileSync(file);
      for (const ids of [[], null, [''], [null], [{}], ['src/main.ts', 1], Array(1), ['../../outside.ts'], [path.join(root, '..', 'outside.ts')], [`\0${root}`]]) {
        assert.throws(() => writeBuildReceipt(root, 'frontend', ids), /^Error: Phase 1 build-evidence write failed$/);
        assert.deepEqual(fs.readFileSync(file), before);
      }
      for (const area of ['../frontend', 'unknown', '', null]) assert.throws(() => writeBuildReceipt(root, area, ['src/main.ts']), /write failed/);
      const lock = path.join(root, 'runtime/node_modules/.pnpm/lock.yaml');
      fs.writeFileSync(lock, 'stale');
      assert.throws(() => writeBuildReceipt(root, 'frontend', ['src/main.ts']), /^Error: Phase 1 build-evidence write failed$/);
      assert.deepEqual(fs.readFileSync(file), before);
      assert.throws(() => validateBuildEvidence(root, nativeTarget, 'frontend'), /validation failed/);
      fs.writeFileSync(lock, 'frozen\n');
      for (const name of ['runtime/package.json', 'frontend/pnpm-lock.yaml', 'runtime/node_modules/.pnpm/example@1.0.0/node_modules/example/package.json', 'frontend/node_modules/.pnpm/example@1.0.0/node_modules/example/LICENSE', 'frontend/dist/z.js']) {
        const f = path.join(root, name), bytes = fs.readFileSync(f);
        fs.writeFileSync(f, Buffer.concat([bytes, Buffer.from(' ')]));
        assert.throws(() => validateBuildEvidence(root, nativeTarget, 'frontend'), /validation failed/);
        fs.writeFileSync(f, bytes);
      }
      validateBuildEvidence(root, nativeTarget, 'frontend');
      const extra = path.join(root, 'frontend/node_modules/.pnpm/extra@1.0.0');
      write(root, 'frontend/node_modules/.pnpm/extra@1.0.0/node_modules/extra/package.json', '{"name":"extra","version":"1.0.0"}');
      assert.throws(() => validateBuildEvidence(root, nativeTarget, 'frontend'), /validation failed/);
      fs.rmSync(extra, { recursive: true });
      for (const flags of [{ GOARCH: 'arm64' }, { GOFLAGS: '-tags=server' }, { CGO_ENABLED: nativeTarget === 'linux-amd64' ? '0' : '1' }]) {
        env({ NOTICE_TARGET: nativeTarget, ...flags }, () => {
          assert.throws(() => writeBuildReceipt(root, 'frontend', ['src/main.ts']), /Conflicting|build tags/);
          assert.deepEqual(fs.readFileSync(file), before);
          assert.throws(() => validateBuildEvidence(root, nativeTarget, 'frontend'), /validation failed/);
        });
      }
      assert.throws(() => validateBuildEvidence(root, nativeTarget, '../frontend'), /validation failed/);
      env({ NOTICE_TARGET: 'foreign' }, () => assert.throws(() => validateBuildEvidence(root, nativeTarget, 'frontend'), /validation failed/));
      fs.unlinkSync(file);
      write(root, '.cache/licenses/frontend-build.json', before);
      assert.throws(() => validateBuildEvidence(root, nativeTarget, 'frontend'), /validation failed/);
    });
  });

  test('native reader and writer refuse a redirected evidence directory without changing outside bytes', (t) => {
    const root = fixture(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'target-evidence-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    env({ NOTICE_TARGET: nativeTarget }, () => {
      writeBuildReceipt(root, 'frontend', ['src/main.ts']);
      const targetDir = path.join(root, '.cache/licenses/inventory', nativeTarget);
      const file = path.join(root, relativeReceipt(nativeTarget));
      const before = fs.readFileSync(file);
      // A valid portable receipt makes this a guard test, not a missing-file test.
      const redirected = write(outside, 'receipts/frontend-build.json', before);
      const sentinel = write(outside, 'sentinel.txt', 'outside sentinel');
      fs.rmSync(targetDir, { recursive: true });
      fs.symlinkSync(outside, targetDir, process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(fs.lstatSync(targetDir).isSymbolicLink(), true);
      assert.throws(() => validateBuildEvidence(root, nativeTarget, 'frontend'), /^Error: Phase 1 build-evidence validation failed$/);
      assert.throws(() => writeBuildReceipt(root, 'frontend', ['src/changed.ts']), /^Error: Phase 1 build-evidence write failed$/);
      assert.deepEqual(fs.readFileSync(redirected), before);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside sentinel');
      assert.deepEqual(fs.readdirSync(outside).sort(), ['receipts', 'sentinel.txt']);
      assert.deepEqual(fs.readdirSync(path.join(outside, 'receipts')), ['frontend-build.json']);
    });
  });
}

test('assertion CLI rejects missing/unknown/ambiguous selectors with summary-safe output only', () => {
  const cli = fileURLToPath(new URL('./receipt-evidence.mjs', import.meta.url));
  for (const args of [[], ['assert', '--target', '../../secret', '--area', 'frontend'], ['assert', '--target', 'darwin-arm64', '--area', 'frontend'], ['assert', '--target', 'linux-amd64', '--area', 'frontend', '--area', 'runtime']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, NOTICE_TARGET: '' } });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Phase 1 build-evidence assertion failed\n');
    assert.equal(result.stderr.includes(cli), false);
  }
});

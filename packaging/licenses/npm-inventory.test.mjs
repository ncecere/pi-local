import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as shared from './npm-inventory.mjs';
import * as legacy from './generate.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
function write(root, file, bytes) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), bytes);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'runtime/package.json', JSON.stringify({ devDependencies: { example: '1.0.0' } }));
  for (const f of ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml']) write(root, `runtime/${f}`, 'frozen\n');
  const dir = 'runtime/node_modules/.pnpm/example@1.0.0/node_modules/example';
  write(root, `${dir}/package.json`, '{"name":"example","version":"1.0.0"}');
  write(root, `${dir}/LICENSE`, 'notice bytes');
  return { root, dir };
}

test('generator re-exports the identical shared scanner functions and Map API', (t) => {
  assert.equal(legacy.noticeFiles, shared.noticeFiles);
  assert.equal(legacy.installedPackages, shared.installedPackages);
  const { root, dir } = fixture(t);
  const packages = shared.installedPackages(root, 'runtime');
  assert.ok(packages instanceof Map);
  const p = packages.get('example@1.0.0');
  assert.deepEqual(Object.keys(p), ['id', 'dir', 'pkg', 'files', 'fingerprint']);
  assert.equal(p.dir, path.join(root, dir));
  assert.deepEqual(p.files, ['LICENSE']);
  assert.equal(p.fingerprint, hash(JSON.stringify([['LICENSE', hash('notice bytes')]])));
  write(root, `${dir}/nested/NOTICE`, 'nested');
  write(root, `${dir}/notice.js`, 'ignored code');
  assert.deepEqual(shared.noticeFiles(p.dir, false), ['LICENSE']);
  assert.deepEqual(shared.noticeFiles(p.dir), ['LICENSE', 'nested/NOTICE']);
});

test('identity hashes sorted IDs, representative manifest bytes and complete notice fingerprints, never roots', (t) => {
  const a = fixture(t), b = fixture(t);
  const first = shared.installedPackageIdentity(a.root, 'runtime');
  assert.deepEqual(first, shared.installedPackageIdentity(b.root, 'runtime'));
  assert.equal(JSON.stringify(first).includes(a.root), false);
  assert.equal(first.sha256, hash(JSON.stringify(first.identities)));
  assert.deepEqual(first.identities, [{ id: 'example@1.0.0', packageManifestSha256: hash('{"name":"example","version":"1.0.0"}'), noticeFingerprint: shared.installedPackages(a.root, 'runtime').get('example@1.0.0').fingerprint }]);
  // Explicitly NOT source-integrity evidence.
  write(a.root, `${a.dir}/index.js`, 'unhashed module code');
  assert.deepEqual(shared.installedPackageIdentity(a.root, 'runtime'), first);
  for (const [file, bytes] of [['NOTICE', 'new attribution'], ['package.json', '{"name":"example","version":"1.0.0","license":"MIT"}']]) {
    write(a.root, `${a.dir}/${file}`, bytes);
    assert.notEqual(shared.installedPackageIdentity(a.root, 'runtime').sha256, first.sha256);
  }
  const extra = 'runtime/node_modules/.pnpm/a@2.0.0/node_modules/a';
  write(b.root, `${extra}/package.json`, '{"name":"a","version":"2.0.0"}');
  assert.deepEqual(shared.installedPackageIdentity(b.root, 'runtime').identities.map(p => p.id), ['a@2.0.0', 'example@1.0.0']);
});

test('shared inventory retains missing/stale installation, uninstalled declaration and peer notice refusals', (t) => {
  const { root, dir } = fixture(t);
  const peer = dir.replace('example@1.0.0/node_modules', 'example@1.0.0_peer@2/node_modules');
  write(root, `${peer}/package.json`, '{"name":"example","version":"1.0.0"}');
  write(root, `${peer}/LICENSE`, 'notice bytes');
  assert.equal(shared.installedPackages(root, 'runtime').size, 1);
  write(root, `${peer}/nested/NOTICE`, 'different');
  assert.throws(() => shared.installedPackageIdentity(root, 'runtime'), /Conflicting peer-variant/);
  fs.rmSync(path.join(root, peer, 'nested'), { recursive: true });
  write(root, 'runtime/package.json', '{"dependencies":{"absent":"1.0.0"}}');
  assert.throws(() => shared.installedPackageIdentity(root, 'runtime'), /Uninstalled declared dependency/);
  write(root, 'runtime/pnpm-lock.yaml', 'changed');
  assert.throws(() => shared.installedPackages(root, 'runtime'), /Stale pnpm installation/);
  fs.unlinkSync(path.join(root, 'runtime/node_modules/.pnpm/lock.yaml'));
  assert.throws(() => shared.installedPackages(root, 'runtime'), /Missing frozen pnpm/);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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

test('Git autocrlf checkout preserves both frozen LF locks under repository attributes', (t) => {
  const { root } = fixture(t);
  fs.cpSync(path.join(root, 'runtime'), path.join(root, 'frontend'), { recursive: true });
  const attributes = fs.readFileSync(new URL('../../.gitattributes', import.meta.url));
  write(root, '.gitattributes', attributes);
  // An empty local repository/index only: no commits, identities, hooks or remotes.
  // Do not read personal/global/system Git configuration or inherited Git overrides.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull });
  function git(...args) {
    const result = spawnSync('git', ['-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false', ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, 'isolated Git fixture command must succeed');
  }
  git('init', '--quiet', '--template=');
  git('add', '--', '.gitattributes', 'runtime/pnpm-lock.yaml', 'frontend/pnpm-lock.yaml');
  for (const area of ['runtime', 'frontend']) fs.unlinkSync(path.join(root, area, 'pnpm-lock.yaml'));
  git('checkout-index', '--force', '--', 'runtime/pnpm-lock.yaml', 'frontend/pnpm-lock.yaml');
  for (const area of ['runtime', 'frontend']) {
    assert.deepEqual(fs.readFileSync(path.join(root, area, 'pnpm-lock.yaml')), Buffer.from('frozen\n'));
    assert.equal(shared.installedPackages(root, area).size, 1);
    // Byte-equality refusal remains strict; no CRLF normalization in the scanner.
    write(root, `${area}/pnpm-lock.yaml`, 'frozen\r\n');
    assert.throws(() => shared.installedPackages(root, area), /Stale pnpm installation/);
  }
});

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

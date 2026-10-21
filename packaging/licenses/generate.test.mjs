import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { writeBuildReceipt } from './build-receipt.mjs';
import { assertNamedCoverage, assertTestOnlyExcluded, generate, installedPackages, noticeFiles, npmNotices, pinnedFiles, requireTerms, sha256 } from './generate.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cache = path.join(root, '.cache');
fs.mkdirSync(cache, { recursive: true });
const mit = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
function temp(t) {
  const dir = fs.mkdtempSync(path.join(cache, 'notice-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(base, name, bytes) {
  fs.mkdirSync(path.dirname(path.join(base, name)), { recursive: true });
  fs.writeFileSync(path.join(base, name), bytes);
}
function fakePackage(dir, id = 'example@1.0.0') {
  const i = id.lastIndexOf('@');
  return { dir, id, pkg: { name: id.slice(0, i), version: id.slice(i + 1), license: 'MIT' }, files: noticeFiles(dir) };
}

test('a declaration or short esbuild sidecar is not full license terms', () => {
  for (const text of ['MIT', 'SPDX-License-Identifier: MIT', 'Copyright (c) Example; see https://example.test/LICENSE', '/*! package - MIT License */', mit.slice(0, 500)]) assert.throws(() => requireTerms('example', [text]), /No full license/);
  requireTerms('example', [mit]);
});

test('license-less package requires a reviewed exact-version override, not SPDX', (t) => {
  const dir = temp(t);
  const p = fakePackage(dir);
  assert.throws(() => npmNotices(p, new Map(), {}, dir), /No license\/approved pinned override/);
  write(dir, 'NOTICE', 'Copyright Example');
  assert.throws(() => npmNotices(fakePackage(dir), new Map(), {}, dir), /No license\/approved pinned override/);
  write(dir, 'pinned-MIT', mit);
  const override = { 'example@1.0.0': { review: 'Reviewed release root grant', sourceCommit: '1'.repeat(40), files: [{ path: 'pinned-MIT', sha256: sha256(mit), source: `https://example.test/${'1'.repeat(40)}/LICENSE` }] } };
  assert.equal(npmNotices(p, new Map(), override, dir).files.length, 1);
  assert.throws(() => npmNotices(fakePackage(dir, 'example@1.0.1'), new Map(), override, dir), /No license\/approved pinned override/);
});

test('pinned notice files are mandatory, hash checked and cannot use moving source refs', (t) => {
  const dir = temp(t);
  write(dir, 'LICENSE', mit);
  const ref = { path: 'LICENSE', sha256: sha256(mit), source: `https://example.test/${'a'.repeat(40)}/LICENSE` };
  assert.equal(pinnedFiles(dir, [ref])[0].bytes.toString(), mit);
  assert.throws(() => pinnedFiles(dir, []), /Missing required/);
  assert.throws(() => pinnedFiles(dir, [{ ...ref, path: 'missing' }]), /ENOENT/);
  assert.throws(() => pinnedFiles(dir, [{ ...ref, sha256: '0'.repeat(64) }]), /hash mismatch/);
  assert.throws(() => pinnedFiles(dir, [{ ...ref, source: 'https://example.test/main/LICENSE' }]), /Unpinned/);
  assert.throws(() => pinnedFiles(dir, [{ ...ref, path: '../LICENSE' }]), /Unsafe source path/);
});

test('collect root, inherited, nested license directories and third-party notices verbatim', (t) => {
  const dir = temp(t);
  for (const name of ['LICENSE', 'LICENSE-3RD-PARTY.md', 'NOTICE', 'vendor/NOTICE.txt', 'LICENSES/MIT.txt', '.reuse/dep5']) write(dir, name, mit);
  write(dir, 'copyright.go', 'package ignore');
  write(dir, 'node_modules/ignored/LICENSE', mit);
  fs.symlinkSync(path.join(dir, 'LICENSE'), path.join(dir, 'LICENSE-link'));
  assert.deepEqual(noticeFiles(dir), ['.reuse/dep5', 'LICENSE', 'LICENSE-3RD-PARTY.md', 'LICENSES/MIT.txt', 'NOTICE', 'vendor/NOTICE.txt']);
});

test('pnpm inventory includes declared devDependencies and rejects stale locks or conflicting variants', (t) => {
  const dir = temp(t);
  write(dir, 'frontend/package.json', JSON.stringify({ devDependencies: { example: '1.0.0' } }));
  write(dir, 'frontend/pnpm-lock.yaml', 'frozen lock\n');
  write(dir, 'frontend/node_modules/.pnpm/lock.yaml', 'frozen lock\n');
  const base = 'frontend/node_modules/.pnpm/example@1.0.0/node_modules/example';
  write(dir, `${base}/package.json`, JSON.stringify({ name: 'example', version: '1.0.0' }));
  write(dir, `${base}/LICENSE`, mit);
  assert.equal(installedPackages(dir, 'frontend').size, 1);
  const variant = 'frontend/node_modules/.pnpm/example@1.0.0_peer@2/node_modules/example';
  write(dir, `${variant}/package.json`, JSON.stringify({ name: 'example', version: '1.0.0' }));
  write(dir, `${variant}/LICENSE`, mit);
  write(dir, `${variant}/NOTICE`, 'Different notice');
  assert.throws(() => installedPackages(dir, 'frontend'), /Conflicting peer-variant/);
  write(dir, 'frontend/pnpm-lock.yaml', 'changed lock\n');
  assert.throws(() => installedPackages(dir, 'frontend'), /Stale pnpm installation/);
});

test('native companion inheritance requires the identical parent version', (t) => {
  const dir = temp(t);
  write(dir, 'parent/LICENSE', mit);
  fs.mkdirSync(path.join(dir, 'child'));
  const p = fakePackage(path.join(dir, 'child'), '@esbuild/darwin-arm64@0.25.10');
  const parent = fakePackage(path.join(dir, 'parent'), 'esbuild@0.25.10');
  assert.equal(npmNotices(p, new Map([[parent.id, parent]]), {}, dir).files.length, 1);
  assert.throws(() => npmNotices(p, new Map([['esbuild@0.25.11', parent]]), {}, dir), /No license\/approved/);
});

test('the test-only exclusion fails closed on bundled inputs, stale artifacts or missing receipts', (t) => {
  const dir = temp(t);
  for (const area of ['runtime', 'frontend']) {
    write(dir, `${area}/dist/main.js`, 'console.log(1)');
    writeBuildReceipt(dir, area, ['src/main.ts']);
  }
  assertTestOnlyExcluded(dir, ['runtime', 'frontend']);
  writeBuildReceipt(dir, 'frontend', ['node_modules/.pnpm/stackback@0.0.2/node_modules/stackback/index.js']);
  assert.throws(() => assertTestOnlyExcluded(dir, ['frontend']), /Uncovered shipped dependency/);
  writeBuildReceipt(dir, 'frontend', ['node_modules/vitest/dist/index.js']);
  assert.throws(() => assertTestOnlyExcluded(dir, ['frontend']), /Vitest consumer/);
  write(dir, 'runtime/dist/main.js', 'changed output');
  assert.throws(() => assertTestOnlyExcluded(dir, ['runtime']), /Stale release build receipt/);
  fs.unlinkSync(path.join(dir, '.cache/licenses/runtime-build.json'));
  assert.throws(() => assertTestOnlyExcluded(dir, ['runtime']), /Missing release build receipt/);
});

test('packaging uses frozen installs and assembles notices after Node LICENSE, before any codesign', () => {
  const shell = fs.readFileSync(path.join(root, 'packaging/macos/package.sh'), 'utf8');
  const generator = shell.indexOf('node packaging/licenses/generate.mjs');
  assert.ok(generator > shell.indexOf('"$APP/Contents/Resources/node-LICENSE"'));
  assert.ok(generator < shell.indexOf('codesign --force'));
  assert.match(shell, /runtime install --frozen-lockfile/);
  assert.match(shell, /frontend install --frozen-lockfile/);
  assert.match(shell, /third-party" --node-version "\$NODE_VERSION" "\$GO_NOTICE_ARCH"/);
});

const nodeLicense = process.env.NOTICE_TEST_NODE_LICENSE;
test('installed-tree integration: deterministic packaged contents, full named coverage, no dangling files', { skip: !nodeLicense && 'Set NOTICE_TEST_NODE_LICENSE to a verified Node 22.23.0 distribution LICENSE for integration coverage' }, (t) => {
  const dir = temp(t);
  function resources(name) {
    const res = path.join(dir, name, 'Pi Local.app/Contents/Resources');
    fs.mkdirSync(res, { recursive: true });
    for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(root, f), path.join(res, f));
    fs.copyFileSync(nodeLicense, path.join(res, 'node-LICENSE'));
    return res;
  }
  const a = resources('first'), b = resources('second');
  const options = { root, nodeVersion: '22.23.0', goarch: 'arm64' };
  const manifest = generate({ ...options, out: path.join(a, 'third-party') });
  generate({ ...options, out: path.join(b, 'third-party') });
  function tree(dir, base = '') {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).flatMap((e) => e.isDirectory() ? tree(path.join(dir, e.name), `${base}${e.name}/`) : [[base + e.name, sha256(fs.readFileSync(path.join(dir, e.name)))]]);
  }
  assert.deepEqual(tree(a), tree(b));
  const entries = manifest.packages.map((e) => {
    const texts = e.files.map((f) => {
      const bytes = fs.readFileSync(path.join(a, 'third-party', f.path));
      assert.equal(sha256(bytes), f.sha256, f.path);
      return bytes.toString('utf8');
    });
    requireTerms(e.id, texts);
    return { ...e, text: texts.join('\n') };
  });
  assertNamedCoverage(entries);
  const missingReact = entries.filter((e) => !(e.ecosystem === 'npm-frontend' && e.name === 'react'));
  assert.throws(() => assertNamedCoverage(missingReact), /Required npm notice absent/);
  for (const name of ['@earendil-works/pi-ai', 'standardwebhooks', 'react-remove-scroll-bar', 'remark-math', 'rehype-katex']) {
    const changed = entries.map((e) => e.name === name ? { ...e, override: undefined } : e);
    assert.throws(() => assertNamedCoverage(changed), /Required reviewed override absent/, name);
  }
  const noFeather = entries.map((e) => e.name === 'lucide-react' ? { ...e, text: 'ISC License' } : e);
  assert.throws(() => assertNamedCoverage(noFeather), /Feather/);
  for (const name of ['modernc.org/libc', 'modernc.org/sqlite']) {
    const changed = entries.map((e) => e.name === name ? { ...e, files: e.files.filter((f) => f.original !== 'LICENSE-3RD-PARTY.md') } : e);
    assert.throws(() => assertNamedCoverage(changed), /Required inherited notice absent/);
  }
  assert.equal(entries.filter((e) => e.ecosystem === 'photon-crate').length, 138);
  assert.ok(entries.some((e) => e.name === 'Photon and Roboto' && e.text.includes('Copyright 2011 Google Inc.')));
  assert.ok(entries.some((e) => e.name === 'pdfjs-dist' && e.text.includes('END OF TERMS AND CONDITIONS')));
  assert.ok(entries.filter((e) => e.ecosystem === 'go').length >= 20);
  const legal = fs.readFileSync(path.join(root, 'runtime/dist/runtime.mjs.LEGAL.txt'));
  assert.deepEqual(fs.readFileSync(path.join(a, 'third-party/runtime/runtime.mjs.LEGAL.txt')), legal);
  assert.deepEqual(fs.readFileSync(path.join(a, 'THIRD_PARTY_NOTICES.md')), fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md')));
  assert.ok(!fs.readFileSync(path.join(a, 'third-party/index.json'), 'utf8').includes(root));
  assert.throws(() => generate({ ...options, out: path.join(a, 'third-party') }), /Refusing to overwrite/);

  // A truly missing shipped-package override must stop assembly, without touching installed dependencies.
  const fixture = path.join(dir, 'missing-override');
  for (const area of ['runtime', 'frontend']) {
    for (const file of ['package.json', 'pnpm-lock.yaml']) write(fixture, `${area}/${file}`, fs.readFileSync(path.join(root, area, file)));
    fs.symlinkSync(path.join(root, area, 'node_modules'), path.join(fixture, area, 'node_modules'));
    fs.symlinkSync(path.join(root, area, 'dist'), path.join(fixture, area, 'dist'));
  }
  fs.mkdirSync(path.join(fixture, 'packaging/licenses'), { recursive: true });
  for (const area of ['runtime', 'frontend']) write(fixture, `.cache/licenses/${area}-build.json`, fs.readFileSync(path.join(root, `.cache/licenses/${area}-build.json`)));
  fs.symlinkSync(path.join(root, 'packaging/licenses/sources'), path.join(fixture, 'packaging/licenses/sources'));
  const overrides = JSON.parse(fs.readFileSync(path.join(root, 'packaging/licenses/overrides.json')));
  delete overrides['standardwebhooks@1.1.1'];
  write(fixture, 'packaging/licenses/overrides.json', JSON.stringify(overrides));
  fs.copyFileSync(path.join(root, 'packaging/licenses/photon.json'), path.join(fixture, 'packaging/licenses/photon.json'));
  for (const file of ['go.mod', 'go.sum']) write(fixture, file, fs.readFileSync(path.join(root, file)));
  const failed = path.join(dir, 'must-not-exist');
  assert.throws(() => generate({ ...options, root: fixture, out: failed }), /No license\/approved pinned override for standardwebhooks/);
  assert.equal(fs.existsSync(failed), false);
});

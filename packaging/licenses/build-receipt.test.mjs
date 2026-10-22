import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { artifactHashes, normalizeBuildInput, writeBuildReceipt } from './build-receipt.mjs';

const windowsRoot = 'D:\\a\\pi-local\\pi-local';
const posixRoot = '/release/π local';
const normalize = (id, root = windowsRoot, paths = path.win32) => normalizeBuildInput(root, 'frontend', id, paths);
const outside = (id, root, paths) => assert.throws(() => normalize(id, root, paths), /Bundler input outside release worktree:/);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-π local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, name, bytes) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

test('Windows Vite absolute inputs normalize forward, backward and mixed separators', () => {
  const suffix = 'frontend/node_modules/.pnpm/lucide-react@1.29.0_react@19.2.8/node_modules/lucide-react/dist/esm/icons/map-pin-minus-inside.mjs';
  const expected = suffix;
  for (const id of [`D:/a/pi-local/pi-local/${suffix}`, `${windowsRoot}\\${suffix.replaceAll('/', '\\')}`, `${windowsRoot}/${suffix}`, `D:/a\\pi-local/pi-local\\${suffix}`]) {
    assert.equal(normalize(id), expected);
  }
  assert.equal(normalize('src/../src/π space.ts'), 'frontend/src/π space.ts');
  assert.equal(normalize('src\\π space.ts'), 'frontend/src/π space.ts');
});

test('Windows boundaries reject sibling prefixes, root itself and normalized parent escapes', () => {
  for (const id of [`${windowsRoot}-sibling/frontend/main.ts`, windowsRoot, `${windowsRoot}/../outside.ts`, `${windowsRoot}\\frontend\\..\\..\\outside.ts`, '../../outside.ts', '..\\..\\outside.ts']) outside(id);
  assert.equal(normalize(`${windowsRoot}/frontend/../inside.ts`), 'inside.ts');
  assert.equal(normalize('../inside.ts'), 'inside.ts');
});

test('Windows different volumes, drive case, root case and UNC aliases fail closed', () => {
  for (const id of ['E:/a/pi-local/pi-local/frontend/main.ts', 'E:main.ts', 'd:/a/pi-local/pi-local/frontend/main.ts', 'D:/a/PI-LOCAL/pi-local/frontend/main.ts', '//localhost/D$/a/pi-local/pi-local/frontend/main.ts', '\\\\?\\D:\\a\\pi-local\\pi-local\\frontend\\main.ts']) outside(id);
});

test('UNC worktrees accept exact canonical roots but not share, server or case aliases', () => {
  const root = '\\\\server\\share\\π local';
  assert.equal(normalize('//server/share/π local/frontend/main.ts', root), 'frontend/main.ts');
  assert.equal(normalize('\\\\server/share\\π local/frontend\\main.ts', root), 'frontend/main.ts');
  for (const id of ['//other/share/π local/frontend/main.ts', '//server/other/π local/frontend/main.ts', '//SERVER/share/π local/frontend/main.ts', '//server/share/π local-sibling/main.ts', '//server/share/π local/../outside.ts']) outside(id, root);
});

test('Windows root normalization and Unicode spaces preserve exact spelling', () => {
  const root = 'D:/a/./π space/child/..';
  assert.equal(normalize('D:\\a/π space\\frontend/文 件.ts', root), 'frontend/文 件.ts');
  outside('D:/a/Π space/frontend/文 件.ts', root);
});

test('POSIX real input boundaries normalize dot segments without treating backslashes as separators', () => {
  const n = (id) => normalize(id, posixRoot, path.posix);
  assert.equal(n('/release/π local/frontend/../inside.ts'), 'inside.ts');
  assert.equal(n('src/文 件.ts'), 'frontend/src/文 件.ts');
  assert.equal(n('src\\real.ts'), 'frontend/src\\real.ts');
  assert.equal(n('..\\..\\outside.ts'), 'frontend/..\\..\\outside.ts');
  for (const id of [posixRoot, `${posixRoot}-sibling/main.ts`, `${posixRoot}/../outside.ts`, '../../outside.ts', `${posixRoot}\\frontend/main.ts`]) outside(id, posixRoot, path.posix);
  assert.equal(normalize('/release/π local\\literal/frontend/main.ts', '/release/π local\\literal', path.posix), 'frontend/main.ts');
});

test('virtual NUL and virtual: Windows labels strip only known root prefixes across separator forms', () => {
  for (const prefix of ['\0', 'virtual:']) {
    const expected = `${prefix}frontend/main.ts?proxy`;
    for (const root of [windowsRoot, windowsRoot.replaceAll('\\', '/'), 'D:/a\\pi-local/pi-local']) {
      assert.equal(normalize(`${prefix}${root}/frontend/main.ts?proxy`), expected);
    }
    // Keep graph semantics: no dot resolution, filesystem containment or drive stripping.
    assert.equal(normalize(`${prefix}plugin:../opaque\\label`), `${prefix}plugin:../opaque/label`);
    assert.equal(normalize(`${prefix}E:/outside/main.ts`), `${prefix}E:/outside/main.ts`);
    assert.equal(normalize(`${prefix}${windowsRoot}-sibling/main.ts`), `${prefix}D:/a/pi-local/pi-local-sibling/main.ts`);
    assert.equal(normalize(`${prefix}d:/a/pi-local/pi-local/main.ts`), `${prefix}d:/a/pi-local/pi-local/main.ts`);
    assert.equal(normalize(`${prefix}${windowsRoot}/../opaque`), `${prefix}../opaque`);
  }
});

test('POSIX virtual labels retain opaque graph semantics and remove the exact known root', () => {
  for (const prefix of ['\0', 'virtual:']) {
    assert.equal(normalize(`${prefix}${posixRoot}/frontend/main.ts`, posixRoot, path.posix), `${prefix}frontend/main.ts`);
    assert.equal(normalize(`${prefix}plugin:../opaque\\label`, posixRoot, path.posix), `${prefix}plugin:../opaque/label`);
    assert.equal(normalize(`${prefix}${posixRoot}-sibling/main.ts`, posixRoot, path.posix), `${prefix}${posixRoot}-sibling/main.ts`);
    const root = '/release/π\\literal';
    assert.equal(normalize(`${prefix}${root}/main.ts`, root, path.posix), `${prefix}main.ts`);
    assert.equal(normalize(`${prefix}/release/π/literal/main.ts`, root, path.posix), `${prefix}/release/π/literal/main.ts`);
  }
});

test('host-native receipt writes sorted portable inputs and hashes without mutating artifacts or IDs', (t) => {
  const root = temp(t);
  const name = path.sep === '/' ? 'π real\\name.txt' : 'π real name.txt';
  const bytes = Buffer.from('artifact bytes\n');
  write(root, `frontend/dist/nested/${name}`, bytes);
  write(root, 'frontend/dist/z.js', 'z');
  const input = write(root, `frontend/src/${name}`, 'source');
  const ids = Object.freeze([input, `src/${name}`, '\0virtual:opaque', 'src/z.ts']);
  const expected = {
    schema: 1,
    inputs: ['\0virtual:opaque', 'frontend/src/z.ts', `frontend/src/${name}`],
    artifacts: { [`nested/${name}`]: sha256(bytes), 'z.js': sha256('z') },
  };
  writeBuildReceipt(root, 'frontend', ids);
  const file = path.join(root, '.cache/licenses/frontend-build.json');
  const first = fs.readFileSync(file);
  assert.deepEqual(JSON.parse(first), expected);
  assert.equal(first.toString().includes(root), false);
  writeBuildReceipt(root, 'frontend', [...ids].reverse());
  assert.deepEqual(fs.readFileSync(file), first);
  assert.deepEqual(artifactHashes(path.join(root, 'frontend/dist')), expected.artifacts);
  assert.deepEqual(fs.readFileSync(path.join(root, `frontend/dist/nested/${name}`)), bytes);
  assert.equal(fs.readFileSync(input, 'utf8'), 'source');
});

test('host-native absolute inputs include Vite slash forms on Windows before filesystem receipt writing', (t) => {
  const root = temp(t);
  write(root, 'runtime/dist/runtime.mjs', 'runtime');
  const file = write(root, 'runtime/src/文 件.ts', 'source');
  const ids = [file];
  if (path.sep === '\\') ids.push(file.replaceAll('\\', '/'), file.replace('\\runtime\\', '/runtime/'));
  writeBuildReceipt(root, 'runtime', ids);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.cache/licenses/runtime-build.json')));
  assert.deepEqual(receipt.inputs, ['runtime/src/文 件.ts']);
  assert.deepEqual(receipt.artifacts, { 'runtime.mjs': sha256('runtime') });
});

test('empty and outside graphs fail before creating or overwriting a receipt', (t) => {
  const root = temp(t);
  const receipt = path.join(root, '.cache/licenses/frontend-build.json');
  assert.throws(() => writeBuildReceipt(root, 'frontend', []), /Empty bundler input graph/);
  assert.equal(fs.existsSync(path.join(root, '.cache')), false);
  write(root, 'frontend/dist/main.js', 'main');
  writeBuildReceipt(root, 'frontend', ['src/main.ts']);
  const before = fs.readFileSync(receipt);
  for (const ids of [[], [path.join(root, '..', 'outside.ts')], [`${root}${path.sep}..${path.sep}outside.ts`], ['../../outside.ts'], [`${root}-sibling/main.ts`]]) {
    assert.throws(() => writeBuildReceipt(root, 'frontend', ids), /Empty bundler input graph|Bundler input outside release worktree/);
    assert.deepEqual(fs.readFileSync(receipt), before);
  }
});

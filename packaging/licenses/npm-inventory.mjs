// Shared physical pnpm inventory. No generator/receipt imports or subprocesses.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function requireThat(ok, message) { if (!ok) throw new Error(message); }
const noticeName = /licen[cs]e|copying|notice|copyright|^authors(?:[._-]|$)/i;
const codeName = /\.(?:[cm]?js|[cm]?ts|tsx|jsx|go|rs|c|h|py|json|yaml|yml|map|wasm)$/i;

export function noticeFiles(dir, recursive = true) {
  const files = [];
  function visit(base, prefix = '') {
    for (const e of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => order(a.name, b.name))) {
      if (e.isSymbolicLink()) continue;
      const rel = path.posix.join(prefix, e.name);
      if (e.isDirectory() && recursive && !['node_modules', '.git', 'dist', 'target'].includes(e.name)) visit(path.join(base, e.name), rel);
      else if (e.isFile() && (noticeName.test(rel) || rel === '.reuse/dep5') && !codeName.test(e.name)) files.push(rel);
    }
  }
  visit(dir);
  return files;
}

export function installedPackages(root, area) {
  const store = path.join(root, area, 'node_modules/.pnpm');
  requireThat(fs.existsSync(path.join(store, 'lock.yaml')), `Missing frozen pnpm installation: ${area}`);
  requireThat(fs.readFileSync(path.join(store, 'lock.yaml')).equals(fs.readFileSync(path.join(root, area, 'pnpm-lock.yaml'))), `Stale pnpm installation/lockfile: ${area}`);
  const packages = new Map();
  for (const e of fs.readdirSync(store, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'node_modules') continue;
    const modules = path.join(store, e.name, 'node_modules');
    if (!fs.existsSync(modules)) continue;
    const candidates = [];
    for (const p of fs.readdirSync(modules, { withFileTypes: true })) {
      if (!p.isDirectory()) continue; // pnpm symlinks are represented by their own physical store entry.
      const dir = path.join(modules, p.name);
      if (p.name.startsWith('@')) {
        for (const q of fs.readdirSync(dir, { withFileTypes: true })) if (q.isDirectory()) candidates.push(path.join(dir, q.name));
      } else candidates.push(dir);
    }
    for (const dir of candidates) {
      const manifest = path.join(dir, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      const pkg = readJSON(manifest);
      requireThat(pkg.name && pkg.version, `Unlabelled package: ${manifest}`);
      const id = `${pkg.name}@${pkg.version}`;
      // Peer variants must not silently overwrite different notice content.
      const files = noticeFiles(dir);
      const fingerprint = sha256(JSON.stringify(files.map((f) => [f, sha256(fs.readFileSync(path.join(dir, f)))])));
      if (packages.has(id)) requireThat(packages.get(id).fingerprint === fingerprint, `Conflicting peer-variant notices: ${id}`);
      else packages.set(id, { id, dir, pkg, files, fingerprint });
    }
  }
  requireThat(packages.size > 0, `Empty npm inventory: ${area}`);
  // Also check the root manifests: frontend runtime code is declared in devDependencies.
  const declared = readJSON(path.join(root, area, 'package.json'));
  for (const [name, version] of Object.entries({ ...declared.dependencies, ...declared.devDependencies })) {
    requireThat([...packages.values()].some((p) => p.pkg.name === name && (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || p.pkg.version === version)), `Uninstalled declared dependency: ${area}/${name}@${version}`);
  }
  return packages;
}

// Identity snapshot, NOT a source-integrity or legal-coverage attestation.
// Retains the scanner's unique-ID/notice-equivalent peer deduplication and its
// representative package.json. Does not hash every module/source file.
export function installedPackageIdentity(root, area) {
  const packages = installedPackages(root, area);
  const identities = [...packages.values()].sort((a, b) => order(a.id, b.id)).map((p) => ({
    id: p.id,
    packageManifestSha256: sha256(fs.readFileSync(path.join(p.dir, 'package.json'))),
    noticeFingerprint: p.fingerprint,
  }));
  return { identities, sha256: sha256(JSON.stringify(identities)) };
}

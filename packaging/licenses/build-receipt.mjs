// Build-only evidence, outside embedded dist/: ties the complete bundler input graph to the actual artifacts.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { installedPackageIdentity } from './npm-inventory.mjs';
import { selectNoticeTarget } from './target-policy.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function artifactHashes(dist) {
  const files = [];
  function visit(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isSymbolicLink()) throw new Error(`Unexpected release artifact symlink: ${file}`);
      if (e.isDirectory()) visit(file);
      else if (e.isFile()) files.push([path.relative(dist, file).split(path.sep).join('/'), hash(fs.readFileSync(file))]);
    }
  }
  visit(dist);
  return Object.fromEntries(files.sort(([a], [b]) => order(a, b)));
}

// Only this pure helper accepts an alternate path implementation for boundary tests.
// Receipt filesystem operations below always use the host's native path semantics.
export function normalizeBuildInput(root, area, id, paths = path) {
  root = paths.resolve(root);
  if (id.startsWith('\0') || id.startsWith('virtual:')) {
    // Virtual IDs are graph labels, not filesystem paths. On Windows, Vite may
    // spell the known root with either separator (including mixed separators).
    const portable = (s) => s.replaceAll('\\', '/');
    if (paths.sep === '\\') return portable(id).replaceAll(portable(root + paths.sep), '');
    return portable(id.replaceAll(root + paths.sep, ''));
  }
  const absolute = paths.isAbsolute(id) ? paths.resolve(id) : paths.resolve(root, area, id);
  // Deliberately case-sensitive, even on Windows: do not admit root aliases.
  // Normalize before checking so an absolute root/../outside cannot pass.
  if (!absolute.startsWith(root + paths.sep)) throw new Error(`Bundler input outside release worktree: ${id}`);
  return paths.relative(root, absolute).split(paths.sep).join('/');
}

export function writeBuildReceipt(root, area, ids) {
  const selection = selectNoticeTarget(process.env, { platform: process.platform, arch: process.arch });
  if (selection?.descriptor.mode === 'phase1-build-evidence') {
    try { return writeTargetBuildEvidence(root, area, ids, selection); }
    catch { throw new Error('Phase 1 build-evidence write failed'); }
  }
  root = path.resolve(root);
  const inputs = [...new Set(ids.map((id) => normalizeBuildInput(root, area, id)))].sort(order);
  if (!inputs.length) throw new Error(`Empty bundler input graph: ${area}`);
  const receipt = { schema: 1, inputs, artifacts: artifactHashes(path.join(root, area, 'dist')) };
  const dir = path.join(root, '.cache/licenses');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${area}-build.json`), JSON.stringify(receipt, null, 2) + '\n');
}

function requireArea(area) {
  if (!['runtime', 'frontend'].includes(area)) throw new Error('Unknown build-evidence area');
}

function evidenceRelativePath(selection, area) {
  requireArea(area);
  return `.cache/licenses/inventory/${selection.target}/receipts/${area}-build.json`;
}

// No redirect through symlinked receipt directories/files. Root is the caller's worktree.
function evidenceFile(root, relative) {
  let file = root;
  for (const part of relative.split('/')) {
    file = path.join(file, part);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink()) throw new Error('Symlinked build-evidence path');
  }
  return path.join(root, relative);
}

function inputStrings(ids) {
  if (!Array.isArray(ids) || !ids.length || Object.keys(ids).length !== ids.length) throw new Error('Invalid build-evidence inputs');
  for (const id of ids) if (typeof id !== 'string' || !id.length || (id.includes('\0') && !id.startsWith('\0'))) throw new Error('Invalid build-evidence input');
}

function canonicalInputs(root, area, ids) {
  inputStrings(ids);
  const inputs = [...new Set(ids.map((id) => normalizeBuildInput(root, area, id)))].sort(order);
  // Opaque virtual labels keep legacy semantics, but must not leak this worktree.
  if (inputs.some((id) => id.includes(root) || id.includes(root.replaceAll('\\', '/')))) throw new Error('Nonportable build-evidence input');
  return inputs;
}

function installationSnapshots(root) {
  return Object.fromEntries(['runtime', 'frontend'].map((area) => {
    const manifest = fs.readFileSync(path.join(root, area, 'package.json'));
    const declaredPackageManager = JSON.parse(manifest).packageManager;
    if (typeof declaredPackageManager !== 'string' || !/^pnpm@\d+\.\d+\.\d+$/.test(declaredPackageManager)) throw new Error('Missing exact declared packageManager');
    return [area, {
      declaredPackageManager, // Declaration only; no pnpm execution or user-agent inference.
      rootManifestSha256: hash(manifest),
      lockSha256: hash(fs.readFileSync(path.join(root, area, 'pnpm-lock.yaml'))),
      installedPackageIdentity: installedPackageIdentity(root, area),
    }];
  }));
}

function currentEvidence(root, area, inputs, selection) {
  requireArea(area);
  const artifacts = artifactHashes(path.join(root, area, 'dist'));
  if (!Object.keys(artifacts).length) throw new Error('Empty build-evidence artifacts');
  return {
    schema: 2,
    kind: 'build-evidence',
    target: selection.target,
    area,
    targetContract: selection.descriptor, // Go contract, NOT observed Go execution.
    descriptorSha256: hash(JSON.stringify(selection.descriptor)),
    observed: { platform: process.platform, arch: process.arch, nodeVersion: process.versions.node },
    installations: installationSnapshots(root),
    inputs,
    inputsSha256: hash(JSON.stringify(inputs)),
    artifacts,
    distributionComplete: false,
  };
}

function writeTargetBuildEvidence(root, area, ids, selection) {
  // All validation/snapshot work precedes creation/replacement of any evidence file.
  root = path.resolve(root);
  const relative = evidenceRelativePath(selection, area);
  const inputs = canonicalInputs(root, area, ids);
  const receipt = currentEvidence(root, area, inputs, selection);
  const bytes = JSON.stringify(receipt, null, 2) + '\n';
  const file = evidenceFile(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(file), '.receipt-'));
  try {
    fs.writeFileSync(path.join(stage, 'receipt.json'), bytes);
    fs.renameSync(path.join(stage, 'receipt.json'), file);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

// Pure exact-object comparison, also used by synthetic schema mutation tests.
// This helper alone does NOT verify a host, installation, graph or filesystem.
// The reader below constructs the trusted current snapshot; never from contract
// fields supplied by the receipt. Extra claims/keys at any depth fail closed.
export function assertBuildEvidenceSnapshot(receipt, expected) {
  if (!isDeepStrictEqual(receipt, expected)) throw new Error('Build-evidence snapshot mismatch');
}

// Native Phase 1 evidence ONLY; not a notice, coverage or Go-graph validator.
// Expected target/area are explicit. NOTICE_TARGET may agree, but cannot redirect.
export function validateBuildEvidence(root, target, area) {
  try {
    requireArea(area);
    if (process.env.NOTICE_TARGET !== undefined && process.env.NOTICE_TARGET !== target) throw new Error('Conflicting expected target');
    const selection = selectNoticeTarget({ ...process.env, NOTICE_TARGET: target }, { platform: process.platform, arch: process.arch });
    if (selection.descriptor.mode !== 'phase1-build-evidence') throw new Error('Not Phase 1 evidence');
    root = path.resolve(root);
    const file = evidenceFile(root, evidenceRelativePath(selection, area));
    const bytes = fs.readFileSync(file, 'utf8');
    const receipt = JSON.parse(bytes);
    inputStrings(receipt?.inputs);
    // Stored paths are already root-relative, not area-relative. Preserve the
    // existing helper's POSIX backslash and opaque virtual-label semantics.
    const inputs = canonicalInputs(root, '', receipt.inputs);
    if (!isDeepStrictEqual(receipt.inputs, inputs)) throw new Error('Noncanonical build-evidence inputs');
    const expected = currentEvidence(root, area, inputs, selection);
    assertBuildEvidenceSnapshot(receipt, expected);
    // Canonical writer encoding also excludes duplicate JSON keys/ambiguous encodings.
    if (bytes !== JSON.stringify(expected, null, 2) + '\n') throw new Error('Noncanonical build-evidence encoding');
    return { kind: 'build-evidence', target, area, artifactCount: Object.keys(expected.artifacts).length, distributionComplete: false };
  } catch {
    // No absolute paths, receipt data, package names, hostnames or parser details.
    throw new Error('Phase 1 build-evidence validation failed');
  }
}

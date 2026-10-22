// Build-only evidence, outside embedded dist/: ties the complete bundler input graph to the actual artifacts.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
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
  root = path.resolve(root);
  const inputs = [...new Set(ids.map((id) => normalizeBuildInput(root, area, id)))].sort(order);
  if (!inputs.length) throw new Error(`Empty bundler input graph: ${area}`);
  const receipt = { schema: 1, inputs, artifacts: artifactHashes(path.join(root, area, 'dist')) };
  const dir = path.join(root, '.cache/licenses');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${area}-build.json`), JSON.stringify(receipt, null, 2) + '\n');
}

#!/usr/bin/env node
// Offline release notice assembly. No SPDX-to-template fallback and no network access.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactHashes } from './build-receipt.mjs';
import { noticeFiles, installedPackages } from './npm-inventory.mjs';
export { noticeFiles, installedPackages } from './npm-inventory.mjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function requireThat(ok, message) { if (!ok) throw new Error(message); }
const licenseName = /licen[cs]e|copying|unlicense/i;

export function requireTerms(id, texts) {
  // A declaration, URL, copyright-only stub, or esbuild's short legal comments is not a license grant.
  const complete = (s) =>
    (s.length > 200 && /permission[\s\S]{0,80}(?:granted|use)|redistribution and use/i.test(s) && /provided[\s\S]{0,50}as.is|disclaims all warranties/i.test(s) && /liab|damages/i.test(s)) ||
    (s.length > 9000 && /Apache License/i.test(s) && /END OF TERMS AND CONDITIONS|9\.\s+Accepting Warranty or Additional Liability/.test(s)) ||
    (s.length > 10000 && /Mozilla Public License Version 2\.0/i.test(s) && /Exhibit B/i.test(s)) ||
    (s.length > 6000 && /licensed rights|CC0 1\.0|Creative Commons Zero/i.test(s)) ||
    (s.length > 500 && /public domain/i.test(s) && /as.is/i.test(s));
  requireThat(texts.some(complete), `No full license terms for ${id}`);
}

// The sole omitted installed package is Vitest's stackback (no MIT text published).
// Prove it is absent from BOTH complete bundler graphs, bound to every current dist artifact.
// Sourcemaps alone are insufficient: Rolldown omits maps for forwarding/runtime chunks.
export function assertTestOnlyExcluded(root, areas, id = 'stackback@0.0.2') {
  const name = id.slice(0, id.lastIndexOf('@'));
  const evidence = {};
  for (const area of areas) {
    const receiptFile = path.join(root, '.cache/licenses', `${area}-build.json`);
    requireThat(fs.existsSync(receiptFile), `Missing release build receipt: ${area}; rebuild bundles`);
    const receipt = readJSON(receiptFile);
    requireThat(receipt.schema === 1 && Array.isArray(receipt.inputs) && receipt.inputs.length, `Empty release build graph: ${area}`);
    requireThat(JSON.stringify(receipt.artifacts) === JSON.stringify(artifactHashes(path.join(root, area, 'dist'))), `Stale release build receipt: ${area}`);
    for (const input of receipt.inputs) {
      const source = '/' + input.replaceAll('\\', '/');
      requireThat(!source.includes(`/node_modules/${name}/`) && !/\/node_modules\/(?:vitest\/|@vitest\/)/.test(source), `Uncovered shipped dependency: ${id} or its Vitest consumer (${area})`);
    }
    evidence[area] = receipt;
  }
  return evidence;
}

const inherited = [
  [/^@esbuild\//, 'esbuild'], [/^@rollup\/rollup-/, 'rollup'],
  [/^@rolldown\/binding-/, 'rolldown'], [/^@biomejs\/cli-/, '@biomejs/biome'],
];

export function pinnedFiles(sourceDir, refs) {
  requireThat(Array.isArray(refs) && refs.length > 0, 'Missing required pinned notice files');
  return refs.map((ref) => {
    const file = path.resolve(sourceDir, ref.path);
    requireThat(file.startsWith(path.resolve(sourceDir) + path.sep), `Unsafe source path: ${ref.path}`);
    const bytes = fs.readFileSync(file);
    requireThat(sha256(bytes) === ref.sha256, `Pinned notice hash mismatch: ${ref.path}`);
    requireThat(ref.source && !/\/(?:main|master|latest)\//.test(ref.source), `Unpinned source: ${ref.path}`);
    return { name: ref.path, bytes, source: ref.source };
  });
}

export function npmNotices(p, packages, overrides, sourceDir) {
  let files = p.files.map((name) => ({ name, bytes: fs.readFileSync(path.join(p.dir, name)), source: `npm:${p.id}/${name}` }));
  let override;
  if (overrides[p.id]) {
    override = overrides[p.id];
    requireThat(override.review && /^[a-f0-9]{40}$/.test(override.sourceCommit), `Unreviewed override: ${p.id}`);
    files.push(...pinnedFiles(sourceDir, override.files));
  } else if (!p.files.some((f) => !f.includes('/') && licenseName.test(f))) {
    const parentName = inherited.find(([pattern]) => pattern.test(p.pkg.name))?.[1];
    const parent = packages.get(`${parentName}@${p.pkg.version}`);
    requireThat(parent, `No license/approved pinned override for ${p.id}`);
    files.push(...parent.files.map((name) => ({ name: `inherited/${parent.id}/${name}`, bytes: fs.readFileSync(path.join(parent.dir, name)), source: `npm:${parent.id}/${name}` })));
  }
  const text = files.map((f) => f.bytes.toString('utf8')).join('\n');
  if (/Licensed under the Apache License, Version 2\.0/.test(text) && !text.includes('END OF TERMS AND CONDITIONS')) {
    // Several Vercel packages publish the actual copyright/grant but omit the standard terms.
    // Keep that grant AND add complete, hash-pinned upstream Apache terms; never use SPDX alone.
    requireThat(overrides['$apache-2.0'], `Missing pinned full Apache terms: ${p.id}`);
    files.push(...pinnedFiles(sourceDir, overrides['$apache-2.0'].files));
  }
  requireTerms(p.id, files.map((f) => f.bytes.toString('utf8')));
  return { files, override };
}

export function assertNamedCoverage(entries) {
  function npm(area, name) {
    const found = entries.filter((e) => e.ecosystem === `npm-${area}` && e.name === name);
    requireThat(found.length, `Required npm notice absent: ${area}/${name}`);
    return found;
  }
  for (const name of ['react', 'react-dom', '@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-popover', '@radix-ui/react-slot', '@tanstack/react-query', '@tanstack/react-router', 'streamdown', '@streamdown/code', '@streamdown/math', 'mermaid', 'katex', 'lucide-react']) npm('frontend', name);
  for (const name of ['streamdown', '@streamdown/code', '@streamdown/math']) for (const e of npm('frontend', name)) requireThat(e.text.includes('END OF TERMS AND CONDITIONS') && e.text.includes('Copyright 2023 Vercel'), `Incomplete frontend Apache terms/copyright: ${e.id}`);
  const lucide = npm('frontend', 'lucide-react')[0].text;
  for (const term of ['ISC License', 'Feather', 'Cole Bemis', 'Permission is hereby granted']) requireThat(lucide.includes(term), `Lucide ISC AND Feather MIT notice missing: ${term}`);
  for (const [area, names] of [
    ['runtime', ['@earendil-works/chord', '@earendil-works/pi-ai', '@earendil-works/pi-codemode', '@earendil-works/pi-durable', '@earendil-works/pi-mcp', '@earendil-works/pi-telemetry', 'standardwebhooks']],
    ['frontend', ['react-remove-scroll-bar', 'remark-math', 'rehype-katex']],
  ]) for (const name of names) for (const e of npm(area, name)) {
    requireThat(e.override, `Required reviewed override absent: ${e.id}`);
    requireThat(e.text.includes('Permission is hereby granted') && /SOFTWARE IS PROVIDED/i.test(e.text), `Incomplete MIT override: ${e.id}`);
    if (name.startsWith('@earendil-works/')) requireThat(e.text.includes('Mario Zechner'), `Missing Earendil copyright: ${e.id}`);
  }
  for (const name of ['unpdf', 'fflate', '@silvia-odwyer/photon']) npm('runtime', name);
  for (const [name, required] of [
    ['modernc.org/libc', ['LICENSE', 'LICENSE-3RD-PARTY.md']],
    ['modernc.org/sqlite', ['LICENSE', 'LICENSE-SQLITE', 'LICENSE-3RD-PARTY.md', 'LICENSE-SQLITE_VEC']],
    ['modernc.org/memory', ['LICENSE-GO', 'LICENSE-MMAP-GO']],
    ['gopkg.in/yaml.v3', ['LICENSE', 'NOTICE']],
  ]) {
    const e = entries.find((e) => e.ecosystem === 'go' && e.name === name);
    requireThat(e, `Required Go module absent: ${name}`);
    for (const file of required) requireThat(e.files.some((f) => f.original === file), `Required inherited notice absent: ${name}/${file}`);
  }
}

export function generate({ root, out, nodeVersion, goarch = 'arm64' }) {
  root = path.resolve(root); out = path.resolve(out);
  requireThat(/^\d+\.\d+\.\d+$/.test(nodeVersion), 'Pass the packaged --node-version (not the build host version)');
  requireThat(['arm64', 'amd64'].includes(goarch), 'Unsupported Darwin Go architecture');
  const dataDir = path.join(root, 'packaging/licenses');
  const sourceDir = path.join(dataDir, 'sources');
  const overrides = readJSON(path.join(dataDir, 'overrides.json'));
  const photon = readJSON(path.join(dataDir, 'photon.json'));
  const entries = [], output = new Map();
  const inventories = {}, releaseBuildReceipts = {};
  const put = (name, bytes) => { requireThat(!output.has(name), `Duplicate output: ${name}`); output.set(name, Buffer.from(bytes)); };
  function add(ecosystem, name, version, files, extra = {}) {
    requireThat(files.length, `No notices for ${name}@${version}`);
    const id = `${name}@${version}`;
    const prefix = `${ecosystem}/${encodeURIComponent(id)}`;
    const saved = files.map((f, i) => {
      const relative = `${prefix}/${String(i + 1).padStart(3, '0')}-${encodeURIComponent(f.name)}`;
      put(relative, f.bytes);
      return { path: relative, original: f.name, sha256: sha256(f.bytes), source: f.source };
    });
    entries.push({ ecosystem, name, version, id, files: saved, ...extra, text: files.map((f) => f.bytes.toString('utf8')).join('\n') });
  }
  for (const f of ['runtime/pnpm-lock.yaml', 'frontend/pnpm-lock.yaml', 'go.mod', 'go.sum']) put(`provenance/${f}`, fs.readFileSync(path.join(root, f)));
  const excluded = [];
  for (const area of ['runtime', 'frontend']) {
    const packages = installedPackages(root, area);
    inventories[area] = packages;
    const evidence = assertTestOnlyExcluded(root, [area]);
    releaseBuildReceipts[area] = sha256(JSON.stringify(evidence[area]));
    put(`provenance/${area}-build.json`, JSON.stringify(evidence[area], null, 2) + '\n');
    for (const p of [...packages.values()].sort((a, b) => order(a.id, b.id))) {
      if (p.id === 'stackback@0.0.2') { excluded.push({ ecosystem: `npm-${area}`, id: p.id, reason: 'Vitest-only; absent from the complete, artifact-hash-verified release bundler input graph. No upstream MIT text published; not represented as covered.' }); continue; }
      const { files, override } = npmNotices(p, packages, overrides, sourceDir);
      add(`npm-${area}`, p.pkg.name, p.pkg.version, files, { declaredLicense: p.pkg.license ?? null, packageManifestSha256: sha256(fs.readFileSync(path.join(p.dir, 'package.json'))), ...(override ? { override } : {}) });
    }
  }
  const legalPath = path.join(root, 'runtime/dist/runtime.mjs.LEGAL.txt');
  const legal = fs.readFileSync(legalPath);
  requireThat(legal.length > 0, 'Missing runtime legal comments');
  put('runtime/runtime.mjs.LEGAL.txt', legal);
  const nodeLicense = fs.readFileSync(path.join(path.dirname(out), 'node-LICENSE'));
  requireThat(nodeLicense.length > 50000 && nodeLicense.includes(Buffer.from('Node.js')) && nodeLicense.includes(Buffer.from('Permission is hereby granted')), 'Incomplete Node distribution LICENSE');
  add('node', 'Node.js', nodeVersion, [{ name: 'LICENSE', bytes: nodeLicense, source: `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-darwin-${goarch === 'amd64' ? 'x64' : 'arm64'}.tar.gz#LICENSE` }]);
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const source = fs.readFileSync(path.join(root, name));
    requireThat(source.equals(fs.readFileSync(path.join(path.dirname(out), name))), `Missing/mismatched packaged ${name}`);
    put(`pi-local/${name}`, source);
  }
  requireThat(fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').includes('Copyright (c) Mario Zechner'), 'Missing Pi adaptation notice');

  const env = { ...process.env, GOOS: 'darwin', GOARCH: goarch, CGO_ENABLED: '1', GOPROXY: 'off', GOSUMDB: 'off' };
  const go = (args) => execFileSync('go', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
  go(['mod', 'verify']);
  const moduleLines = go(['list', '-mod=readonly', '-deps', '-f', '{{if .Module}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{if .Module.Replace}}|REPLACED{{end}}{{end}}', './cmd/pi-local']);
  const modules = [...new Set(moduleLines.split('\n').filter(Boolean))].sort(order);
  let externalModules = 0;
  for (const line of modules) {
    const [name, version, dir, replaced] = line.split('|');
    requireThat(!replaced, `Review replacement module notices before release: ${name}`);
    if (path.resolve(dir) === root) continue; // Own root LICENSE/adaptation notice already copied above.
    requireThat(name && version && dir, `Unlabelled Go dependency: ${line}`);
    const names = noticeFiles(dir);
    requireThat(names.some((f) => !f.includes('/') && licenseName.test(f)), `Missing Go root license: ${name}@${version}`);
    const files = names.map((f) => ({ name: f, bytes: fs.readFileSync(path.join(dir, f)), source: `go:${name}@${version}/${f} (go.sum verified module cache)` }));
    requireTerms(name, files.map((f) => f.bytes.toString('utf8')));
    add('go', name, version, files);
    externalModules++;
  }
  requireThat(externalModules >= 20, 'Unexpectedly incomplete Darwin Go dependency inventory');
  const goroot = go(['env', 'GOROOT']);
  const goVersion = go(['env', 'GOVERSION']);
  const toolchain = readJSON(path.join(dataDir, 'go-toolchain.json'));
  const goFiles = ['LICENSE', 'PATENTS'].filter((f) => fs.existsSync(path.join(goroot, f))).map((f) => ({ name: f, bytes: fs.readFileSync(path.join(goroot, f)), source: `Go ${goVersion} distribution/${f}` }));
  if (!goFiles.some((f) => f.name === 'LICENSE') || !goFiles.some((f) => f.name === 'PATENTS')) {
    // Nix's Go distribution omits these root files. Never silently use another toolchain version.
    requireThat(toolchain.version === goVersion, `Review missing Go toolchain licenses: ${goVersion}`);
    goFiles.push(...pinnedFiles(sourceDir, toolchain.files));
  }
  for (const f of noticeFiles(path.join(goroot, 'src'))) goFiles.push({ name: `src/${f}`, bytes: fs.readFileSync(path.join(goroot, 'src', f)), source: `Go ${goVersion} distribution/src/${f}` });
  requireTerms('Go standard library', goFiles.map((f) => f.bytes.toString('utf8')));
  add('go-toolchain', 'Go standard library', goVersion, goFiles);

  const photonPackage = inventories.runtime.get(`${photon.package}@${photon.version}`);
  requireThat(photonPackage, 'Missing pinned Photon version');
  const wasm = fs.readFileSync(path.join(photonPackage.dir, 'photon_rs_bg.wasm'));
  requireThat(sha256(wasm) === photon.wasmSha256, 'Photon WASM changed: re-review constituent inventory');
  const wasmText = wasm.toString('latin1');
  const observed = [...new Set([...wasmText.matchAll(/index\.crates\.io-[a-z0-9]+[\\/]([\w-]+-\d+\.\d+\.\d+)[\\/]/g)].map((m) => m[1]))].sort(order);
  requireThat(JSON.stringify(observed) === JSON.stringify(photon.observedCrates), 'Photon embedded crate inventory mismatch');
  requireThat(wasmText.includes(`/rustc/${photon.rustCommit}/`), 'Photon Rust source revision mismatch');
  for (const id of observed) requireThat(photon.crates.some((c) => `${c.name}-${c.version}` === id), `Missing Photon constituent: ${id}`);
  for (const id of ['image-0.24.9', 'flate2-1.0.34', 'miniz_oxide-0.8.0', 'wasm-bindgen-0.2.95']) requireThat(observed.includes(id), `Required Photon constituent absent: ${id}`);
  const photonFiles = pinnedFiles(sourceDir, photon.files);
  const lockText = photonFiles.find((f) => f.name.endsWith('/Cargo.lock'))?.bytes.toString('utf8');
  requireThat(lockText, 'Missing pinned Photon Cargo.lock');
  for (const block of lockText.split('[[package]]').slice(1)) {
    const name = block.match(/^name = "([^"]+)"/m)?.[1];
    const version = block.match(/^version = "([^"]+)"/m)?.[1];
    const checksum = block.match(/^checksum = "([^"]+)"/m)?.[1];
    if (checksum) requireThat(photon.crates.some((c) => c.name === name && c.version === version && c.archiveSha256 === checksum), `Missing/checksum-mismatched Photon lockfile constituent: ${name}@${version}`);
  }
  for (const name of ['Roboto-NOTICE.txt', 'crate/fonts/Apache License.txt', 'LICENSE-MIT', 'LICENSE-APACHE', 'COPYRIGHT', 'Cargo.lock']) requireThat(photonFiles.some((f) => f.name.endsWith('/' + name)), `Required Photon notice absent: ${name}`);
  const fontNotice = photonFiles.find((f) => f.name.endsWith('Roboto-NOTICE.txt')).bytes.toString('utf8');
  requireThat(fontNotice.includes('Copyright 2011 Google Inc.') && fontNotice.includes('2.137; 2017'), 'Missing embedded Roboto copyright/version');
  add('wasm', 'Photon and Roboto', photon.version, photonFiles, { provenance: photon });
  for (const c of photon.crates) {
    const files = pinnedFiles(sourceDir, c.files);
    requireTerms(`${c.name}@${c.version}`, files.map((f) => f.bytes.toString('utf8')));
    add('photon-crate', c.name, c.version, files, { declaredLicense: c.license, archive: c.archive, archiveSha256: c.archiveSha256, evidence: c.evidence, ...(c.review ? { review: c.review } : {}) });
  }
  const pdfjs = readJSON(path.join(dataDir, 'pdfjs.json'));
  const unpdf = inventories.runtime.get(`unpdf@${pdfjs.unpdfVersion}`);
  requireThat(unpdf && sha256(fs.readFileSync(path.join(unpdf.dir, 'dist/pdfjs.mjs'))) === pdfjs.unpdfPdfjsSha256, 'Bundled PDF.js changed: re-review pinned upstream licenses');
  const pdfjsFiles = pinnedFiles(sourceDir, pdfjs.files);
  requireTerms('PDF.js', pdfjsFiles.map((f) => f.bytes.toString('utf8')));
  requireThat(pdfjsFiles.some((f) => f.name.endsWith('/LICENSE')) && pdfjsFiles.some((f) => f.name.endsWith('/UPSTREAM-BUILD-NOTICES.txt')), 'Missing PDF.js full license/build attributions');
  add('bundled-npm', pdfjs.name, pdfjs.version, pdfjsFiles, { provenance: pdfjs });
  assertNamedCoverage(entries);

  // Byte-for-byte deterministic: no clocks, absolute cache paths, filesystem ordering or host identifiers.
  const manifest = {
    schema: 1,
    policy: 'All installed npm packages (including frontend devDependencies) except proven test-only stackback; all production Darwin Go modules; pinned Photon/PDF.js constituents. Conservative inventories include unshipped build/dev/other-target constituents.',
    target: { GOOS: 'darwin', GOARCH: goarch, CGO_ENABLED: '1' },
    inputs: Object.fromEntries(['runtime/pnpm-lock.yaml', 'frontend/pnpm-lock.yaml', 'go.mod', 'go.sum', 'runtime/dist/runtime.mjs', 'runtime/dist/runtime.mjs.LEGAL.txt', 'packaging/licenses/overrides.json', 'packaging/licenses/photon.json', 'packaging/licenses/pdfjs.json', 'packaging/licenses/go-toolchain.json'].map((f) => [f, sha256(fs.readFileSync(path.join(root, f)))])),
    excluded,
    releaseBuildReceipts,
    packages: entries.map(({ text, ...e }) => e).sort((a, b) => order(`${a.ecosystem}/${a.id}`, `${b.ecosystem}/${b.id}`)),
  };
  put('index.json', JSON.stringify(manifest, null, 2) + '\n');
  put('README.txt', 'Pi Local third-party notices\n\nStart with index.json: package/version labels, source provenance, copied-file SHA-256 hashes, and exclusions.\nEach listed file is the complete upstream notice/license text, not an SPDX substitute.\nRuntime legal comments are retained in runtime/runtime.mjs.LEGAL.txt in addition to npm terms.\nNode LICENSE and the Pi adaptation notice are also retained beside this directory.\nPhoton includes the published Cargo.lock inventory plus versions observed in the pinned WASM; this is a conservative notice inventory, not a claim that every lockfile crate ships.\n');
  requireThat(!fs.existsSync(out), `Refusing to overwrite existing notice directory: ${out}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(out), '.third-party-'));
  try {
    for (const [relative, bytes] of [...output].sort(([a], [b]) => order(a, b))) {
      const file = path.join(stage, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    fs.renameSync(stage, out);
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    requireThat(args.length === 4 && args[1] === '--node-version', 'Usage: node packaging/licenses/generate.mjs Contents/Resources/third-party --node-version X.Y.Z arm64|amd64');
    const manifest = generate({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), out: args[0], nodeVersion: args[2], goarch: args[3] });
    console.log(`Third-party notices: ${manifest.packages.length} package/version entries (${manifest.packages.filter((e) => e.ecosystem === 'go').length} external Go modules)`);
  } catch (error) { console.error(`Third-party notice generation failed: ${error.message}`); process.exitCode = 1; }
}

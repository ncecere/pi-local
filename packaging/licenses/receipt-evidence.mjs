#!/usr/bin/env node
// Phase 1 assertion only: no legal inventory output, legacy fallback or Go calls.
import { fileURLToPath } from 'node:url';
import { validateBuildEvidence } from './build-receipt.mjs';
try {
  const args = process.argv.slice(2);
  if (args.length !== 5 || args[0] !== 'assert' || args[1] !== '--target' || args[3] !== '--area') throw new Error('Invalid assertion arguments');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  console.log(JSON.stringify(validateBuildEvidence(root, args[2], args[4])));
} catch {
  console.error('Phase 1 build-evidence assertion failed');
  process.exitCode = 1;
}

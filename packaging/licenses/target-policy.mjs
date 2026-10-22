// Pure policy: no filesystem writes, Go execution, environment mutation or host probing.
import descriptors from './targets.json' with { type: 'json' };
function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}
export const targets = freeze(descriptors);
export function targetDescriptor(target) {
  if (typeof target !== 'string' || !Object.hasOwn(targets, target)) throw new Error('Unknown NOTICE_TARGET');
  return targets[target];
}

// Fake hosts are supported ONLY here, for pure policy tests, never by the writer/reader.
export function selectNoticeTarget(env, host) {
  if (env.NOTICE_TARGET === undefined) return null; // Preserve the entire legacy default path.
  const target = env.NOTICE_TARGET;
  const descriptor = targetDescriptor(target);
  for (const key of ['GOOS', 'GOARCH', 'CGO_ENABLED']) {
    if (env[key] !== undefined && env[key] !== descriptor.go[key]) throw new Error('Conflicting target environment');
  }
  // The reviewed contract uses the desktop defaults, not gtk3/server/custom tags.
  if (typeof env.GOFLAGS === 'string' && /(?:^|[\s"'])-tags(?:[=\s"']|$)/.test(env.GOFLAGS)) throw new Error('Custom Go build tags are outside the target contract');
  for (const [key, value] of [
    ['npm_config_platform', descriptor.node.platform], ['npm_config_arch', descriptor.node.arch],
    ['npm_config_target_platform', descriptor.node.platform], ['npm_config_target_arch', descriptor.node.arch],
  ]) {
    if (env[key] !== undefined && env[key] !== value) throw new Error('Conflicting Node target environment');
  }
  if (descriptor.mode === 'phase1-build-evidence' && (host.platform !== descriptor.node.platform || host.arch !== descriptor.node.arch)) throw new Error('Target requires matching native Node host OS and architecture');
  return { target, descriptor };
}

/**
 * Friendly names for a new agent left unnamed: short, easy to say, and not
 * anyone's job title (so "ask Juniper" reads naturally in a conversation).
 */
export const AGENT_NAMES = [
  'Ada',
  'Alder',
  'Aria',
  'Aspen',
  'Atlas',
  'Basil',
  'Birch',
  'Cedar',
  'Clover',
  'Comet',
  'Cosmo',
  'Dahlia',
  'Ember',
  'Fern',
  'Finch',
  'Flint',
  'Hazel',
  'Indigo',
  'Iris',
  'Jasper',
  'Juniper',
  'Kestrel',
  'Kit',
  'Lark',
  'Linden',
  'Luna',
  'Maple',
  'Marlo',
  'Milo',
  'Nova',
  'Oak',
  'Olive',
  'Onyx',
  'Opal',
  'Orion',
  'Otto',
  'Pepper',
  'Pip',
  'Quill',
  'Rowan',
  'Sage',
  'Skye',
  'Sol',
  'Sparrow',
  'Tansy',
  'Teal',
  'Wren',
  'Yarrow',
  'Zephyr',
  'Ziggy',
] as const;

/**
 * A random friendly name no agent has yet (compared without case), different
 * from `not` (the one shown now, so shuffling always changes it). When every
 * name is taken, one gets a number: "Wren 2".
 */
export function randomAgentName(
  taken: Iterable<string>,
  not = '',
  random: () => number = Math.random,
): string {
  const used = new Set([...taken].map((name) => name.trim().toLowerCase()));
  const skip = not.trim().toLowerCase();
  const free = AGENT_NAMES.filter(
    (name) => !used.has(name.toLowerCase()) && name.toLowerCase() !== skip,
  );
  const pick = free[Math.floor(random() * free.length)] ?? free[0];
  if (pick) return pick;
  const base = AGENT_NAMES[Math.floor(random() * AGENT_NAMES.length)] ?? AGENT_NAMES[0];
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase()) && candidate.toLowerCase() !== skip) return candidate;
  }
}

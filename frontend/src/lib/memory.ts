import type { Basics, Fact } from '~/api/client';

/** The categories an agent sees only when shared with it, until `GET /api/you` says. */
export const DEFAULT_SHAREABLE = [
  'people',
  'projects',
  'work',
  'health',
  'family',
  'finances',
  'home',
  'interests',
];

/** How a memory category reads: "preferences" → "Preferences". */
export const categoryLabel = (category: string) =>
  category ? category.charAt(0).toUpperCase() + category.slice(1) : 'Other';

/** The About me card's fields, in order, with a line of help each. */
export const BASICS_FIELDS: {
  key: keyof Basics;
  label: string;
  hint: string;
  placeholder: string;
}[] = [
  { key: 'name', label: 'Name', hint: 'Your full name.', placeholder: 'Sam Rivera' },
  {
    key: 'addressAs',
    label: 'Call me',
    hint: 'How agents address you: a first name or a nickname.',
    placeholder: 'Sam',
  },
  { key: 'role', label: 'Role', hint: 'What you do.', placeholder: 'Product designer' },
  {
    key: 'organization',
    label: 'Organization',
    hint: 'Where you work or study.',
    placeholder: 'Acme Inc.',
  },
  {
    key: 'timezone',
    label: 'Time zone',
    hint: 'For dates and times.',
    placeholder: 'America/New_York',
  },
  {
    key: 'language',
    label: 'Language',
    hint: 'The language agents answer in.',
    placeholder: 'English',
  },
  {
    key: 'answerStyle',
    label: 'Answer style',
    hint: 'How you like answers.',
    placeholder: 'Short and direct',
  },
  {
    key: 'signOff',
    label: 'Sign-off',
    hint: 'How to sign messages written for you.',
    placeholder: 'Best, Sam',
  },
];

export const EMPTY_BASICS: Basics = {
  name: '',
  role: '',
  organization: '',
  timezone: '',
  language: '',
  addressAs: '',
  answerStyle: '',
  signOff: '',
};

/** Facts by category, in the categories' order (any unknown category last). */
export function groupFacts(
  facts: readonly Fact[],
  categories: readonly string[],
): { category: string; facts: Fact[] }[] {
  const order = [...categories, ...facts.map((fact) => fact.category)].filter(
    (category, index, all) => all.indexOf(category) === index,
  );
  return order
    .map((category) => ({
      category,
      // Pinned first, then newest.
      facts: facts
        .filter((fact) => fact.category === category)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt),
    }))
    .filter((group) => group.facts.length > 0);
}

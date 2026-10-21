import { type ZipEntry, zipFiles } from '~/lib/zip';

/** The most a skill's zip may be (the API's limit). */
export const MAX_SKILL_ZIP_BYTES = 25 * 1024 * 1024;

/** A file picked with a folder chooser carries its path from the chosen folder (`webkitRelativePath`). */
type PickedFile = File & { webkitRelativePath?: string };

/** Paths that aren't part of a skill: dot files and folders, macOS's __MACOSX, and installed packages. */
export function skippedInSkill(path: string): boolean {
  return path
    .split('/')
    .some((part) => part.startsWith('.') || part === '__MACOSX' || part === 'node_modules');
}

/**
 * The zip of a folder the person picked: every file with its path from the folder's parent (so `my-skill/SKILL.md`),
 * which the API reads as "the one folder that holds everything". Throws a plain sentence when it can't be one.
 */
export async function zipOfPickedFolder(files: readonly PickedFile[]): Promise<ArrayBuffer> {
  const entries: ZipEntry[] = [];
  let bytes = 0;
  for (const file of files) {
    const path = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
    if (skippedInSkill(path)) continue;
    if (file.size > 5 * 1024 * 1024) throw new Error('A skill file is at most 5 MB.');
    bytes += file.size;
    if (bytes > 20 * 1024 * 1024 || entries.length >= 300)
      throw new Error('A skill is at most 20 MB and 300 files.');
    entries.push({ path, data: new Uint8Array(await file.arrayBuffer()) });
  }
  if (entries.length === 0) throw new Error('That folder has no files.');
  if (
    !entries.some(
      (entry) => /(^|\/)SKILL\.md$/.test(entry.path) && entry.path.split('/').length <= 2,
    )
  )
    throw new Error(
      'A skill\u2019s folder has a SKILL.md at its top. Choose the folder that holds it.',
    );
  const zip = zipFiles(entries);
  if (zip.length > MAX_SKILL_ZIP_BYTES)
    throw new Error('That folder is more than 25 MB; a skill is smaller than that.');
  return zip.buffer;
}

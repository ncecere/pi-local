import { describe, expect, it } from 'vitest';
import { skippedInSkill, zipOfPickedFolder } from '../../src/lib/skill-files';
import { crc32, zipFiles } from '../../src/lib/zip';

const text = (s: string) => new TextEncoder().encode(s);

/** Reads a stored zip back through its central directory, as any unzipper does. */
function readZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out: Record<string, { text: string; crc: number }> = {};
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // The local header agrees, and the data follows its name.
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + view.getUint16(local + 26, true);
    out[name] = { text: new TextDecoder().decode(bytes.subarray(start, start + size)), crc };
    at += 46 + nameLength;
  }
  return out;
}

describe('zipFiles', () => {
  it('has the standard CRC-32', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('writes entries a zip reader can find again, with their checksums', () => {
    const zip = zipFiles([
      { path: 'my-skill/SKILL.md', data: text('---\nname: my-skill\n---\nhello é') },
      { path: 'my-skill/references/style.md', data: text('Be brief.') },
    ]);
    const back = readZip(zip);
    expect(Object.keys(back)).toEqual(['my-skill/SKILL.md', 'my-skill/references/style.md']);
    expect(back['my-skill/SKILL.md']?.text).toBe('---\nname: my-skill\n---\nhello é');
    expect(back['my-skill/references/style.md']?.crc).toBe(crc32(text('Be brief.')));
  });

  it('writes an empty zip', () => {
    expect(readZip(zipFiles([]))).toEqual({});
  });
});

function picked(path: string, content: string): File {
  const file = new File([content], path.split('/').pop() ?? path);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

describe('a folder picked for a skill', () => {
  it('leaves out hidden files, __MACOSX and node_modules', () => {
    expect(skippedInSkill('my-skill/SKILL.md')).toBe(false);
    expect(skippedInSkill('my-skill/.git/config')).toBe(true);
    expect(skippedInSkill('my-skill/.DS_Store')).toBe(true);
    expect(skippedInSkill('__MACOSX/my-skill/x')).toBe(true);
    expect(skippedInSkill('my-skill/scripts/node_modules/x/index.js')).toBe(true);
  });

  it('is zipped with its paths from the folder, hidden things left out', async () => {
    const zip = await zipOfPickedFolder([
      picked('my-skill/SKILL.md', 'instructions'),
      picked('my-skill/references/a.md', 'A'),
      picked('my-skill/.DS_Store', 'junk'),
      picked('my-skill/node_modules/x.js', 'junk'),
    ]);
    expect(Object.keys(readZip(new Uint8Array(zip)))).toEqual([
      'my-skill/SKILL.md',
      'my-skill/references/a.md',
    ]);
  });

  it('checks file and aggregate limits before reading oversized contents', async () => {
    let reads = 0;
    const sized = (size: number) =>
      ({
        name: 'x.txt',
        webkitRelativePath: 'skill/x.txt',
        size,
        arrayBuffer: async () => {
          reads++;
          return new ArrayBuffer(0);
        },
      }) as File;
    await expect(zipOfPickedFolder([sized(5 * 1024 * 1024 + 1)])).rejects.toThrow(/5 MB/);
    expect(reads).toBe(0);
    await expect(
      zipOfPickedFolder(Array.from({ length: 5 }, () => sized(5 * 1024 * 1024))),
    ).rejects.toThrow(/20 MB/);
    expect(reads).toBe(4);
    await expect(zipOfPickedFolder(Array.from({ length: 301 }, () => sized(0)))).rejects.toThrow(
      /300 files/,
    );
  });

  it('says plainly when there is no SKILL.md at the top, or nothing in the folder', async () => {
    await expect(zipOfPickedFolder([picked('docs/readme.md', 'x')])).rejects.toThrow(
      /SKILL\.md at its top/,
    );
    await expect(zipOfPickedFolder([picked('docs/deep/SKILL.md', 'x')])).rejects.toThrow(
      /SKILL\.md at its top/,
    );
    await expect(zipOfPickedFolder([picked('docs/.hidden', 'x')])).rejects.toThrow(/no files/);
    await expect(zipOfPickedFolder([])).rejects.toThrow(/no files/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  attachmentProblem,
  attachmentUploadPath,
  canReadAttachments,
  fileKindOf,
  formatBytes,
  MAX_ATTACHMENT_BYTES,
  parseSize,
  pastedFileName,
  pastedFilesOf,
  splitAttachmentBlock,
  stripAttachmentBlock,
  titleFromFiles,
} from '../../src/lib/attachments.ts';

describe('attachments', () => {
  it('formats sizes as people read them', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(120 * 1024)).toBe('120 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(4.2 * 1024 * 1024)).toBe('4.2 MB');
    expect(formatBytes(MAX_ATTACHMENT_BYTES)).toBe('100 MB');
  });

  it('reads sizes back to bytes', () => {
    expect(parseSize('120 KB')).toBe(120 * 1024);
    expect(parseSize('1.5 KB')).toBe(1536);
    expect(parseSize('300 B')).toBe(300);
    expect(parseSize('4.2 MB')).toBe(Math.round(4.2 * 1024 * 1024));
    expect(parseSize('lots')).toBe(0);
  });

  describe('a message sent before v0.2 (the block is in its text)', () => {
    const block = [
      'Attached files (in your workspace):',
      '- attachments/2026-10-20/report.pdf (120 KB)',
      '- attachments/2026-10-20/notes (2).txt (300 B)',
    ].join('\n');

    it('takes the trailing block out of the text as files', () => {
      const split = splitAttachmentBlock(`Summarise these\n\n${block}`);
      expect(split.text).toBe('Summarise these');
      expect(split.attachments).toEqual([
        {
          path: 'attachments/2026-10-20/report.pdf',
          name: 'report.pdf',
          size: 120 * 1024,
          mediaType: 'application/pdf',
        },
        {
          path: 'attachments/2026-10-20/notes (2).txt',
          name: 'notes (2).txt',
          size: 300,
          mediaType: 'text/plain',
        },
      ]);
    });

    it('has no text left when the files were sent alone', () => {
      const split = splitAttachmentBlock(block);
      expect(split.text).toBe('');
      expect(split.attachments).toHaveLength(2);
    });

    it('strips it from the text a copy holds', () => {
      expect(stripAttachmentBlock(`Look at this\n\n${block}\n`)).toBe('Look at this');
      expect(stripAttachmentBlock('No files here')).toBe('No files here');
    });

    it('leaves text alone when the block is not the end of it, or not file lines', () => {
      const middle = `${block}\n\nThanks!`;
      expect(splitAttachmentBlock(middle)).toEqual({ text: middle, attachments: [] });
      const quoted = 'Attached files (in your workspace):\nsee the list above';
      expect(splitAttachmentBlock(quoted)).toEqual({ text: quoted, attachments: [] });
      const heading = 'Attached files (in your workspace):';
      expect(splitAttachmentBlock(heading)).toEqual({ text: heading, attachments: [] });
    });
  });

  it('tells the kind of file for its icon', () => {
    expect(fileKindOf({ name: 'shot.png', mediaType: 'image/png' })).toBe('image');
    expect(fileKindOf({ name: 'photo.JPG', mediaType: '' })).toBe('image');
    expect(fileKindOf({ name: 'a.pdf', mediaType: 'application/pdf' })).toBe('pdf');
    expect(fileKindOf({ name: 'letter.docx', mediaType: '' })).toBe('doc');
    expect(
      fileKindOf({
        name: 'x',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ).toBe('sheet');
    expect(fileKindOf({ name: 'data.csv', mediaType: 'text/csv' })).toBe('sheet');
    expect(fileKindOf({ name: 'deck.pptx', mediaType: '' })).toBe('slides');
    expect(fileKindOf({ name: 'run.sh', mediaType: 'application/x-sh' })).toBe('file');
    expect(fileKindOf({ name: 'README', mediaType: undefined })).toBe('file');
  });

  it('names a screenshot from the clipboard after the moment it was taken', () => {
    const at = new Date(2026, 9, 21, 14, 3, 22);
    expect(pastedFileName({ name: 'image.png', type: 'image/png' }, at)).toBe(
      'Pasted image 2026-10-21 at 14.03.22.png',
    );
    // Unnamed, or named by its type alone.
    expect(pastedFileName({ name: '', type: 'image/jpeg' }, at)).toBe(
      'Pasted image 2026-10-21 at 14.03.22.jpg',
    );
    expect(pastedFileName({ name: 'image.jpeg', type: 'image/jpeg' }, at)).toBe(
      'Pasted image 2026-10-21 at 14.03.22.jpeg',
    );
    // A real name stays.
    expect(pastedFileName({ name: 'Q3 report.pdf', type: 'application/pdf' }, at)).toBe(
      'Q3 report.pdf',
    );
  });

  it('keeps pasted names unique among the files already attached', () => {
    const at = new Date(2026, 9, 21, 14, 3, 22);
    const first = 'Pasted image 2026-10-21 at 14.03.22.png';
    expect(pastedFileName({ name: 'image.png', type: 'image/png' }, at, new Set([first]))).toBe(
      'Pasted image 2026-10-21 at 14.03.22 (2).png',
    );
    expect(
      pastedFileName(
        { name: 'image.png', type: 'image/png' },
        at,
        new Set([first, 'Pasted image 2026-10-21 at 14.03.22 (2).png']),
      ),
    ).toBe('Pasted image 2026-10-21 at 14.03.22 (3).png');
    expect(pastedFileName({ name: 'a.pdf', type: 'application/pdf' }, at, new Set(['a.pdf']))).toBe(
      'a (2).pdf',
    );
  });

  describe('what a paste carries', () => {
    const png = new File(['x'], 'image.png', { type: 'image/png' });
    const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const data = (files: File[], text = '') =>
      ({
        items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
        files,
        getData: () => text,
      }) as unknown as DataTransfer;

    it('is the files of a screenshot', () => {
      expect(pastedFilesOf(data([png]))).toEqual([png]);
    });
    it('is the text, not the picture of it, when copied from a page or a sheet', () => {
      expect(pastedFilesOf(data([png], 'a1\tb1'))).toEqual([]);
    });
    it('is a copied file even though its name came as text', () => {
      expect(pastedFilesOf(data([pdf], 'a.pdf'))).toEqual([pdf]);
    });
    it('falls back to `files` where the items list none', () => {
      const bare = { items: [], files: [png], getData: () => '' } as unknown as DataTransfer;
      expect(pastedFilesOf(bare)).toEqual([png]);
    });
    it('is nothing for text', () => {
      expect(pastedFilesOf(data([], 'hello'))).toEqual([]);
      expect(pastedFilesOf(null)).toEqual([]);
    });
  });

  it('names a conversation begun with files alone after them', () => {
    expect(titleFromFiles([{ name: 'a.pdf' }, { name: 'b.csv' }])).toBe('a.pdf, b.csv');
  });

  it('refuses files over 100 MiB', () => {
    expect(attachmentProblem({ name: 'a.bin', size: MAX_ATTACHMENT_BYTES })).toBeNull();
    expect(attachmentProblem({ name: 'big.bin', size: MAX_ATTACHMENT_BYTES + 1 })).toMatch(
      /up to 100 MB/,
    );
  });

  it('needs the read tool', () => {
    expect(canReadAttachments({ workspace: { tools: ['read', 'bash'] } })).toBe(true);
    expect(canReadAttachments({ workspace: { tools: ['bash'] } })).toBe(false);
    expect(canReadAttachments({})).toBe(false);
    expect(canReadAttachments(null)).toBe(false);
  });

  it('encodes the file name in the upload path', () => {
    expect(attachmentUploadPath('ag_a', 'Q3 report & notes.pdf')).toBe(
      '/api/agents/ag_a/attachments?name=Q3%20report%20%26%20notes.pdf',
    );
  });
});

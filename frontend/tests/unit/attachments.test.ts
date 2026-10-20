import { describe, expect, it } from 'vitest';
import {
  attachmentBlock,
  attachmentProblem,
  attachmentUploadPath,
  canReadAttachments,
  formatBytes,
  MAX_ATTACHMENT_BYTES,
  messageWithAttachments,
} from '../../src/lib/attachments.ts';

describe('attachments', () => {
  it('formats sizes as people read them', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(120 * 1024)).toBe('120 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(4.2 * 1024 * 1024)).toBe('4.2 MB');
    expect(formatBytes(MAX_ATTACHMENT_BYTES)).toBe('100 MB');
  });

  it("writes the contract's block, one line per file", () => {
    expect(
      attachmentBlock([
        { path: 'attachments/2026-10-20/report.pdf', size: 120 * 1024 },
        { path: 'attachments/2026-10-20/notes (2).txt', size: 300 },
      ]),
    ).toBe(
      [
        'Attached files (in your workspace):',
        '- attachments/2026-10-20/report.pdf (120 KB)',
        '- attachments/2026-10-20/notes (2).txt (300 B)',
      ].join('\n'),
    );
    expect(attachmentBlock([])).toBe('');
  });

  it('puts the block after the text, or sends it alone', () => {
    const files = [{ path: 'attachments/2026-10-20/a.csv', size: 2048 }];
    expect(messageWithAttachments('  Summarise this  ', files)).toBe(
      'Summarise this\n\nAttached files (in your workspace):\n- attachments/2026-10-20/a.csv (2 KB)',
    );
    expect(messageWithAttachments('', files)).toBe(
      'Attached files (in your workspace):\n- attachments/2026-10-20/a.csv (2 KB)',
    );
    expect(messageWithAttachments(' hi ', [])).toBe('hi');
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

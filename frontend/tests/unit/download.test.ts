import { describe, expect, it } from 'vitest';
import { filenameFromContentDisposition } from '../../src/lib/download.ts';

describe('filenameFromContentDisposition', () => {
  it('reads a quoted filename', () => {
    expect(filenameFromContentDisposition('attachment; filename="Research helper.zip"')).toBe(
      'Research helper.zip',
    );
  });

  it('reads an unquoted filename', () => {
    expect(filenameFromContentDisposition('attachment; filename=agent.zip')).toBe('agent.zip');
  });

  it('prefers filename* (RFC 5987) and decodes its UTF-8', () => {
    expect(
      filenameFromContentDisposition(
        `attachment; filename="Caf_.zip"; filename*=UTF-8''Caf%C3%A9%20helper.zip`,
      ),
    ).toBe('Café helper.zip');
  });

  it('decodes an ISO-8859-1 filename*', () => {
    expect(filenameFromContentDisposition(`attachment; filename*=iso-8859-1'en'caf%E9.zip`)).toBe(
      'café.zip',
    );
  });

  it('falls back to filename when filename* is malformed', () => {
    expect(
      filenameFromContentDisposition(
        `attachment; filename*=UTF-8''%E0%A4%A.zip; filename="ok.zip"`,
      ),
    ).toBe('ok.zip');
  });

  it('keeps escaped quotes and semicolons inside a quoted value', () => {
    expect(filenameFromContentDisposition('attachment; filename="a \\"b\\"; c.zip"')).toBe(
      'a "b"; c.zip',
    );
  });

  it('is case-insensitive about parameter names', () => {
    expect(filenameFromContentDisposition('ATTACHMENT; FileName="x.zip"')).toBe('x.zip');
  });

  it('drops folders from the name', () => {
    expect(filenameFromContentDisposition('attachment; filename="../../etc/passwd"')).toBe(
      'passwd',
    );
    expect(filenameFromContentDisposition('attachment; filename="C:\\\\x\\\\y.zip"')).toBe('y.zip');
  });

  it('is null without a usable name', () => {
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition('')).toBeNull();
    expect(filenameFromContentDisposition('attachment')).toBeNull();
    expect(filenameFromContentDisposition('attachment; filename=""')).toBeNull();
    expect(filenameFromContentDisposition('attachment; filename=".."')).toBeNull();
  });
});

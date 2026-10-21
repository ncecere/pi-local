// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  folderName,
  folderSummary,
  knowledgeFoldersOf,
  knowledgeLinkOf,
} from '../../src/lib/knowledge';

const id = 'ag_abcdefghijklmnop';
const local = `/api/agents/${id}/knowledge/file?path=%2Fdocs%2FQ3%20report.pdf`;

describe('knowledge citation destinations', () => {
  it('recognizes only the scoped local endpoint and decodes a path once', () => {
    expect(knowledgeLinkOf(local)).toEqual({ agentId: id, path: '/docs/Q3 report.pdf' });
    expect(knowledgeLinkOf(`${location.origin}${local}`)).toEqual({
      agentId: id,
      path: '/docs/Q3 report.pdf',
    });
    expect(knowledgeLinkOf(`${local}%252e`)).toEqual({
      agentId: id,
      path: '/docs/Q3 report.pdf%2e',
    });
  });
  it('never turns external, file, malformed or incomplete URLs into system file openings', () => {
    for (const href of [
      `https://example.com${local}`,
      `http://app.invalid${local}`,
      `//app.invalid${local}`,
      'file:///etc/hosts',
      'javascript:alert(1)',
      '/api/agents/not-an-id/knowledge/file?path=/etc/hosts',
      `/api/agents/${id}/knowledge/file`,
      `/api/agents/${id}/knowledge/open?path=/docs/file.pdf`,
      'http://[',
    ])
      expect(knowledgeLinkOf(href), href).toBeNull();
  });
});

it('handles older agents and waiting folders without inventing an index status', () => {
  expect(knowledgeFoldersOf({})).toEqual([]);
  expect(folderName('/docs/contracts/')).toBe('contracts');
  expect(folderName('C:\\Docs\\Contracts')).toBe('Contracts');
  expect(
    folderSummary({
      path: '/docs',
      state: 'waiting',
      files: 0,
      passages: 0,
      problems: 0,
      tooLarge: 0,
      partial: 0,
      truncated: false,
      lastScanAt: null,
    }),
  ).toBe('Waiting to be read…');
});

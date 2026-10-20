import { describe, expect, it } from 'vitest';
import { explainFailure } from '../../src/lib/agent-errors';

describe('explainFailure', () => {
  it('turns the platform passing on a provider rejection into a sentence, keeping the raw text', () => {
    const raw = '400: {"code":"upstream_rejected","message":"The provider rejected the request"}';
    const out = explainFailure(raw);
    expect(out.summary).toMatch(/provider rejected the request/);
    expect(out.detail).toBe(raw);
  });

  it('recognises rate limits, long conversations, timeouts and outages', () => {
    expect(explainFailure('429: Too Many Requests').summary).toMatch(/busy or over its limit/);
    expect(
      explainFailure(
        '400: {"error":{"message":"This model\'s maximum context length is 8192 tokens"}}',
      ).summary,
    ).toMatch(/too long/);
    expect(explainFailure('Request timed out').summary).toMatch(/too long to answer/);
    expect(
      explainFailure('503: {"error":{"type":"overloaded_error","message":"Overloaded"}}').summary,
    ).toMatch(/had a problem/);
    expect(explainFailure('401: {"error":"invalid api key"}').summary).toMatch(/refused access/);
  });

  it('keeps a readable reason it does not recognise, as a sentence', () => {
    expect(explainFailure('The model request failed')).toEqual({
      summary: 'The model request failed.',
      detail: null,
    });
    expect(explainFailure('418: {"code":"teapot","message":"I am a teapot"}')).toEqual({
      summary: 'I am a teapot.',
      detail: '418: {"code":"teapot","message":"I am a teapot"}',
    });
  });

  it('does not show JSON as the sentence', () => {
    const raw = '{"weird":{"nested":true}}';
    expect(explainFailure(raw)).toEqual({ summary: 'The model request failed.', detail: raw });
  });

  it('has something to say when there is no reason', () => {
    expect(explainFailure(undefined).summary).toBe('The reply could not be generated.');
  });
});

import { ApiError } from '~/api/errors';

/**
 * Server-sent events, parsed. The fetch that opens a thread's stream lives in
 * the transport (src/api/transport.ts `stream()`), which hands the body here.
 */
export interface ServerSentEvent {
  event: string;
  data: string;
}

/** Parses an SSE body into events until it ends. */
export async function readEvents(
  body: NonNullable<Response['body']>,
  onEvent: (event: ServerSentEvent) => void,
): Promise<void> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      // Events end with a blank line; normalise CRLF first.
      buffer = buffer.replace(/\r\n?/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseEvent(block);
        if (event) onEvent(event);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseEvent(block: string): ServerSentEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue; // keep-alive comments
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

/** A refusal that reconnecting will not fix. */
export function isFinal(error: unknown): error is ApiError {
  return error instanceof ApiError && [400, 401, 403, 404].includes(error.status);
}

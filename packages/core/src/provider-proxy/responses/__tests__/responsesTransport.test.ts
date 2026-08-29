import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  projectUpstreamResponseHeaders,
  readBody,
  relayResponse,
} from '../../ingress/providerProxyShared';
import { createResponsesAbortScope, ResponsesRequestTimeoutError } from '../responsesAbort';

class MockResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  chunks: Buffer[] = [];

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headers = { ...headers };
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Uint8Array): void {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

const asResponse = (value: MockResponse) => value as unknown as http.ServerResponse;

describe('safe Responses response relay', () => {
  it('preserves actionable headers and strips unsafe or stale metadata', async () => {
    const upstream = new Response(JSON.stringify({ error: { code: 'rate_limit' } }), {
      status: 429,
      headers: {
        'Content-Type': 'application/problem+json',
        'Retry-After': '17',
        'X-Request-Id': 'req_123',
        'OpenAI-Request-Id': 'openai_123',
        'X-RateLimit-Remaining-Requests': '0',
        'OpenAI-Processing-Ms': '42',
        'OpenAI-Version': '2026-08-29',
        'X-Should-Retry': 'true',
        'Set-Cookie': 'session=secret',
        Authorization: 'Bearer secret',
        Connection: 'close',
        'Content-Length': '999',
        'Content-Encoding': 'gzip',
        'X-Vendor-Internal': 'secret-diagnostic',
      },
    });
    const response = new MockResponse();

    await relayResponse(asResponse(response), upstream, true);

    expect(response.statusCode).toBe(429);
    expect(response.headers).toMatchObject({
      'Content-Type': 'application/problem+json',
      'Retry-After': '17',
      'x-request-id': 'req_123',
      'openai-request-id': 'openai_123',
      'x-ratelimit-remaining-requests': '0',
      'openai-processing-ms': '42',
      'openai-version': '2026-08-29',
      'x-should-retry': 'true',
    });
    const names = Object.keys(response.headers).map((name) => name.toLowerCase());
    expect(names).not.toEqual(expect.arrayContaining([
      'set-cookie', 'authorization', 'connection', 'content-length', 'content-encoding', 'x-vendor-internal',
    ]));
  });

  it('preserves SSE bytes, mixed framing, comments, malformed data, and unknown terminal events', async () => {
    const fixture = [
      ': keep-alive\r\n',
      'event: response.future\r\n',
      'data: {not-json}\r\n',
      '\r\n',
      'event: response.incomplete\n',
      'data: {"type":"response.incomplete","future":{"x":1}}\n',
      '\n',
      'event: error\r\n',
      'data: {"type":"error","code":"future"}\r\n',
      '\r\n',
    ].join('');
    const bytes = new TextEncoder().encode(fixture);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 3) {
          controller.enqueue(bytes.slice(index, index + 3));
        }
        controller.close();
      },
    });
    const upstream = new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-transform' },
    });
    const response = new MockResponse();
    const events: Array<Record<string, unknown>> = [];

    await relayResponse(asResponse(response), upstream, true, undefined, undefined, (event) => events.push(event));

    expect(response.body).toBe(fixture);
    expect(events.map((event) => event.type)).toEqual(['response.incomplete', 'error']);
    expect(response.headers['Cache-Control']).toBe('private, no-transform');
  });

  it('cancels and releases the active upstream reader when aborted', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new MockResponse();
    const controller = new AbortController();
    const pending = relayResponse(
      asResponse(response),
      new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
      true,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    await pending;
    expect(cancelled).toBe(true);
    expect(response.writableEnded).toBe(true);
  });

  it('projects only the documented SSE cache metadata', () => {
    expect(projectUpstreamResponseHeaders(new Headers({
      'Cache-Control': 'no-store',
      ETag: 'secret-tag',
    }), true)).toEqual({ 'Cache-Control': 'no-store' });
  });
});

describe('Responses request abort lifecycle', () => {
  afterEach(() => vi.useRealTimers());

  it('aborts body reading and removes every request/signal listener', async () => {
    const request = new PassThrough() as unknown as http.IncomingMessage;
    const controller = new AbortController();
    const pending = readBody(request, controller.signal);
    request.emit('data', Buffer.from('{"partial":'));
    controller.abort(new Error('client disconnected'));
    await expect(pending).rejects.toThrow('client disconnected');
    for (const event of ['data', 'end', 'error', 'aborted', 'close']) {
      expect(request.listenerCount(event)).toBe(0);
    }
  });

  it('uses one timeout signal and disposes timers and close listeners', async () => {
    vi.useFakeTimers();
    const request = Object.assign(new EventEmitter(), { aborted: false, complete: false }) as unknown as http.IncomingMessage;
    const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false }) as unknown as http.ServerResponse;
    const scope = createResponsesAbortScope({ request, response, timeoutMs: 25 });
    vi.advanceTimersByTime(25);
    expect(scope.timedOut).toBe(true);
    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBeInstanceOf(ResponsesRequestTimeoutError);
    scope.dispose();
    expect(request.listenerCount('aborted')).toBe(0);
    expect(request.listenerCount('close')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not treat a replay request close with unavailable completion metadata as a disconnect', () => {
    const request = new EventEmitter() as unknown as http.IncomingMessage;
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    }) as unknown as http.ServerResponse;
    const scope = createResponsesAbortScope({ request, response });

    request.emit('close');

    expect(scope.signal.aborted).toBe(false);
    scope.dispose();
  });
});

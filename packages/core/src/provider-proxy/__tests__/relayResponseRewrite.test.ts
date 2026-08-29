/**
 * relayResponse `rewriteModel` passthrough tests (omnicross-mkm-serving, design
 * D4). When `rewriteModel` is set the response `model` is rewritten to the
 * client's ORIGINAL id — top-level + nested `response.model` for non-stream JSON,
 * and the FIRST model-bearing SSE event for streams (Anthropic `message_start`,
 * Responses `response.created/in_progress/completed`) — while framing is
 * preserved and the RETURNED body (usage tap) stays the UPSTREAM text. When
 * unset the relay is byte-identical to before.
 */
import type http from 'node:http';

import { describe, expect, it } from 'vitest';

import { relayResponse } from '../ingress/providerProxyShared';

/** Captures everything written to an http.ServerResponse. */
class MockRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  headersSent = false;
  ended = false;
  private chunks: Buffer[] = [];
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }
  write(chunk: Uint8Array | string): boolean {
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
    return true;
  }
  end(chunk?: Uint8Array | string): void {
    if (chunk) this.write(chunk);
    this.ended = true;
  }
  get body(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build an SSE Response whose bytes are split at the given byte offsets. */
function sseResponse(fullText: string, splitAt: number[]): Response {
  const bytes = new TextEncoder().encode(fullText);
  const parts: Uint8Array[] = [];
  let prev = 0;
  for (const idx of splitAt) {
    parts.push(bytes.slice(prev, idx));
    prev = idx;
  }
  parts.push(bytes.slice(prev));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const asRes = (m: MockRes) => m as unknown as http.ServerResponse;

describe('relayResponse — failed upstream is relayed as an error, not as an empty stream', () => {
  it('a JSON error body is NOT stamped text/event-stream even when the client streams', async () => {
    // Regression: forcing the SSE content-type onto an error body made codex
    // read zero events and report "stream closed before response.completed"
    // instead of the upstream 400.
    const errorBody = JSON.stringify({ error: { code: '1214', message: 'content[0].type type error' } });
    const resp = new Response(errorBody, {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
    const mock = new MockRes();

    const returned = await relayResponse(asRes(mock), resp, /* isStream */ true);

    expect(mock.statusCode, 'the upstream status must survive').toBe(400);
    expect(mock.headers['Content-Type']).toContain('application/json');
    expect(mock.body).toBe(errorBody);
    expect(returned).toBe(errorBody);
  });

  it('an explicit successful JSON response keeps its content type when the client requested streaming', async () => {
    const jsonBody = JSON.stringify({ id: 'resp_json_fallback', status: 'completed', output: [] });
    const resp = new Response(jsonBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    const mock = new MockRes();

    const returned = await relayResponse(asRes(mock), resp, /* isStream */ true);

    expect(mock.statusCode).toBe(200);
    expect(mock.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(mock.body).toBe(jsonBody);
    expect(returned).toBe(jsonBody);
  });

  it('a genuine SSE body still streams at a non-2xx status', async () => {
    const sse = 'data: {"type":"response.failed"}\n\n';
    const resp = new Response(sse, {
      status: 429,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const mock = new MockRes();

    await relayResponse(asRes(mock), resp, /* isStream */ true);

    expect(mock.statusCode).toBe(429);
    expect(mock.headers['Content-Type']).toContain('text/event-stream');
    expect(mock.body).toBe(sse);
  });

  it('a 200 stream WITHOUT a Content-Type header still streams (codex backend omits it)', async () => {
    const sse = 'data: {"type":"response.created"}\n\n';
    const resp = new Response(sse, { status: 200 });
    resp.headers.delete('Content-Type');
    const mock = new MockRes();

    await relayResponse(asRes(mock), resp, /* isStream */ true);

    expect(mock.headers['Content-Type']).toContain('text/event-stream');
    expect(mock.body).toBe(sse);
  });
});

describe('relayResponse — non-stream JSON model rewrite', () => {
  it('Anthropic top-level model → client id; returned body stays upstream', async () => {
    const upstream = { type: 'message', model: 'provider-real-model', usage: { input_tokens: 3, output_tokens: 5 } };
    const res = new MockRes();
    const returned = await relayResponse(asRes(res), jsonResponse(upstream), false, 'claude-opus-4-8');
    // Client sees the rewritten (original requested) id.
    expect(JSON.parse(res.body).model).toBe('claude-opus-4-8');
    // Usage tap gets the UPSTREAM body (real model preserved for accounting).
    expect(returned).not.toBeNull();
    expect(JSON.parse(returned as string).model).toBe('provider-real-model');
    // Token counts untouched by the rewrite.
    expect(JSON.parse(res.body).usage.input_tokens).toBe(3);
  });

  it('Responses top-level + nested response.model both rewritten', async () => {
    const upstream = { id: 'r1', model: 'up', response: { id: 'r1', model: 'up' } };
    const res = new MockRes();
    await relayResponse(asRes(res), jsonResponse(upstream), false, 'gpt-5-codex');
    const parsed = JSON.parse(res.body);
    expect(parsed.model).toBe('gpt-5-codex');
    expect(parsed.response.model).toBe('gpt-5-codex');
  });

  it('rewriteModel undefined → byte-identical body + returned', async () => {
    const upstreamText = JSON.stringify({ model: 'up', foo: 1 });
    const resp = new Response(upstreamText, { status: 200, headers: { 'Content-Type': 'application/json' } });
    const res = new MockRes();
    const returned = await relayResponse(asRes(res), resp, false);
    expect(res.body).toBe(upstreamText);
    expect(returned).toBe(upstreamText);
  });

  it('non-JSON body is not corrupted when rewriteModel set', async () => {
    const resp = new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const res = new MockRes();
    await relayResponse(asRes(res), resp, false, 'x');
    expect(res.body).toBe('not json');
  });
});

describe('relayResponse — SSE model rewrite (framing preserved, split chunks)', () => {
  it('Anthropic message_start.message.model rewritten, rest verbatim', async () => {
    const sse =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"m","model":"provider-real-model"}}\n' +
      '\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","delta":{"text":"hi"}}\n' +
      '\n';
    // Split mid the first data JSON + at a couple of other byte offsets.
    const mid = sse.indexOf('"model"');
    const res = new MockRes();
    await relayResponse(asRes(res), sseResponse(sse, [12, mid, mid + 6]), true, 'claude-opus-4-8');
    // Exactly the model swapped; all other framing byte-identical.
    expect(res.body).toBe(sse.replace('provider-real-model', 'claude-opus-4-8'));
  });

  it('Responses rewrites EVERY model-bearing event (created + in_progress + completed)', async () => {
    const sse =
      'event: response.created\n' +
      'data: {"type":"response.created","response":{"id":"r","model":"up"}}\n' +
      '\n' +
      'event: response.in_progress\n' +
      'data: {"type":"response.in_progress","response":{"id":"r","model":"up"}}\n' +
      '\n' +
      'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"r","model":"up"}}\n' +
      '\n';
    const res = new MockRes();
    await relayResponse(asRes(res), sseResponse(sse, [5, 40, 130]), true, 'gpt-5-codex');
    // ALL three model-bearing events rewritten (no first-hit short-circuit that
    // would leak the upstream name in `in_progress`/`completed`).
    expect(res.body).toBe(sse.replaceAll('"model":"up"', '"model":"gpt-5-codex"'));
    expect(res.body).not.toContain('"model":"up"');
  });

  it('Responses terminal response.failed event → response.model rewritten (no upstream leak)', async () => {
    // A failed/truncated Codex stream: created then a terminal `response.failed`,
    // each carrying response.model — both must read back the client id.
    const sse =
      'event: response.created\n' +
      'data: {"type":"response.created","response":{"id":"r","model":"up"}}\n' +
      '\n' +
      'event: response.failed\n' +
      'data: {"type":"response.failed","response":{"id":"r","model":"up","error":{"message":"boom"}}}\n' +
      '\n';
    const res = new MockRes();
    await relayResponse(asRes(res), sseResponse(sse, [5, 60]), true, 'gpt-5-codex');
    expect(res.body).toBe(sse.replaceAll('"model":"up"', '"model":"gpt-5-codex"'));
    expect(res.body).not.toContain('"model":"up"');
    // Framing + the non-model `error` field preserved verbatim.
    expect(res.body).toContain('event: response.failed\n');
    expect(res.body).toContain('"error":{"message":"boom"}');
  });

  it('Responses terminal response.incomplete event → response.model rewritten', async () => {
    const sse =
      'event: response.incomplete\n' +
      'data: {"type":"response.incomplete","response":{"id":"r","model":"up"}}\n' +
      '\n';
    const res = new MockRes();
    await relayResponse(asRes(res), sseResponse(sse, [8]), true, 'gpt-5-codex');
    expect(res.body).toBe(sse.replace('"model":"up"', '"model":"gpt-5-codex"'));
  });

  it('terminal model-bearing event WITHOUT a trailing newline is still rewritten', async () => {
    // No trailing '\n' after the final data line (terminal-line gap).
    const sse =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"model":"up"}}';
    const res = new MockRes();
    await relayResponse(asRes(res), sseResponse(sse, [10]), true, 'claude-opus-4-8');
    expect(res.body).toBe(sse.replace('"model":"up"', '"model":"claude-opus-4-8"'));
  });

  it('SSE with rewriteModel undefined → byte-identical passthrough', async () => {
    const sse =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"model":"up"}}\n' +
      '\n';
    const res = new MockRes();
    await relayResponse(asRes(res), sseResponse(sse, [10]), true);
    expect(res.body).toBe(sse);
  });

  it('[DONE] sentinel + non-model events pass through untouched', async () => {
    const sse =
      'data: {"type":"ping"}\n' +
      '\n' +
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"model":"up"}}\n' +
      '\n' +
      'data: [DONE]\n' +
      '\n';
    const res = new MockRes();
    await relayResponse(asRes(res), sseResponse(sse, [3, 25]), true, 'claude-opus-4-8');
    expect(res.body).toBe(sse.replace('"model":"up"', '"model":"claude-opus-4-8"'));
  });
});

describe('relayResponse — streaming usage tap (usageTap)', () => {
  it('fires onUsage once with the terminal response.completed usage; body relayed verbatim', async () => {
    const sse =
      'data: {"type":"response.created","response":{"id":"r","status":"in_progress"}}\n\n' +
      'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n' +
      'data: {"type":"response.completed","response":{"id":"r","status":"completed","usage":{"input_tokens":10,"output_tokens":3}}}\n\n';
    const seen: string[] = [];
    const captured: Record<string, unknown>[] = [];
    const tap = {
      extractUsage(event: Record<string, unknown>): Record<string, unknown> | null | undefined {
        seen.push(event['type'] as string);
        if (event['type'] === 'response.completed') {
          return (event['response'] as Record<string, unknown>)['usage'] as Record<string, unknown>;
        }
        return null;
      },
      onUsage(rawUsage: Record<string, unknown>): void {
        captured.push(rawUsage);
      },
    };
    const res = new MockRes();
    const returned = await relayResponse(asRes(res), sseResponse(sse, [12, 80]), true, undefined, tap);
    // Streaming relay → null body (no buffered text); SSE bytes pass through unchanged.
    expect(returned).toBeNull();
    expect(res.body).toBe(sse);
    // extractUsage saw every data event (split chunks rejoined).
    expect(seen).toEqual(['response.created', 'response.output_text.delta', 'response.completed']);
    // onUsage fired EXACTLY once, with the captured usage object.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ input_tokens: 10, output_tokens: 3 });
  });

  it('keeps the LAST non-null usage when several events carry one', async () => {
    const sse = 'data: {"usage":{"prompt_tokens":1}}\n\n' + 'data: {"usage":{"prompt_tokens":2}}\n\n';
    let captured: Record<string, unknown> | undefined;
    const tap = {
      extractUsage(e: Record<string, unknown>) {
        return e['usage'] as Record<string, unknown> | undefined;
      },
      onUsage(u: Record<string, unknown>) {
        captured = u;
      },
    };
    const res = new MockRes();
    await relayResponse(asRes(res), sseResponse(sse, [22]), true, undefined, tap);
    expect(captured).toEqual({ prompt_tokens: 2 });
  });

  it('composes with model rewrite — usage tapped from the pre-rewrite line', async () => {
    const sse =
      'data: {"type":"response.completed","response":{"id":"r","model":"up","usage":{"input_tokens":7,"output_tokens":4}}}\n\n';
    let captured: Record<string, unknown> | undefined;
    const tap = {
      extractUsage(e: Record<string, unknown>) {
        if (e['type'] === 'response.completed') {
          return (e['response'] as Record<string, unknown>)['usage'] as Record<string, unknown>;
        }
        return null;
      },
      onUsage(u: Record<string, unknown>) {
        captured = u;
      },
    };
    const res = new MockRes();
    await relayResponse(asRes(res), sseResponse(sse, [10]), true, 'gpt-5-codex', tap);
    // Model rewritten for the client…
    expect(res.body).toContain('"model":"gpt-5-codex"');
    expect(res.body).not.toContain('"model":"up"');
    // …while usage is still captured (model rewrite never touches usage).
    expect(captured).toEqual({ input_tokens: 7, output_tokens: 4 });
  });

  it('no usage in any event + [DONE] sentinel → onUsage never called, body verbatim', async () => {
    const sse = 'data: {"type":"ping"}\n\ndata: [DONE]\n\n';
    let called = false;
    const tap = {
      extractUsage() {
        return null;
      },
      onUsage() {
        called = true;
      },
    };
    const res = new MockRes();
    await relayResponse(asRes(res), sseResponse(sse, [3]), true, undefined, tap);
    expect(called).toBe(false);
    expect(res.body).toBe(sse);
  });
});

describe('relayResponse — onSseEvent observes every SSE event without altering bytes', () => {
  it('delivers a response.failed overload event to the read-only observer', async () => {
    const sse = [
      `data: ${JSON.stringify({ type: 'response.created', response: { id: 'r1', model: 'gpt-5-codex' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: 'server_is_overloaded', message: 'capacity' } } })}\n\n`,
    ].join('');
    const seen: Array<Record<string, unknown>> = [];
    const res = new MockRes();
    await relayResponse(asRes(res), sseResponse(sse, []), true, undefined, undefined, (event) => {
      seen.push(event);
    });
    expect(seen.map((e) => e['type'])).toEqual(['response.created', 'response.failed']);
    // Byte-identical relay: the read-only side channel never altered the output.
    expect(res.body).toBe(sse);
  });
});

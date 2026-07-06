import { createHmac } from 'node:crypto';

import type { WebhookConfig, WebhookEvent } from '@omnicross/contracts/webhook-types';
import type { Logger } from '@omnicross/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildRequest,
  WebhookDispatcher,
  type WebhookFetch,
} from '../webhook/WebhookDispatcher';

/** A capturing logger stub. */
function makeLogger(): Logger & { warns: string[]; debugs: string[] } {
  const warns: string[] = [];
  const debugs: string[] = [];
  return {
    warns,
    debugs,
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: () => {},
    debug: (m: string) => debugs.push(m),
  } as unknown as Logger & { warns: string[]; debugs: string[] };
}

/** A record of one captured POST. */
interface Sent {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** An okay `Response` stand-in. */
const okRes = (status = 200): Response => ({ ok: status >= 200 && status < 300, status }) as Response;

const instantSleep = (): Promise<void> => Promise.resolve();

function makeConfig(destinations: WebhookConfig['destinations']): WebhookConfig {
  return { enabled: true, destinations };
}

/** Flush pending microtasks/timers so the async drain settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

afterEach(() => vi.restoreAllMocks());

describe('WebhookDispatcher — fire-and-forget', () => {
  it('emit returns BEFORE a slow send resolves (never blocks the caller)', async () => {
    let sendFinished = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl: WebhookFetch = async () => {
      await gate;
      sendFinished = true;
      return okRes();
    };
    const d = new WebhookDispatcher({ fetchImpl, sleep: instantSleep });
    d.setConfig(makeConfig([{ id: 'a', type: 'custom', url: 'https://x', enabled: true }]));

    d.emit({ kind: 'test', at: 1 });
    // Synchronously after emit: the send cannot have completed.
    expect(sendFinished).toBe(false);

    release();
    await flush();
    expect(sendFinished).toBe(true);
  });

  it('a THROWING destination never throws out of emit and never blocks', async () => {
    const fetchImpl: WebhookFetch = () => {
      throw new Error('sync boom');
    };
    const d = new WebhookDispatcher({ fetchImpl, sleep: instantSleep, maxAttempts: 1 });
    d.setConfig(makeConfig([{ id: 'a', type: 'custom', url: 'https://x', enabled: true }]));
    expect(() => d.emit({ kind: 'test', at: 1 })).not.toThrow();
    await flush();
  });
});

describe('WebhookDispatcher — matching + concurrency', () => {
  it('only enabled destinations whose filter admits the kind receive it', async () => {
    const sent: Sent[] = [];
    const fetchImpl: WebhookFetch = async (url, init) => {
      sent.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
      return okRes();
    };
    const d = new WebhookDispatcher({ fetchImpl, sleep: instantSleep });
    d.setConfig(
      makeConfig([
        { id: 'all', type: 'custom', url: 'https://all', enabled: true },
        { id: 'errors-only', type: 'custom', url: 'https://err', enabled: true, events: ['server.error'] },
        { id: 'disabled', type: 'custom', url: 'https://off', enabled: false },
      ]),
    );
    d.emit({ kind: 'test', at: 1 });
    await flush();
    expect(sent.map((s) => s.url).sort()).toEqual(['https://all']);

    sent.length = 0;
    d.emit({ kind: 'server.error', at: 2, message: 'x' });
    await flush();
    expect(sent.map((s) => s.url).sort()).toEqual(['https://all', 'https://err']);
  });

  it('sends to multiple destinations concurrently', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl: WebhookFetch = async (url) => {
      started.push(url);
      await gate;
      return okRes();
    };
    const d = new WebhookDispatcher({ fetchImpl, sleep: instantSleep });
    d.setConfig(
      makeConfig([
        { id: 'a', type: 'custom', url: 'https://a', enabled: true },
        { id: 'b', type: 'custom', url: 'https://b', enabled: true },
      ]),
    );
    d.emit({ kind: 'test', at: 1 });
    await flush();
    // BOTH sends started before either resolved (concurrent, not serial).
    expect(started.sort()).toEqual(['https://a', 'https://b']);
    release();
    await flush();
  });
});

describe('WebhookDispatcher — retry then drop', () => {
  it('retries up to maxAttempts then logs + drops', async () => {
    let calls = 0;
    const fetchImpl: WebhookFetch = async () => {
      calls++;
      return okRes(500); // non-ok every time
    };
    const logger = makeLogger();
    const d = new WebhookDispatcher({ fetchImpl, sleep: instantSleep, maxAttempts: 3, logger });
    d.setConfig(makeConfig([{ id: 'a', type: 'custom', url: 'https://x', enabled: true }]));
    d.emit({ kind: 'test', at: 1 });
    await flush();
    expect(calls).toBe(3);
    expect(logger.warns.some((w) => w.includes('dropped') && w.includes('after 3 attempts'))).toBe(true);
  });
});

describe('WebhookDispatcher — bounded queue drop-oldest', () => {
  it('drops the OLDEST when the queue is full + warns once', async () => {
    const sent: WebhookEvent[] = [];
    const fetchImpl: WebhookFetch = async (_url, init) => {
      sent.push(JSON.parse(String(init.body)) as WebhookEvent);
      return okRes();
    };
    const logger = makeLogger();
    const d = new WebhookDispatcher({ fetchImpl, sleep: instantSleep, queueMax: 2, logger });
    d.setConfig(makeConfig([{ id: 'a', type: 'custom', url: 'https://x', enabled: true }]));
    // 5 synchronous emits; queueMax 2 ⇒ only the last two survive to drain.
    for (let i = 1; i <= 5; i++) d.emit({ kind: 'server.error', at: i, message: `m${i}` });
    await flush();
    expect(sent.map((e) => e.at)).toEqual([4, 5]);
    expect(logger.warns.some((w) => w.includes('queue full'))).toBe(true);
  });
});

describe('WebhookDispatcher — signing (custom + feishu)', () => {
  const secret = 'shhh';

  it('custom: body is the event JSON + HMAC-SHA256 hex signature header', () => {
    const event: WebhookEvent = { kind: 'test', at: 42 };
    const { body, headers } = buildRequest(event, { id: 'a', type: 'custom', url: 'https://x', secret, enabled: true }, 0);
    expect(JSON.parse(body)).toEqual(event);
    const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(headers['X-Omnicross-Signature']).toBe(expected);
    // The secret itself NEVER appears in the payload.
    expect(body).not.toContain(secret);
  });

  it('custom: no signature header without a secret', () => {
    const { headers } = buildRequest({ kind: 'test', at: 1 }, { id: 'a', type: 'custom', url: 'https://x', enabled: true }, 0);
    expect(headers['X-Omnicross-Signature']).toBeUndefined();
  });

  it('feishu: envelope carries timestamp + sign (HMAC-SHA256 base64 of `timestamp\\nsecret`)', () => {
    const nowMs = 1_700_000_000_000;
    const { body } = buildRequest({ kind: 'test', at: 1 }, { id: 'f', type: 'feishu', url: 'https://x', secret, enabled: true }, nowMs);
    const parsed = JSON.parse(body) as { msg_type: string; timestamp: string; sign: string };
    const timestamp = Math.floor(nowMs / 1000).toString();
    expect(parsed.msg_type).toBe('text');
    expect(parsed.timestamp).toBe(timestamp);
    const expectedSign = createHmac('sha256', `${timestamp}\n${secret}`).digest('base64');
    expect(parsed.sign).toBe(expectedSign);
    // The secret NEVER appears in the payload.
    expect(body).not.toContain(secret);
  });
});

describe('WebhookDispatcher — deliverTest (admin path)', () => {
  it('delivers a test event to a destination by id and returns the outcome', async () => {
    const sent: Sent[] = [];
    const fetchImpl: WebhookFetch = async (url, init) => {
      sent.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
      return okRes(204);
    };
    const d = new WebhookDispatcher({ fetchImpl, now: () => 7 });
    d.setConfig(makeConfig([{ id: 'a', type: 'custom', url: 'https://x', enabled: true }]));
    const result = await d.deliverTest('a');
    expect(result).toEqual({ ok: true, status: 204 });
    expect(JSON.parse(sent[0].body)).toEqual({ kind: 'test', at: 7 });
  });

  it('returns not-found for an unknown destination', async () => {
    const d = new WebhookDispatcher({ fetchImpl: async () => okRes() });
    d.setConfig(makeConfig([]));
    expect(await d.deliverTest('nope')).toEqual({ ok: false, error: 'destination not found' });
  });
});

describe('WebhookDispatcher — inert when disabled', () => {
  it('a disabled config sends nothing', async () => {
    const fetchImpl = vi.fn(async () => okRes());
    const d = new WebhookDispatcher({ fetchImpl });
    d.setConfig({ enabled: false, destinations: [{ id: 'a', type: 'custom', url: 'https://x', enabled: true }] });
    d.emit({ kind: 'test', at: 1 });
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/**
 * Anthropic `/v1/messages` DOWNSTREAM-CANCELLATION tests.
 *
 * The Codex Responses ingress threads one abort scope (request disconnect +
 * response close) through its upstream fetch, aggregation and SSE relay; the
 * built-in Anthropic ingress historically did not. A Claude Code client that
 * hangs up mid-stream therefore left the UPSTREAM request running to
 * completion — an orphan socket held open through whatever egress proxy the
 * route resolved, for as long as the upstream kept generating.
 *
 * These tests drive the REAL seam (a `ProviderProxy` with no
 * `anthropicIngressHandlerFactory` + a real `node:http` mock upstream, no
 * mocked fetch) and assert on what the UPSTREAM observes:
 *
 *   1. downstream disconnect mid-stream ⇒ the upstream response is closed
 *      before it finished writing — on BOTH relay shapes (the raw byte pipe
 *      and the line-based relay that a usage tap forces).
 *   2. a response DISCARDED by the 401-refresh retry is cancelled, not leaked.
 *   3. an undisturbed stream still relays every event to completion (the
 *      cancellation must not truncate a healthy stream).
 *
 * @module provider-proxy/__tests__/ProviderProxy.anthropicCancellation.test
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConfigSource } from '../../ports';
import { setSubscriptionRegistryForOutbound } from '../../outbound-api/subscriptionRegistryPort';
import type { AuthStrategy } from '../../pipeline/SubscriptionAuthStrategy';
import { ProviderProxy } from '../ProviderProxy';
import type { ProviderProxyDeps, RouteContext, SubscriptionDispatchProfile } from '../types';

// ── Streaming mock upstream ───────────────────────────────────────────────────

interface StreamingUpstream {
  server: Server;
  port: number;
  hits: number;
  /** Per hit (in order): did the socket close BEFORE the upstream finished writing? */
  abortedByHit: boolean[];
  /** Per hit (in order): how many `content_block_delta` events were written. */
  eventsByHit: number[];
  /** Hits that reply 401 with a body that is opened and then NEVER ended. */
  failFirstNWithOpenBody: number;
  /** When true, a hit is accepted and NEVER answered (headers included). */
  hangWithoutResponding: boolean;
  /** `'forever'` streams until cancelled; a number ends the stream after N deltas. */
  sseEvents: number | 'forever';
  /**
   * Ordered log of `hit:<n>` (request received) and `abort:<n>` (that hit's
   * response socket closed while still writable). Ordering is the deterministic
   * observable: a LEAKED body is also reclaimed eventually — by the GC finalizer,
   * at an arbitrary later moment — so a timing-only assertion passes or fails
   * with test order. "Released BEFORE the replacement attempt was issued" cannot
   * be produced by a finalizer.
   */
  timeline: string[];
  stop(): Promise<void>;
}

const SSE_TICK_MS = 15;

function startStreamingUpstream(): Promise<StreamingUpstream> {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setInterval>>();
  const state = {
    server: undefined as unknown as Server,
    port: 0,
    hits: 0,
    abortedByHit: [] as boolean[],
    eventsByHit: [] as number[],
    failFirstNWithOpenBody: 0,
    hangWithoutResponding: false,
    sseEvents: 'forever' as number | 'forever',
    timeline: [] as string[],
  } as StreamingUpstream;

  const server = createServer((req, res) => {
    let body = '';
    req.on('error', () => undefined);
    req.on('data', (c) => (body += String(c)));
    req.on('end', () => {
      const hit = state.hits;
      state.hits += 1;
      state.abortedByHit[hit] = false;
      state.eventsByHit[hit] = 0;
      state.timeline.push(`hit:${String(hit)}`);

      let timer: ReturnType<typeof setInterval> | undefined;
      const stop = (): void => {
        if (!timer) return;
        clearInterval(timer);
        timers.delete(timer);
        timer = undefined;
      };
      const arm = (tick: () => void): void => {
        timer = setInterval(tick, SSE_TICK_MS);
        timers.add(timer);
        timer.unref?.();
      };
      // The proxy hanging up (or cancelling a discarded body) closes the socket
      // while this response is still writable — that is the observable under test.
      res.on('close', () => {
        if (!res.writableEnded) {
          state.abortedByHit[hit] = true;
          state.timeline.push(`abort:${String(hit)}`);
        }
        stop();
      });
      res.on('error', () => stop());

      if (state.hangWithoutResponding) return; // never writes headers

      if (state.failFirstNWithOpenBody > 0) {
        state.failFirstNWithOpenBody -= 1;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        // Headers + a first chunk resolve the proxy's `fetch`; the body is then
        // held open, so a LEAKED (never-cancelled) response keeps this alive.
        res.write('{"error":{"type":"authentication_error","message":"');
        arm(() => {
          if (res.destroyed || res.writableEnded) return stop();
          res.write('x'.repeat(256));
        });
        return;
      }

      let isStream = false;
      try {
        isStream = (JSON.parse(body) as { stream?: unknown }).stream === true;
      } catch {
        isStream = false;
      }

      if (!isStream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            model: 'mock-model',
            content: [{ type: 'text', text: 'pong' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 7, output_tokens: 4 },
          }),
        );
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[],"usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
      );
      res.write(
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      );
      arm(() => {
        if (res.destroyed || res.writableEnded) return stop();
        const written = state.eventsByHit[hit];
        if (state.sseEvents !== 'forever' && written >= state.sseEvents) {
          stop();
          res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
          res.write(
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
          );
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          res.end();
          return;
        }
        state.eventsByHit[hit] = written + 1;
        res.write(
          `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"tok${String(written)}"}}\n\n`,
        );
      });
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  state.server = server;
  state.stop = () =>
    new Promise<void>((resolve) => {
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close(() => resolve());
    });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = (server.address() as AddressInfo).port;
      resolve(state);
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

/** Open a raw streaming client request; resolves once the FIRST body byte lands. */
function openStreamingClient(
  url: string,
  token: string,
  body: unknown,
): Promise<{ destroy: () => void; res: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      },
      (res) => {
        res.once('data', () => resolve({ destroy: () => req.destroy(), res }));
        res.on('error', () => undefined);
      },
    );
    req.on('error', () => undefined);
    const bail = setTimeout(() => reject(new Error('client stream never produced a first chunk')), 4000);
    bail.unref?.();
    req.end(JSON.stringify(body));
  });
}

const CLAUDE_OAUTH = 'fake-claude-oauth';
const CLAUDE_OAUTH_REFRESHED = 'fake-claude-oauth-2';

function makeClaudeStrategy(): AuthStrategy {
  let refreshed = false;
  return {
    kind: 'pass-through',
    providerId: 'claude',
    async applyHeaders(headers, hints) {
      headers['Authorization'] = `Bearer ${refreshed ? CLAUDE_OAUTH_REFRESHED : CLAUDE_OAUTH}`;
      hints?.reportSelection?.('account-a', true);
    },
    async onUnauthorized() {
      refreshed = true;
      return true;
    },
    async describeStatus() {
      return { providerId: 'claude', ok: true };
    },
  } as AuthStrategy;
}

function claudeProfile(upstreamUrl: string): SubscriptionDispatchProfile {
  return {
    providerId: 'claude',
    displayName: 'Claude',
    authStrategy: makeClaudeStrategy(),
    mode: 'pass-through',
    resolveUpstreamUrl: () => upstreamUrl,
    providerTransformerNames: ['anthropic'],
    modelTransformerNames: [],
  };
}

function makeLlmConfig(): ProviderConfigSource {
  return {
    getProvider: vi.fn(async () => null),
    resolveTransformerChain: vi.fn(async () => ({ providerTransformers: [], modelTransformers: [] })),
    getMainTransformer: vi.fn(async () => null),
    getTransformerService: () => ({ getTransformer: () => undefined }),
  } as unknown as ProviderConfigSource;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Anthropic /v1/messages downstream cancellation', () => {
  let proxy: ProviderProxy;
  let baseUrl: string;
  let upstream: StreamingUpstream;

  async function startProxy(extra: Partial<ProviderProxyDeps> = {}): Promise<void> {
    proxy = new ProviderProxy({ llmConfig: makeLlmConfig(), ...extra });
    const port = await proxy.start();
    baseUrl = `http://127.0.0.1:${port}`;
  }

  beforeEach(async () => {
    setSubscriptionRegistryForOutbound(null);
    upstream = await startStreamingUpstream();
  });

  afterEach(async () => {
    await proxy.stop();
    await upstream.stop();
    setSubscriptionRegistryForOutbound(null);
  });

  function subRoute(profile: SubscriptionDispatchProfile): RouteContext {
    return {
      sessionId: 'sess-cancel',
      targetProviderFormat: 'transform',
      model: 'claude-sonnet-4-5',
      ingressFormat: 'anthropic-messages',
      authMode: 'subscription',
      providerId: profile.providerId,
      subscriptionProfile: profile,
    };
  }

  function upstreamUrl(path: string): string {
    return `http://127.0.0.1:${upstream.port}${path}`;
  }

  const streamBody = {
    model: 'cli',
    max_tokens: 64,
    stream: true,
    messages: [{ role: 'user', content: 'ping' }],
  };

  it('cancels the upstream stream when the client hangs up (raw byte pipe relay)', async () => {
    await startProxy();
    const token = proxy.addRoute(subRoute(claudeProfile(upstreamUrl('/v1/messages'))));

    const client = await openStreamingClient(`${baseUrl}/v1/messages`, token, streamBody);
    expect(upstream.hits).toBe(1);
    client.destroy();

    expect(await waitFor(() => upstream.abortedByHit[0] === true)).toBe(true);
  }, 20_000);

  it('cancels the upstream stream when the client hangs up (line-based relay with usage tap)', async () => {
    await startProxy({
      usageRecorder: { record: () => undefined } as unknown as ProviderProxyDeps['usageRecorder'],
    });
    const token = proxy.addRoute(subRoute(claudeProfile(upstreamUrl('/v1/messages'))));

    const client = await openStreamingClient(`${baseUrl}/v1/messages`, token, streamBody);
    expect(upstream.hits).toBe(1);
    client.destroy();

    expect(await waitFor(() => upstream.abortedByHit[0] === true)).toBe(true);
  }, 20_000);

  it('releases the 401 response BEFORE issuing the refresh retry', async () => {
    await startProxy();
    upstream.failFirstNWithOpenBody = 1;
    const token = proxy.addRoute(subRoute(claudeProfile(upstreamUrl('/v1/messages'))));

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(upstream.hits).toBe(2);
    // The discarded 401 body is cancelled as part of the retry decision, so its
    // release is ordered before the retry lands upstream. Leaking it instead
    // yields `['hit:0', 'hit:1']` (with `abort:0` arriving late, if at all).
    expect(upstream.timeline).toEqual(['hit:0', 'abort:0', 'hit:1']);
  }, 20_000);

  it('does not march the fallback chain after the client hangs up', async () => {
    await startProxy();
    // The upstream accepts the request and never answers, so the ONLY way this
    // attempt can settle is the client hanging up — which reaches the fallback
    // loop as a THROWN (and therefore fallback-eligible) outcome.
    upstream.hangWithoutResponding = true;
    const chain = [{ modelId: 'fb-1' }, { modelId: 'fb-2' }];
    const nextFallback = vi.fn((_scenario: unknown, attempted: readonly string[]) =>
      chain.find((e) => !attempted.includes(e.modelId)) ?? null,
    );
    const recordModelOutcome = vi.fn();
    const profile = {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeClaudeStrategy(),
      mode: 'transformer',
      resolveUpstreamUrl: () => upstreamUrl('/v1/messages'),
      providerTransformerNames: ['openai'],
      modelMapper: () => ({ resolvedModel: 'minimax-m2.5', scenario: 'long_context' }),
      nextFallback,
      recordModelOutcome,
    } as unknown as SubscriptionDispatchProfile;
    const token = proxy.addRoute(subRoute(profile));

    const target = new URL(`${baseUrl}/v1/messages`);
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    req.on('error', () => undefined);
    req.end(JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }));

    expect(await waitFor(() => upstream.hits === 1)).toBe(true);
    req.destroy();
    // The hang-up actually reached the upstream (not merely a still-pending fetch).
    expect(await waitFor(() => upstream.timeline.includes('abort:0'))).toBe(true);
    // Give the chain ample room to march if the guard is missing.
    await new Promise((r) => setTimeout(r, 400));

    // Asserted on the CHAIN, not on upstream hits: each post-abort attempt is
    // issued with an already-aborted signal, so `fetch` rejects before opening a
    // connection and the upstream never sees it. What an unguarded loop really
    // burns is the fallback chain itself (`minimax-m2.5 → fb-1 → fb-2`) and,
    // worse, the circuit breaker — recording a client hang-up as a model FAILURE
    // lets client behavior open a breaker on a perfectly healthy model.
    expect(nextFallback).not.toHaveBeenCalled();
    expect(recordModelOutcome).not.toHaveBeenCalled();
    expect(upstream.hits).toBe(1);
  }, 20_000);

  it('relays an undisturbed stream to completion (no premature cancellation)', async () => {
    await startProxy();
    upstream.sseEvents = 5;
    const token = proxy.addRoute(subRoute(claudeProfile(upstreamUrl('/v1/messages'))));

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(streamBody),
    });
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).toContain('message_start');
    expect(text).toContain('tok4');
    expect(text).toContain('message_stop');
    expect(upstream.abortedByHit[0]).toBe(false);
  }, 20_000);
});

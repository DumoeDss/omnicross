/**
 * Unit tests for the OutboundApiServer lifecycle + status (`outbound-api-server`
 * task 8.5). Binds a real loopback listener (no Electron needed) and asserts the
 * status URLs/port + the loopback-vs-0.0.0.0 bind behavior.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_ANTHROPIC_PING_HEARTBEAT_MS,
  getAnthropicPingHeartbeatMs,
} from '../../transformer/transformers/AnthropicOpenAIToAnthropicStream';
import { formatUrls, OutboundApiServer } from '../OutboundApiServer';
import type { EndpointRoutingConfig, OutboundApiDeps } from '../types';

/** Minimal deps — no request will be dispatched in these lifecycle tests. */
const deps = {
  db: {} as OutboundApiDeps['db'],
  llmConfig: {} as OutboundApiDeps['llmConfig'],
  providerProxy: {} as OutboundApiDeps['providerProxy'],
  proxyDeps: {} as OutboundApiDeps['proxyDeps'],
} as OutboundApiDeps;

// COMPLETE kind maps for the kind-mapped endpoints so the startup gate (design
// D6) is satisfied and the lifecycle tests can bind; chat/gemini stay role-based.
const endpoints: EndpointRoutingConfig[] = [
  { endpoint: 'chat', defaultModel: 'p,m', backgroundModel: 'p,m', useSubscription: false },
  {
    endpoint: 'responses',
    modelMap: { codex: 'p,m', mini: 'p,m' },
    useSubscription: false,
  },
  {
    endpoint: 'messages',
    modelMap: { fable: 'p,m', opus: 'p,m', sonnet: 'p,m', haiku: 'p,m' },
    useSubscription: false,
  },
  { endpoint: 'gemini', defaultModel: 'p,m', backgroundModel: 'p,m', useSubscription: false },
];

let server: OutboundApiServer | null = null;

afterEach(async () => {
  const current = server;
  server = null;
  await current?.stop();
});

describe('OutboundApiServer', () => {
  it('is stopped + reports no URLs before enabling', () => {
    server = new OutboundApiServer(deps);
    const status = server.getStatus();
    expect(status.running).toBe(false);
    expect(status.loopbackUrl).toBeNull();
    expect(status.formats).toBeNull();
    expect(status).not.toHaveProperty('images');
    expect(status).not.toHaveProperty('lanImages');
  });

  // claude-api-experience-extras (R10): HEAD /api/hello at the LISTENER level —
  // unauthenticated 200 by default; apiHello:false keeps the previous behavior.
  it('HEAD /api/hello answers a bare unauthenticated 200 by default', async () => {
    server = new OutboundApiServer(deps);
    await server.applyConfig({ enabled: true, networkBinding: false, endpoints, port: 0 });
    const res = await fetch(`http://127.0.0.1:${server.getStatus().port}/api/hello`, {
      method: 'HEAD',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('apiHello:false keeps the pre-change behavior (auth-less request → 401)', async () => {
    server = new OutboundApiServer(deps);
    await server.applyConfig({
      enabled: true,
      networkBinding: false,
      endpoints,
      port: 0,
      anthropic: { apiHello: false },
    });
    const res = await fetch(`http://127.0.0.1:${server.getStatus().port}/api/hello`, {
      method: 'HEAD',
    });
    // HEAD carries no body — the status alone pins the fall-through (the auth
    // gate answered, not the listener).
    expect(res.status).toBe(401);
  });

  it('GET /api/hello is NOT the hello route (falls through; not the listener 200)', async () => {
    server = new OutboundApiServer(deps);
    await server.applyConfig({ enabled: true, networkBinding: false, endpoints, port: 0 });
    const res = await fetch(`http://127.0.0.1:${server.getStatus().port}/api/hello`);
    expect(res.status).not.toBe(200); // listener serves HEAD only
  });

  it('GET|HEAD /health + /healthz behavior is unchanged', async () => {
    server = new OutboundApiServer({ ...deps, healthReportProvider: () => ({ status: 'ok' } as never) });
    await server.applyConfig({ enabled: true, networkBinding: false, endpoints, port: 0 });
    const base = `http://127.0.0.1:${server.getStatus().port}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const head = await fetch(`${base}/health`, { method: 'HEAD' });
    expect(head.status).toBe(200);
  });

  // claude-api-protocol-fidelity (§10 hot-reload seam, review B-M3): applyConfig
  // is the ONE place the synthetic-ping heartbeat is hot-set — both daemon call
  // sites (boot + admin PUT) flow through it. enabled:false keeps these
  // lifecycle-only (no listener binds), exercising the setter path that runs
  // before the early return.
  it('applyConfig hot-sets the synthetic-ping heartbeat from the anthropic segment', async () => {
    server = new OutboundApiServer(deps);
    await server.applyConfig({
      enabled: false,
      networkBinding: false,
      endpoints,
      anthropic: { heartbeatIntervalMs: 33_000 },
    });
    expect(getAnthropicPingHeartbeatMs()).toBe(33_000);

    // Re-apply with a different value (hot reload, no restart).
    await server.applyConfig({
      enabled: false,
      networkBinding: false,
      endpoints,
      anthropic: { heartbeatIntervalMs: 0 },
    });
    expect(getAnthropicPingHeartbeatMs()).toBe(0);

    // Absent segment → the official default (setter resets).
    await server.applyConfig({ enabled: false, networkBinding: false, endpoints });
    expect(getAnthropicPingHeartbeatMs()).toBe(DEFAULT_ANTHROPIC_PING_HEARTBEAT_MS);
  });

  it('binds loopback by default and reports the four format URLs', async () => {
    server = new OutboundApiServer(deps);
    await server.applyConfig({ enabled: true, networkBinding: false, endpoints, port: 0 });
    const status = server.getStatus();
    expect(status.running).toBe(true);
    expect(status.port).toBeGreaterThan(0);
    expect(status.loopbackUrl).toBe(`http://127.0.0.1:${status.port}`);
    // Loopback binding → no LAN URL.
    expect(status.lanUrl).toBeNull();
    expect(status.lanFormats).toBeNull();
    expect(status.formats).toEqual(formatUrls(`http://127.0.0.1:${status.port}`));
    expect(status).not.toHaveProperty('images');
    expect(status).not.toHaveProperty('lanImages');
    expect(Object.keys(status).sort()).toEqual([
      'formats',
      'lanFormats',
      'lanUrl',
      'loopbackUrl',
      'port',
      'running',
    ]);
  });

  it('adds exact loopback Images URLs only when Images serving is enabled', async () => {
    server = new OutboundApiServer(deps);
    await server.applyConfig({
      enabled: true,
      networkBinding: false,
      imagesEnabled: true,
      endpoints,
      port: 0,
    });
    const status = server.getStatus();
    expect(status.images).toEqual({
      generations: `${status.loopbackUrl}/v1/images/generations`,
      edits: `${status.loopbackUrl}/v1/images/edits`,
    });
    expect(status).not.toHaveProperty('lanImages');
    expect(status.formats).toEqual(formatUrls(status.loopbackUrl!));
  });

  it('hot-disables additive Images URLs without restarting the listener', async () => {
    server = new OutboundApiServer(deps);
    await server.applyConfig({
      enabled: true,
      networkBinding: false,
      imagesEnabled: true,
      endpoints,
      port: 0,
    });
    const before = server.getStatus();
    expect(before.images).toBeDefined();

    await server.applyConfig({
      enabled: true,
      networkBinding: false,
      imagesEnabled: false,
      endpoints,
      port: before.port,
    });
    const after = server.getStatus();
    expect(after.port).toBe(before.port);
    expect(after.running).toBe(true);
    expect(after.formats).toEqual(before.formats);
    expect(after).not.toHaveProperty('images');
    expect(after).not.toHaveProperty('lanImages');
  });

  it('binds 0.0.0.0 when network binding is enabled (loopback URL still shown)', async () => {
    server = new OutboundApiServer(deps);
    await server.applyConfig({ enabled: true, networkBinding: true, endpoints, port: 0 });
    const status = server.getStatus();
    expect(status.running).toBe(true);
    // Loopback URL is always shown; LAN URL is present only if a LAN IPv4 exists.
    expect(status.loopbackUrl).toBe(`http://127.0.0.1:${status.port}`);
    expect(status.formats).not.toBeNull();
  });

  it('disabling stops the listener and releases the port', async () => {
    server = new OutboundApiServer(deps);
    await server.applyConfig({ enabled: true, networkBinding: false, endpoints, port: 0 });
    expect(server.getStatus().running).toBe(true);
    await server.applyConfig({ enabled: false, networkBinding: false, endpoints, port: 0 });
    expect(server.getStatus().running).toBe(false);
  });

  it('prepares a listener without publishing it and disposes an unpublished socket', async () => {
    server = new OutboundApiServer(deps);
    const prepared = await server.prepareConfig({
      enabled: true,
      networkBinding: false,
      endpoints,
      port: 0,
    });
    expect(server.getStatus().running).toBe(false);
    await prepared.dispose();
    expect(server.getStatus().running).toBe(false);

    const replacement = await server.prepareConfig({
      enabled: true,
      networkBinding: false,
      endpoints,
      port: 0,
    });
    expect(server.getStatus().running).toBe(false);
    await replacement.publish();
    expect(server.getStatus().running).toBe(true);
  });

  it('rolls a published snapshot back to the prior live config', async () => {
    server = new OutboundApiServer(deps);
    await server.applyConfig({
      enabled: true,
      networkBinding: false,
      endpoints,
      port: 0,
      anthropic: { heartbeatIntervalMs: 12_000 },
    });
    const port = server.getStatus().port;
    const prepared = await server.prepareConfig({
      enabled: true,
      networkBinding: false,
      endpoints,
      port: 0,
      anthropic: { heartbeatIntervalMs: 34_000 },
    });
    expect(getAnthropicPingHeartbeatMs()).toBe(12_000);
    await prepared.publish();
    expect(server.getStatus().port).toBe(port);
    expect(getAnthropicPingHeartbeatMs()).toBe(34_000);
    await prepared.rollback();
    expect(server.getStatus().port).toBe(port);
    expect(getAnthropicPingHeartbeatMs()).toBe(12_000);
  });

  it('rejects a live fixed-port address switch during prepare without disturbing the listener', async () => {
    server = new OutboundApiServer(deps);
    await server.applyConfig({ enabled: true, networkBinding: false, endpoints, port: 0 });
    const before = server.getStatus();

    await expect(server.prepareConfig({
      enabled: true,
      networkBinding: true,
      endpoints,
      port: before.port,
    })).rejects.toThrow(/require disabling first or changing the port/);

    expect(server.getStatus()).toEqual(before);
    expect((await fetch(`http://127.0.0.1:${before.port}/api/hello`, { method: 'HEAD' })).status).toBe(200);
  });

  it('keeps prepared publication infallible when an advisory port-change hook throws', async () => {
    server = new OutboundApiServer(deps, () => {
      throw new Error('injected advisory hook failure');
    });
    const prepared = await server.prepareConfig({
      enabled: true,
      networkBinding: false,
      endpoints,
      port: 0,
    });
    await expect(prepared.publish()).resolves.toBeUndefined();
    expect(server.getStatus().running).toBe(true);
  });
});

describe('OutboundApiServer — model config is not a startup gate', () => {
  // A messages endpoint missing `haiku` + a responses endpoint missing `mini`.
  // Routes compose, so an incomplete map is NOT a reason to refuse to bind — the
  // affected request answers per-request instead.
  const incompleteEndpoints: EndpointRoutingConfig[] = [
    { endpoint: 'chat', defaultModel: 'p,m', backgroundModel: 'p,m', useSubscription: false },
    { endpoint: 'responses', modelMap: { codex: 'p,m' }, useSubscription: false },
    {
      endpoint: 'messages',
      modelMap: { fable: 'p,m', opus: 'p,m', sonnet: 'p,m' },
      useSubscription: false,
    },
    { endpoint: 'gemini', defaultModel: 'p,m', backgroundModel: 'p,m', useSubscription: false },
  ];

  it('enable with an incomplete kind map binds anyway', async () => {
    server = new OutboundApiServer(deps);
    await server.applyConfig({ enabled: true, networkBinding: false, endpoints: incompleteEndpoints, port: 0 });
    expect(server.getStatus().running).toBe(true);
  });

  it('enable with COMPLETE maps binds normally', async () => {
    server = new OutboundApiServer(deps);
    await server.applyConfig({ enabled: true, networkBinding: false, endpoints, port: 0 });
    expect(server.getStatus().running).toBe(true);
  });

  it('a RUNNING server that receives an enabled+incomplete config keeps serving', async () => {
    server = new OutboundApiServer(deps);
    await server.applyConfig({ enabled: true, networkBinding: false, endpoints, port: 0 });
    expect(server.getStatus().running).toBe(true);
    await server.applyConfig({ enabled: true, networkBinding: false, endpoints: incompleteEndpoints, port: 0 });
    expect(server.getStatus().running).toBe(true);
  });

  it('a DISABLED server stops regardless of its model config', async () => {
    server = new OutboundApiServer(deps);
    await expect(
      server.applyConfig({ enabled: false, networkBinding: false, endpoints: incompleteEndpoints, port: 0 }),
    ).resolves.toBeUndefined();
    expect(server.getStatus().running).toBe(false);
  });
});

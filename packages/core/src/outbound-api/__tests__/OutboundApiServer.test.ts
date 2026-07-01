/**
 * Unit tests for the OutboundApiServer lifecycle + status (`outbound-api-server`
 * task 8.5). Binds a real loopback listener (no Electron needed) and asserts the
 * status URLs/port + the loopback-vs-0.0.0.0 bind behavior.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { formatUrls, OutboundApiConfigError, OutboundApiServer } from '../OutboundApiServer';
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
});

describe('OutboundApiServer — startup gate (design D6)', () => {
  // A messages endpoint missing `haiku` + a responses endpoint missing `mini`.
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

  it('enable with an incomplete kind map → throws OutboundApiConfigError, server not running', async () => {
    server = new OutboundApiServer(deps);
    await expect(
      server.applyConfig({ enabled: true, networkBinding: false, endpoints: incompleteEndpoints, port: 0 }),
    ).rejects.toBeInstanceOf(OutboundApiConfigError);
    expect(server.getStatus().running).toBe(false);
  });

  it('the thrown error carries the per-endpoint missing kinds', async () => {
    server = new OutboundApiServer(deps);
    let caught: unknown;
    try {
      await server.applyConfig({ enabled: true, networkBinding: false, endpoints: incompleteEndpoints, port: 0 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OutboundApiConfigError);
    const missing = (caught as OutboundApiConfigError).missing;
    // Endpoint order follows ENDPOINT_MODEL_KINDS (messages before responses).
    expect(missing).toEqual([
      { endpoint: 'messages', missingKinds: ['haiku'] },
      { endpoint: 'responses', missingKinds: ['mini'] },
    ]);
  });

  it('enable with COMPLETE maps binds normally', async () => {
    server = new OutboundApiServer(deps);
    await server.applyConfig({ enabled: true, networkBinding: false, endpoints, port: 0 });
    expect(server.getStatus().running).toBe(true);
  });

  it('a RUNNING server that receives an enabled+incomplete config tears down (stops serving)', async () => {
    server = new OutboundApiServer(deps);
    // Bind with a complete config first.
    await server.applyConfig({ enabled: true, networkBinding: false, endpoints, port: 0 });
    expect(server.getStatus().running).toBe(true);
    // A re-apply that leaves it enabled but incomplete must THROW and STOP the
    // live listener (live state matches the "cannot start" the UI shows).
    await expect(
      server.applyConfig({ enabled: true, networkBinding: false, endpoints: incompleteEndpoints, port: 0 }),
    ).rejects.toBeInstanceOf(OutboundApiConfigError);
    expect(server.getStatus().running).toBe(false);
  });

  it('boot with an incomplete config stays stopped when the caller catches the throw', async () => {
    // Mirrors the boot enable path: try/catch → log → leave the server stopped.
    server = new OutboundApiServer(deps);
    let bootError: OutboundApiConfigError | null = null;
    try {
      await server.applyConfig({ enabled: true, networkBinding: false, endpoints: incompleteEndpoints, port: 0 });
    } catch (err) {
      if (err instanceof OutboundApiConfigError) bootError = err;
      else throw err;
    }
    expect(bootError).not.toBeNull();
    expect(server.getStatus().running).toBe(false);
  });

  it('a DISABLED server with an incomplete config does NOT throw (gate only on enable)', async () => {
    server = new OutboundApiServer(deps);
    await expect(
      server.applyConfig({ enabled: false, networkBinding: false, endpoints: incompleteEndpoints, port: 0 }),
    ).resolves.toBeUndefined();
    expect(server.getStatus().running).toBe(false);
  });
});

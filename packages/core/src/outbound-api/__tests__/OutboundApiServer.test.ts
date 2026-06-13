/**
 * Unit tests for the OutboundApiServer lifecycle + status (`outbound-api-server`
 * task 8.5). Binds a real loopback listener (no Electron needed) and asserts the
 * status URLs/port + the loopback-vs-0.0.0.0 bind behavior.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { formatUrls, OutboundApiServer } from '../OutboundApiServer';
import type { EndpointRoutingConfig, OutboundApiDeps } from '../types';

/** Minimal deps — no request will be dispatched in these lifecycle tests. */
const deps = {
  db: {} as OutboundApiDeps['db'],
  llmConfig: {} as OutboundApiDeps['llmConfig'],
  providerProxy: {} as OutboundApiDeps['providerProxy'],
  proxyDeps: {} as OutboundApiDeps['proxyDeps'],
} as OutboundApiDeps;

const endpoints: EndpointRoutingConfig[] = [
  { endpoint: 'chat', defaultModel: 'p,m', backgroundModel: 'p,m', useSubscription: false },
  { endpoint: 'responses', defaultModel: 'p,m', backgroundModel: 'p,m', useSubscription: false },
  { endpoint: 'messages', defaultModel: 'p,m', backgroundModel: 'p,m', useSubscription: false },
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

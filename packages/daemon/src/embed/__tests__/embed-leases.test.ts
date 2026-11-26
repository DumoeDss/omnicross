/**
 * Embedding entry acceptance §7.3 / §7.4 — in-process route leases:
 *  - `leases.create` returns usable credentials for `claude`, `codex` and
 *    `endpoint`; every lease carries `endpoint { baseUrl, token, wire }`;
 *  - an `endpoint` token is accepted through the proxy as `x-api-key` AND as
 *    `Authorization: Bearer`, and the upstream sees the provider key, never the
 *    route token;
 *  - the default and host-customized launch descriptors carry no product name;
 *  - subscription-account leases run the built-in preflight;
 *  - renew / release / capabilities; released tokens stop working.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEmbeddedHost, type EmbeddedHost } from '@omnicross/daemon/embed';

import { createSandbox, launchStrings, type MockUpstream, type Sandbox, startMockUpstream } from './embedFixture';

let sandbox: Sandbox;
let upstream: MockUpstream;
let host: EmbeddedHost;

async function bootHost(options: Partial<Parameters<typeof createEmbeddedHost>[0]> = {}): Promise<void> {
  host = createEmbeddedHost({ dataDir: sandbox.dataDir, ...options });
  await host.start();
  await host.providers.create({
    id: 'anth',
    apiFormat: 'anthropic',
    baseUrl: upstream.url,
    apiKey: 'sk-provider-anth',
    models: ['claude-model'],
  });
  await host.providers.create({
    id: 'oai',
    apiFormat: 'openai',
    baseUrl: `${upstream.url}/v1`,
    apiKey: 'sk-provider-oai',
    models: ['chat-model'],
  });
}

beforeEach(async () => {
  sandbox = createSandbox();
  upstream = await startMockUpstream(['claude-model', 'chat-model']);
});

afterEach(async () => {
  await host?.stop();
  await upstream.close();
  sandbox.cleanup();
});

function expectNoProductName(values: readonly string[]): void {
  for (const value of values) expect(value.toLowerCase()).not.toContain('omnicross');
}

describe('leases (§7.3)', () => {
  it('claude lease: launch env targets the proxy and carries the route token', async () => {
    await bootHost();
    const lease = await host.leases.create(
      { runtime: 'claude', upstream: { kind: 'provider', providerId: 'anth' }, model: 'claude-model' },
      'claude-1',
    );
    expect(lease.created).toBe(true);
    expect(lease.launch.env).toMatchObject({
      ANTHROPIC_BASE_URL: host.proxyBaseUrl,
      ANTHROPIC_AUTH_TOKEN: lease.endpoint.token,
      ANTHROPIC_MODEL: 'claude-model',
    });
    expect(lease.endpoint).toEqual({ baseUrl: host.proxyBaseUrl, token: lease.endpoint.token, wire: 'anthropic-messages' });

    // The CLI's request shape: Bearer route token (+ the placeholder x-api-key).
    const response = await fetch(`${lease.launch.env['ANTHROPIC_BASE_URL']}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${lease.launch.env['ANTHROPIC_AUTH_TOKEN']}`,
        'x-api-key': lease.launch.env['ANTHROPIC_API_KEY'],
      },
      body: JSON.stringify({ model: 'claude-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);

    // Idempotent replay returns the same lease.
    const replay = await host.leases.create(
      { runtime: 'claude', upstream: { kind: 'provider', providerId: 'anth' }, model: 'claude-model' },
      'claude-1',
    );
    expect(replay).toMatchObject({ leaseId: lease.leaseId, created: false });
  });

  it('codex lease: -c overrides point at the proxy and the token rides the env_key', async () => {
    await bootHost();
    const lease = await host.leases.create(
      { runtime: 'codex', upstream: { kind: 'provider', providerId: 'oai' }, model: 'chat-model' },
      'codex-1',
    );
    const args = lease.launch.extraArgs.join(' ');
    expect(args).toContain(`base_url="${host.proxyBaseUrl}/openai"`);
    expect(args).toContain('wire_api="responses"');
    const envKey = /env_key="([A-Z_]+)"/.exec(args)?.[1];
    expect(envKey).toBeDefined();
    expect(lease.launch.env[envKey!]).toBe(lease.endpoint.token);
    expect(lease.endpoint.wire).toBe('openai-responses');

    const response = await fetch(`${host.proxyBaseUrl}/openai/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${lease.launch.env[envKey!]}` },
      body: JSON.stringify({ model: 'chat-model', input: 'hi', stream: false }),
    });
    expect(response.status).toBe(200);
  });

  it('endpoint lease (anthropic-messages): token accepted via x-api-key and via Bearer', async () => {
    await bootHost();
    const lease = await host.leases.create(
      {
        runtime: 'endpoint',
        wire: 'anthropic-messages',
        upstream: { kind: 'provider', providerId: 'anth' },
        model: 'claude-model',
      },
      'endpoint-anth',
    );
    expect(lease.launch).toEqual({ env: {}, extraArgs: [] });
    const { baseUrl, token } = lease.endpoint;
    const send = (headers: Record<string, string>) =>
      fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
        body: JSON.stringify({ model: 'ignored-by-lease', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
      });

    const viaApiKey = await send({ 'x-api-key': token });
    expect(viaApiKey.status).toBe(200);
    expect(((await viaApiKey.json()) as { content: Array<{ text: string }> }).content[0].text).toBe('OK');
    const viaBearer = await send({ authorization: `Bearer ${token}` });
    expect(viaBearer.status).toBe(200);
    expect((await send({ 'x-api-key': 'not-a-token' })).status).toBe(401);

    // Upstream saw the provider key and the leased model, never the route token.
    const relayed = upstream.requests.filter((r) => r.method === 'POST');
    expect(relayed.length).toBe(2);
    for (const request of relayed) {
      expect(JSON.stringify(request.headers)).not.toContain(token);
      expect(JSON.stringify(request.headers)).toContain('sk-provider-anth');
      expect((JSON.parse(request.body) as { model: string }).model).toBe('claude-model');
    }
  });

  it('endpoint lease (openai-chat): an OpenAI SDK base URL + Bearer works', async () => {
    await bootHost();
    const lease = await host.leases.create(
      { runtime: 'endpoint', wire: 'openai-chat', upstream: { kind: 'provider', providerId: 'oai' }, model: 'chat-model' },
      'endpoint-chat',
    );
    expect(lease.endpoint.baseUrl).toBe(`${host.proxyBaseUrl}/v1`);
    const response = await fetch(`${lease.endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${lease.endpoint.token}` },
      body: JSON.stringify({ model: 'chat-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe('OK');
    // x-api-key works on the OpenAI wire too.
    const viaApiKey = await fetch(`${lease.endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': lease.endpoint.token },
      body: JSON.stringify({ model: 'chat-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(viaApiKey.status).toBe(200);
  });

  it('validates endpoint requests with stable error codes', async () => {
    await bootHost();
    await expect(
      host.leases.create({ runtime: 'endpoint', upstream: { kind: 'provider', providerId: 'anth' }, model: 'claude-model' }, 'no-wire'),
    ).rejects.toMatchObject({ name: 'HostError', code: 'invalid_request' });
    await expect(
      host.leases.create({ runtime: 'claude', wire: 'openai-chat', upstream: { kind: 'provider', providerId: 'anth' }, model: 'claude-model' }, 'bad-wire'),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      host.leases.create({ runtime: 'endpoint', wire: 'anthropic-messages', upstream: { kind: 'provider', providerId: 'nope' }, model: 'm' }, 'missing'),
    ).rejects.toMatchObject({ code: 'upstream_not_found', status: 404 });
    await expect(
      host.leases.create({ runtime: 'endpoint', wire: 'anthropic-messages', upstream: { kind: 'provider', providerId: 'anth' }, model: 'unlisted' }, 'unlisted'),
    ).rejects.toMatchObject({ code: 'model_not_configured' });
  });

  it('renews, releases (token stops working) and reports capabilities', async () => {
    await bootHost();
    const lease = await host.leases.create(
      { runtime: 'endpoint', wire: 'anthropic-messages', upstream: { kind: 'provider', providerId: 'anth' }, model: 'claude-model', ttlSeconds: 60 },
      'renew-1',
    );
    const renewed = await host.leases.renew(lease.leaseId, 3600);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(lease.expiresAt));
    expect(await host.leases.release(lease.leaseId)).toEqual({ released: true });
    expect(await host.leases.release(lease.leaseId)).toEqual({ released: false });
    const after = await fetch(`${lease.endpoint.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': lease.endpoint.token },
      body: JSON.stringify({ model: 'x', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(after.status).toBe(401);
    await expect(host.leases.renew(lease.leaseId)).rejects.toMatchObject({ code: 'lease_not_found' });

    expect(host.leases.capabilities()).toMatchObject({
      runtimes: ['claude', 'codex', 'endpoint'],
      wires: ['anthropic-messages', 'openai-responses', 'openai-chat'],
      maxTtlSeconds: 3600,
      tokenHeaders: ['authorization', 'x-api-key', 'x-goog-api-key'],
    });
  });

  it('stop() releases every lease', async () => {
    await bootHost();
    const lease = await host.leases.create(
      { runtime: 'endpoint', wire: 'openai-chat', upstream: { kind: 'provider', providerId: 'oai' }, model: 'chat-model' },
      'stop-1',
    );
    expect((await host.health()).activeLeases).toBe(1);
    const base = lease.endpoint.baseUrl;
    await host.stop();
    await expect(fetch(`${base}/chat/completions`, { method: 'POST' })).rejects.toThrow();
  });

  it('subscription account leases run the built-in preflight', async () => {
    await bootHost();
    await expect(
      host.leases.create({ runtime: 'claude', upstream: { kind: 'account-pool', providerId: 'claude' }, model: 'claude-sonnet-4-5' }, 'sub-empty'),
    ).rejects.toMatchObject({ code: 'upstream_unavailable' });

    await host.accounts.addManual('claude', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: 'claude-access',
      refreshToken: 'claude-refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const [account] = (await host.accounts.list()).accounts;
    const lease = await host.leases.create(
      { runtime: 'claude', upstream: { kind: 'account', providerId: 'claude', accountId: account.id }, model: 'claude-sonnet-4-5' },
      'sub-1',
    );
    expect(lease.endpoint.wire).toBe('anthropic-messages');

    await host.accounts.patch('claude', account.id, { enabled: false });
    await expect(
      host.leases.create({ runtime: 'claude', upstream: { kind: 'account', providerId: 'claude', accountId: account.id }, model: 'claude-sonnet-4-5' }, 'sub-2'),
    ).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });
});

describe('de-branded launch descriptors (§7.4)', () => {
  it('default descriptors carry no product name', async () => {
    await bootHost();
    const claude = await host.leases.create(
      { runtime: 'claude', upstream: { kind: 'provider', providerId: 'anth' }, model: 'claude-model' },
      'brand-claude',
    );
    const codex = await host.leases.create(
      { runtime: 'codex', upstream: { kind: 'provider', providerId: 'oai' }, model: 'chat-model' },
      'brand-codex',
    );
    expectNoProductName(launchStrings(claude.launch));
    expectNoProductName(launchStrings(codex.launch));
  });

  it('host-supplied identifiers replace every name in env and args', async () => {
    await bootHost({
      routeLeaseDescriptors: {
        claude: { apiKeyPlaceholder: 'superagent-placeholder', extraEnv: { DISABLE_TELEMETRY: '1' } },
        codex: { providerId: 'superagent', providerName: 'Superagent Providers', tokenEnv: 'SUPERAGENT_ROUTE_TOKEN' },
      },
    });
    const claude = await host.leases.create(
      { runtime: 'claude', upstream: { kind: 'provider', providerId: 'anth' }, model: 'claude-model' },
      'custom-claude',
    );
    expect(claude.launch.env).toMatchObject({ ANTHROPIC_API_KEY: 'superagent-placeholder', DISABLE_TELEMETRY: '1' });
    const codex = await host.leases.create(
      { runtime: 'codex', upstream: { kind: 'provider', providerId: 'oai' }, model: 'chat-model' },
      'custom-codex',
    );
    expect(codex.launch.env).toEqual({ SUPERAGENT_ROUTE_TOKEN: codex.endpoint.token });
    expect(codex.launch.extraArgs).toContain('model_provider="superagent"');
    expect(codex.launch.extraArgs).toContain('model_providers.superagent.name="Superagent Providers"');
    expect(codex.launch.extraArgs).toContain('model_providers.superagent.env_key="SUPERAGENT_ROUTE_TOKEN"');
    expectNoProductName([...launchStrings(claude.launch), ...launchStrings(codex.launch)]);
  });

  it('rejects identifiers that would break the CLI config', () => {
    expect(() => createEmbeddedHost({
      dataDir: sandbox.dataDir,
      routeLeaseDescriptors: { codex: { providerId: 'has space' } },
    })).toThrow(TypeError);
  });
});

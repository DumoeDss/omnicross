/**
 * Embedding entry acceptance §7.2 — the admin service functions, end to end
 * against a mock upstream and fake OAuth endpoints:
 *  - BYO provider create (validation, model discovery), update (blank key
 *    keeps), reorder, test, key pool add/update/disable/remove, delete;
 *  - presets and upstreams listings;
 *  - accounts: manual add, group/priority patch, active switch, batch,
 *    diagnostics, removal;
 *  - interactive sign-in for all three kinds: paste-code (claude), loopback
 *    (codex, listener seam) and device-code (kimi);
 *  - change notifications.
 * Secrets never appear in any returned value.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { awaitLoopbackCode } from '../../commands/loopbackCallback';
import { createEmbeddedHost, type EmbeddedHost, HostError, type HostChangeEvent } from '@omnicross/daemon/embed';

import {
  createSandbox,
  fakeOAuthEndpoint,
  type FakeOAuthEndpoint,
  type MockUpstream,
  type Sandbox,
  startMockUpstream,
  waitFor,
} from './embedFixture';

let sandbox: Sandbox;
let upstream: MockUpstream;
let oauthEndpoint: FakeOAuthEndpoint;
let host: EmbeddedHost;
let events: HostChangeEvent[];
/** Codex loopback seam: resolves with a code once the test releases it. */
let releaseCodexCallback: ((code: string) => void) | undefined;

beforeEach(async () => {
  sandbox = createSandbox();
  upstream = await startMockUpstream(['disc-1', 'disc-2']);
  oauthEndpoint = fakeOAuthEndpoint();
  host = createEmbeddedHost({
    dataDir: sandbox.dataDir,
    oauth: {
      exchangeFetch: oauthEndpoint.fetch as never,
      awaitLoopback: {
        codex: (_state, _timeoutMs, signal) =>
          new Promise<string>((resolve, reject) => {
            releaseCodexCallback = resolve;
            signal?.addEventListener('abort', () => reject(new Error('login: cancelled')), { once: true });
          }),
      },
    },
  });
  events = [];
  host.on('change', (event) => events.push(event));
  await host.start();
});

afterEach(async () => {
  await host.stop();
  await upstream.close();
  sandbox.cleanup();
});

describe('providers + key pool (§7.2)', () => {
  it('creates a BYO provider, discovers models, manages its key pool and removes it', async () => {
    await expect(host.providers.create({ id: 'bad' })).rejects.toMatchObject({
      name: 'HostError',
      code: 'invalid_request',
      status: 400,
    });

    const created = await host.providers.create({
      id: 'byo',
      name: 'My Provider',
      apiFormat: 'openai',
      baseUrl: `${upstream.url}/v1`,
      apiKey: 'sk-live-abcd',
    });
    expect(created).toMatchObject({ id: 'byo', name: 'My Provider', hasApiKey: true, apiKeyMasked: 'sk-…abcd' });
    // Create-time discovery merged the upstream's models into the row.
    expect(created.models).toEqual(['disc-1', 'disc-2']);
    expect(JSON.stringify(created)).not.toContain('sk-live-abcd');
    await expect(host.providers.create({ id: 'byo', apiFormat: 'openai', baseUrl: upstream.url }))
      .rejects.toMatchObject({ code: 'conflict' });

    // Discovery sends the provider key upstream, never back to the caller.
    const discovered = await host.providers.discoverModels('byo');
    expect(discovered.models).toEqual(['disc-1', 'disc-2']);
    const modelsCall = upstream.requests.filter((r) => r.path.endsWith('/models')).at(-1)!;
    expect(modelsCall.headers['authorization']).toBe('Bearer sk-live-abcd');

    // Update: a blank apiKey keeps the stored key; null clears a field.
    const updated = await host.providers.update('byo', {
      apiFormat: 'openai',
      baseUrl: `${upstream.url}/v1`,
      apiKey: '',
      name: null,
    });
    expect(updated.apiKeyMasked).toBe('sk-…abcd');
    expect(updated.name).toBeUndefined();

    // Real (mock) completion through the provider's own key.
    const tested = await host.providers.test('byo', 'disc-1');
    expect(tested).toMatchObject({ ok: true, status: 200, sample: 'OK' });

    // Key pool.
    let keys = await host.providers.keys.add('byo', { apiKey: 'sk-pool-1111', label: 'first' });
    const added = keys.find((key) => key.label === 'first')!;
    expect(added.apiKeyMasked).toBe('sk-…1111');
    keys = await host.providers.keys.update('byo', added.id, { label: 'renamed', apiKey: '' });
    expect(keys.find((key) => key.id === added.id)).toMatchObject({ label: 'renamed', apiKeyMasked: 'sk-…1111' });
    keys = await host.providers.keys.setEnabled('byo', added.id, false);
    expect(keys.find((key) => key.id === added.id)?.enabled).toBe(false);
    expect(JSON.stringify(await host.providers.keys.list('byo'))).not.toContain('sk-pool-1111');
    keys = await host.providers.keys.remove('byo', added.id);
    expect(keys.some((key) => key.id === added.id)).toBe(false);
    await expect(host.providers.keys.remove('byo', 'nope')).rejects.toMatchObject({ code: 'not_found' });

    // Reorder + remove.
    await host.providers.create({ id: 'second', apiFormat: 'gemini', baseUrl: upstream.url, apiKey: 'g' });
    expect((await host.providers.reorder(['second'])).map((p) => p.id)).toEqual(['second', 'byo']);
    await host.providers.remove('byo');
    expect((await host.providers.list()).map((p) => p.id)).toEqual(['second']);
    await expect(host.providers.get('byo')).rejects.toBeInstanceOf(HostError);

    expect(events.filter((e) => e.scope === 'providers').map((e) => e.action)).toEqual([
      'created', 'updated', 'key-added', 'key-updated', 'key-updated', 'key-removed', 'created', 'reordered', 'removed',
    ]);
  });

  it('lists presets and the upstream catalog with lease support', async () => {
    const { presets } = await host.presets.list();
    expect(presets.length).toBeGreaterThan(0);

    await host.providers.create({ id: 'anth', apiFormat: 'anthropic', baseUrl: upstream.url, apiKey: 'k', models: ['m1'] });
    await host.accounts.addManual('claude', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const upstreams = await host.upstreams.list();
    const provider = upstreams.find((u) => u.key === 'anth')!;
    expect(provider).toMatchObject({ kind: 'provider', target: { kind: 'provider', providerId: 'anth' } });
    expect(provider.models).toContain('m1');
    expect(provider.lease.wires).toContain('anthropic-messages');
    const pool = upstreams.find((u) => u.key === 'sub:claude')!;
    expect(pool).toMatchObject({ kind: 'subscription', target: { kind: 'account-pool', providerId: 'claude' } });
    expect(pool.lease.supported).toBe(true);
    expect(pool.models.length).toBeGreaterThan(0);
  });
});

describe('accounts (§7.2)', () => {
  it('adds, patches, switches, batches, diagnoses and removes accounts', async () => {
    const add = (label: string) => host.accounts.addManual('claude', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: `secret-access-${label}`,
      refreshToken: `secret-refresh-${label}`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      label,
    });
    await add('one');
    await add('two');
    await expect(host.accounts.addManual('claude', { authMethod: 'oauth' })).rejects.toMatchObject({ code: 'invalid_request' });

    let list = await host.accounts.list();
    expect(JSON.stringify(list)).not.toContain('secret-');
    const [first, second] = list.accounts.filter((a) => a.providerId === 'claude');
    expect([first.label, second.label]).toEqual(['one', 'two']);

    await host.accounts.patch('claude', first.id, { group: 'team-a', priority: 10, tags: ['x'] });
    await host.accounts.setActive('claude', first.id);
    list = await host.accounts.list();
    const patched = list.accounts.find((a) => a.id === first.id)!;
    expect(patched).toMatchObject({ group: 'team-a', priority: 10, tags: ['x'], isActive: true });
    await expect(host.accounts.patch('claude', first.id, { accessToken: 'x' } as never)).rejects.toMatchObject({ code: 'invalid_request' });

    const batch = await host.accounts.batch({
      action: 'disable',
      accounts: [{ providerId: 'claude', accountId: second.id }],
    });
    expect(batch.affected).toBe(1);
    expect((await host.accounts.list()).accounts.find((a) => a.id === second.id)?.enabled).toBe(false);

    expect(Array.isArray(await host.accounts.diagnostics('claude', first.id))).toBe(true);
    await expect(host.accounts.diagnostics('claude', 'missing')).rejects.toMatchObject({ code: 'not_found' });

    await host.accounts.remove('claude', second.id);
    expect((await host.accounts.list()).accounts.map((a) => a.id)).toEqual([first.id]);

    const health = await host.health();
    expect(health.accounts).toEqual([
      expect.objectContaining({ providerId: 'claude', accountId: first.id, label: 'one', enabled: true }),
    ]);
    expect(events.filter((e) => e.scope === 'accounts').map((e) => e.action)).toEqual(
      expect.arrayContaining(['added', 'updated', 'activated', 'batch', 'removed']),
    );
  });
});

describe('interactive sign-in (§7.2)', () => {
  it('paste-code (claude): start → complete adds an account', async () => {
    expect(host.oauth.kindOf('claude')).toBe('paste-code');
    const session = await host.oauth.start('claude');
    expect(session).toMatchObject({ providerId: 'claude', kind: 'paste-code' });
    expect(session.authUrl).toMatch(/^https:\/\//);
    expect(await host.oauth.status('claude', session.sessionId)).toEqual({ state: 'pending' });

    const account = await host.oauth.complete('claude', session.sessionId, 'auth-code-1', { label: 'Pasted' });
    expect(account).not.toBeNull();
    expect(JSON.stringify(account)).not.toContain('refresh-token-1');
    expect(oauthEndpoint.calls.length).toBe(1);
    // Single use.
    await expect(host.oauth.complete('claude', session.sessionId, 'auth-code-1')).rejects.toMatchObject({ code: 'gone' });
    const claude = (await host.accounts.list()).accounts.filter((a) => a.providerId === 'claude');
    expect(claude.map((a) => a.label)).toEqual(['Pasted']);
  });

  it('loopback (codex): start arms the listener, the callback completes it, status polls to done', async () => {
    expect(host.oauth.kindOf('codex')).toBe('loopback');
    const session = await host.oauth.start('codex');
    expect(session).toMatchObject({ kind: 'loopback', callbackUrl: 'http://localhost:1455/auth/callback' });
    // One loopback sign-in at a time (the port is a single resource).
    await expect(host.oauth.start('codex')).rejects.toMatchObject({ code: 'conflict' });
    expect(await host.oauth.status('codex', session.sessionId)).toEqual({ state: 'pending' });

    await waitFor(async () => releaseCodexCallback);
    releaseCodexCallback!('loopback-code-1');
    const status = await waitFor(async () => {
      const current = await host.oauth.status('codex', session.sessionId);
      return current.state === 'pending' ? undefined : current;
    });
    expect(status).toEqual({ state: 'done' });
    expect((await host.accounts.list()).accounts.some((a) => a.providerId === 'codex')).toBe(true);
    // The async completion announced itself.
    expect(events).toContainEqual({ scope: 'accounts', action: 'added', providerId: 'codex' });
  });

  it('loopback cancel frees the slot', async () => {
    const session = await host.oauth.start('codex');
    await host.oauth.cancel('codex', session.sessionId);
    expect(await host.oauth.status('codex', session.sessionId)).toMatchObject({ state: 'error' });
    const again = await host.oauth.start('codex');
    expect(again.sessionId).not.toBe(session.sessionId);
  });

  it('device-code (kimi): start returns the user code, the poll completes it', async () => {
    expect(host.oauth.kindOf('kimi')).toBe('device-code');
    const session = await host.oauth.start('kimi');
    expect(session).toMatchObject({ kind: 'device-code', userCode: 'USER-CODE' });
    expect(session.verificationUri).toContain('https://example.test/device');
    const status = await waitFor(async () => {
      const current = await host.oauth.status('kimi', session.sessionId);
      return current.state === 'pending' ? undefined : current;
    });
    expect(status).toEqual({ state: 'done' });
    expect((await host.accounts.list()).accounts.some((a) => a.providerId === 'kimi')).toBe(true);
  });

  it('rejects providers with no interactive sign-in', async () => {
    expect(host.oauth.kindOf('opencodego')).toBeNull();
    await expect(host.oauth.start('opencodego')).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('loopback callback page (host-branded)', () => {
  it('shows the configured title and no product name', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const code = awaitLoopbackCode('state-1', 5000, undefined, {
      port,
      path: '/cb',
      pageTitle: 'Signed in to Example',
      pageHint: 'Return to Example.',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await fetch(`http://127.0.0.1:${port}/cb?code=c-1&state=state-1`);
    const html = await response.text();
    expect(await code).toBe('c-1');
    expect(html).toContain('<title>Signed in to Example</title>');
    expect(html).toContain('Return to Example.');
    expect(html.toLowerCase()).not.toContain('omnicross');
  });
});

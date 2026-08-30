import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import type { ImageCapabilities } from '@omnicross/contracts/image-generation-types';

import {
  defaultServerConfig,
  OUTBOUND_API_SERVER_CONFIG_KEY,
  type ImagesServerConfig,
  type OutboundApiServerConfig,
} from '@omnicross/core/outbound-api';

import {
  buildDaemon,
  type Daemon,
  type DaemonPaths,
  resetDaemonSingletonsForTests,
} from '../bootstrap';
import { loadConfig } from '../config';

let daemon: Daemon | undefined;
let tempHome: string | undefined;
let adminBase = '';

async function bootDaemon(
  overrides: Partial<DaemonPaths> = {},
  adminToken?: string,
): Promise<void> {
  resetDaemonSingletonsForTests();
  tempHome = mkdtempSync(join(tmpdir(), 'omnicross-admin-images-config-'));
  const configPath = join(tempHome, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    providers: [],
    server: { enabled: false, networkBinding: false, port: 0, endpoints: [] },
    admin: { port: 0, ...(adminToken ? { token: adminToken } : {}) },
    unrelated: { label: '保留' },
  }, null, 2), 'utf8');
  daemon = buildDaemon(loadConfig(configPath), {
    configPath,
    keysPath: join(tempHome, 'keys.json'),
    tokensPath: join(tempHome, 'tokens.json'),
    masterKeyFilePath: join(tempHome, 'master.key'),
    ...overrides,
  });
  await daemon.llmConfig.ready();
  await daemon.adminServer.start();
  adminBase = daemon.adminServer.getStatus().url as string;
}

async function adminFetch(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; text: string; json: unknown }> {
  const response = await fetch(`${adminBase}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

async function getServer(token?: string): Promise<OutboundApiServerConfig> {
  const response = await adminFetch('GET', '/admin/api/server', undefined, token);
  expect(response.status).toBe(200);
  return (response.json as { server: OutboundApiServerConfig }).server;
}

function enabledImages(current: OutboundApiServerConfig): ImagesServerConfig {
  return { ...current.images!, enabled: true };
}

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    daemon.apiKeyPool.dispose();
  }
  daemon = undefined;
  resetDaemonSingletonsForTests();
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
});

describe('admin Images config', () => {
  it('keeps legacy status fields stable and publishes Images status only while enabled', async () => {
    await bootDaemon();

    const disabled = await adminFetch('GET', '/admin/api/status');
    expect(disabled.status).toBe(200);
    expect(disabled.json).toMatchObject({
      running: false,
      port: 0,
      loopbackUrl: null,
      lanUrl: null,
      formats: null,
      lanFormats: null,
      endpoints: expect.arrayContaining([
        expect.objectContaining({ endpoint: 'chat' }),
        expect.objectContaining({ endpoint: 'responses' }),
        expect.objectContaining({ endpoint: 'messages' }),
        expect.objectContaining({ endpoint: 'gemini' }),
      ]),
    });
    expect(disabled.json).not.toHaveProperty('images');
    expect(disabled.json).not.toHaveProperty('lanImages');
    expect(disabled.json).not.toHaveProperty('imageRuntime');

    const current = await getServer();
    const enabled = await adminFetch('PUT', '/admin/api/server', {
      enabled: true,
      images: enabledImages(current),
    });
    expect(enabled.status).toBe(200);

    const active = await adminFetch('GET', '/admin/api/status');
    expect(active.status).toBe(200);
    const activeBody = active.json as Record<string, unknown>;
    const loopbackUrl = activeBody['loopbackUrl'] as string;
    expect(activeBody).toMatchObject({
      running: true,
      formats: {
        chat: `${loopbackUrl}/v1/chat/completions`,
        responses: `${loopbackUrl}/v1/responses`,
        messages: `${loopbackUrl}/v1/messages`,
        gemini: `${loopbackUrl}/v1beta/models/{model}:generateContent`,
      },
      images: {
        generations: `${loopbackUrl}/v1/images/generations`,
        edits: `${loopbackUrl}/v1/images/edits`,
      },
      imageRuntime: {
        enabled: true,
        generationId: expect.any(String),
        drainingCount: expect.any(Number),
      },
    });
    expect(activeBody).not.toHaveProperty('lanImages');

    const activeConfig = await getServer();
    const turnedOff = await adminFetch('PUT', '/admin/api/server', {
      images: { ...activeConfig.images!, enabled: false },
    });
    expect(turnedOff.status).toBe(200);
    const after = await adminFetch('GET', '/admin/api/status');
    expect(after.status).toBe(200);
    expect(after.json).toMatchObject({
      running: true,
      port: activeBody['port'],
      loopbackUrl,
      formats: activeBody['formats'],
      endpoints: activeBody['endpoints'],
    });
    expect(after.json).not.toHaveProperty('images');
    expect(after.json).not.toHaveProperty('lanImages');
    expect(after.json).not.toHaveProperty('imageRuntime');
  });

  it('keeps a successful update coherent across config, live status, and the next request', async () => {
    await bootDaemon();
    const current = await getServer();
    const updated = await adminFetch('PUT', '/admin/api/server', {
      enabled: true,
      images: enabledImages(current),
    });
    expect(updated.status).toBe(200);
    expect((await getServer()).images?.enabled).toBe(true);

    const status = await adminFetch('GET', '/admin/api/status');
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({
      running: true,
      imageRuntime: { enabled: true },
      images: {
        generations: expect.stringMatching(/\/v1\/images\/generations$/),
      },
    });
    const loopbackUrl = (status.json as { loopbackUrl: string }).loopbackUrl;

    const created = await adminFetch('POST', '/admin/api/keys', { name: 'images-coherence' });
    expect(created.status).toBe(201);
    const key = created.json as { id: string; plaintextOnce: string };
    const permitted = await adminFetch(
      'POST',
      `/admin/api/keys/${encodeURIComponent(key.id)}/permissions`,
      { permissions: ['images'] },
    );
    expect(permitted.status).toBe(200);

    const request = await fetch(`${loopbackUrl}/v1/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key.plaintextOnce}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'local coherence check' }),
    });
    const requestBody = await request.text();
    expect(request.status).toBe(503);
    expect(JSON.parse(requestBody)).toMatchObject({
      error: { code: 'upstream_auth_required' },
    });
    await vi.waitFor(() => {
      expect(daemon!.imageObservability.snapshot().apiRequests).toEqual([
        expect.objectContaining({
          dimensions: expect.objectContaining({ endpoint: 'images.generate' }),
          requests: 1,
        }),
      ]);
    });
  });

  it('exposes default-disabled normalized config and persists an Images-only update', async () => {
    const imageConfigAudit = vi.fn();
    await bootDaemon({ imageConfigAudit });
    const before = await getServer();
    const generationBefore = daemon!.imageRuntimeManager.status().current.generationId;
    expect(before.images).toBeDefined();
    expect(before.images?.enabled).toBe(false);
    expect(daemon!.imageRuntimeManager.status().current.enabled).toBe(false);

    const updated = await adminFetch('PUT', '/admin/api/server', {
      images: enabledImages(before),
    });
    expect(updated.status).toBe(200);
    expect((updated.json as { server: OutboundApiServerConfig }).server.images?.enabled).toBe(true);
    expect((await getServer()).images?.enabled).toBe(true);
    const generationAfter = daemon!.imageRuntimeManager.status().current;
    expect(generationAfter.enabled).toBe(true);
    expect(generationAfter.generationId).not.toBe(generationBefore);
    expect(imageConfigAudit).toHaveBeenCalledWith({
      outcome: 'applied',
      fields: ['enablement'],
      previousGenerationId: generationBefore,
      generationId: generationAfter.generationId,
    });

    const raw = JSON.parse(readFileSync(join(tempHome!, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(raw['unrelated']).toEqual({ label: '保留' });

    const disabled = await adminFetch('PUT', '/admin/api/server', {
      images: { ...enabledImages(await getServer()), enabled: false },
    });
    expect(disabled.status).toBe(200);
    expect(daemon!.imageRuntimeManager.status().current.enabled).toBe(false);
  });

  it('hides a custom storage path and preserves it across a safe UI-style update', async () => {
    await bootDaemon();
    const current = await getServer();
    const storageRoot = join(tempHome!, 'private-images-storage');
    mkdirSync(storageRoot, { recursive: true });
    const configured = {
      ...enabledImages(current),
      references: { ...current.images!.references, storageRoot },
    };

    const first = await adminFetch('PUT', '/admin/api/server', { images: configured });
    expect(first.status).toBe(200);
    expect(first.text).not.toContain(storageRoot);
    expect(first.json).toMatchObject({
      server: {
        images: {
          references: { storageRootConfigured: true },
        },
      },
    });
    expect((first.json as { server: { images: { references: Record<string, unknown> } } })
      .server.images.references).not.toHaveProperty('storageRoot');

    const projected = (first.json as { server: { images: ImagesServerConfig & {
      references: ImagesServerConfig['references'] & { storageRootConfigured?: boolean };
    } } }).server.images;
    const { storageRootConfigured: _marker, ...safeReferences } = projected.references;
    const second = await adminFetch('PUT', '/admin/api/server', {
      images: { ...projected, references: safeReferences, enabled: false },
    });
    expect(second.status).toBe(200);
    expect(second.text).not.toContain(storageRoot);

    const persisted = await daemon!.settingsStore.get<OutboundApiServerConfig>(
      OUTBOUND_API_SERVER_CONFIG_KEY,
    );
    expect(persisted?.images?.references.storageRoot).toBe(storageRoot);
    const readBack = await adminFetch('GET', '/admin/api/server');
    expect(readBack.text).not.toContain(storageRoot);
    expect(readBack.json).toMatchObject({
      server: { images: { references: { storageRootConfigured: true } } },
    });
  });

  it('rejects invalid Images-only and mixed patches without changing persisted config', async () => {
    const imageConfigAudit = vi.fn();
    await bootDaemon({ imageConfigAudit });
    const before = await getServer();
    const invalid = enabledImages(before) as unknown as Record<string, unknown>;
    invalid['unknownMember'] = true;
    invalid['account'] = { id: 'one', group: 'two', fallback: 'strict' };

    const response = await adminFetch('PUT', '/admin/api/server', {
      images: invalid,
      voucher: { enabled: true },
    });
    expect(response.status).toBe(400);
    const after = await getServer();
    expect(after.images).toEqual(before.images);
    expect(after.voucher).toEqual(before.voucher);
    expect(imageConfigAudit).not.toHaveBeenCalled();
  });

  it('preserves proxy, webhook, and billing write-only secrets through a mixed Images patch', async () => {
    await bootDaemon();
    const seeded = defaultServerConfig();
    seeded.proxy = {
      global: {
        type: 'http',
        host: 'proxy.example',
        port: 8080,
        password: 'proxy-write-only-sentinel',
      },
    };
    seeded.webhook = {
      enabled: true,
      destinations: [{
        id: 'destination',
        type: 'custom',
        url: 'https://hooks.example.invalid/omnicross',
        secret: 'webhook-write-only-sentinel',
        enabled: true,
      }],
    };
    seeded.billing = {
      enabled: true,
      endpoint: 'https://billing.example.invalid/events',
      secret: 'billing-write-only-sentinel',
      maxRetryAgeMs: 86_400_000,
    };
    await daemon!.settingsStore.set(OUTBOUND_API_SERVER_CONFIG_KEY, seeded);

    const current = await getServer();
    const response = await adminFetch('PUT', '/admin/api/server', {
      images: enabledImages(current),
      voucher: { enabled: true },
    });
    expect(response.status).toBe(200);

    const decrypted = await daemon!.settingsStore.get<OutboundApiServerConfig>(
      OUTBOUND_API_SERVER_CONFIG_KEY,
    );
    expect(decrypted?.proxy?.global && 'password' in decrypted.proxy.global
      ? decrypted.proxy.global.password
      : undefined).toBe('proxy-write-only-sentinel');
    expect(decrypted?.webhook?.destinations[0]?.secret).toBe('webhook-write-only-sentinel');
    expect(decrypted?.billing?.secret).toBe('billing-write-only-sentinel');
    expect(decrypted?.images?.enabled).toBe(true);
    expect(decrypted?.voucher?.enabled).toBe(true);

    const raw = readFileSync(join(tempHome!, 'config.json'), 'utf8');
    expect(raw).not.toContain('proxy-write-only-sentinel');
    expect(raw).not.toContain('webhook-write-only-sentinel');
    expect(raw).not.toContain('billing-write-only-sentinel');
  });

  it('fails closed when remote loading is enabled without the production resolver', async () => {
    await bootDaemon();
    const before = await getServer();
    const images = enabledImages(before);
    images.remote = { enabled: true };
    const response = await adminFetch('PUT', '/admin/api/server', { images });
    expect(response.status).toBe(400);
    expect(response.text).toMatch(/proven composed remote resolver/);
    expect((await getServer()).images?.remote.enabled).toBe(false);
  });

  it('leaves persisted/runtime state unchanged when Images runtime preparation fails', async () => {
    let published = 0;
    const imageConfigAudit = vi.fn();
    await bootDaemon({
      imageRuntimeConfig: {
        prepareConfig: async () => {
          throw new Error('injected runtime prepare failure');
        },
      },
      imageConfigAudit,
    });
    const before = await getServer();
    const beforeBytes = readFileSync(join(tempHome!, 'config.json'));
    const response = await adminFetch('PUT', '/admin/api/server', {
      images: enabledImages(before),
    });
    expect(response.status).toBe(500);
    expect(response.text).toMatch(/failed during prepare/);
    expect(readFileSync(join(tempHome!, 'config.json')).equals(beforeBytes)).toBe(true);
    expect((await getServer()).images).toEqual(before.images);
    expect(published).toBe(0);
    expect(imageConfigAudit).not.toHaveBeenCalled();
  });

  it('disposes a prepared Images runtime when atomic persistence fails', async () => {
    let published = 0;
    let disposed = 0;
    await bootDaemon({
      imageRuntimeConfig: {
        prepareConfig: async () => ({
          publish: () => { published += 1; },
          rollback: () => undefined,
          dispose: () => { disposed += 1; },
        }),
      },
      settingsAtomicReplace: () => {
        throw new Error('injected persistence failure');
      },
    });
    const before = await getServer();
    const response = await adminFetch('PUT', '/admin/api/server', {
      images: enabledImages(before),
    });
    expect(response.status).toBe(500);
    expect(response.text).toMatch(/failed during persist/);
    expect(published).toBe(0);
    expect(disposed).toBe(1);
    expect((await getServer()).images).toEqual(before.images);
  });

  it('restores persisted Images state on injected publication failure', async () => {
    let rollbacks = 0;
    let disposed = 0;
    await bootDaemon({
      imageRuntimeConfig: {
        prepareConfig: async () => ({
          publish: () => {
            throw new Error('injected publish failure');
          },
          rollback: () => { rollbacks += 1; },
          dispose: () => { disposed += 1; },
        }),
      },
    });
    const before = await getServer();
    const response = await adminFetch('PUT', '/admin/api/server', {
      images: enabledImages(before),
    });
    expect(response.status).toBe(500);
    expect(response.text).toMatch(/failed during publish/);
    expect(rollbacks).toBe(1);
    expect(disposed).toBe(1);
    expect((await getServer()).images).toEqual(before.images);
  });

  it('reports rollback failure safely while restoring the prior persisted document', async () => {
    await bootDaemon({
      imageRuntimeConfig: {
        prepareConfig: async () => ({
          publish: () => {
            throw new Error('sensitive publish cause');
          },
          rollback: () => {
            throw new Error('sensitive rollback cause');
          },
          dispose: () => undefined,
        }),
      },
    });
    const before = await getServer();
    const response = await adminFetch('PUT', '/admin/api/server', {
      images: enabledImages(before),
    });
    expect(response.status).toBe(500);
    expect(response.text).toMatch(/rollback was incomplete/);
    expect(response.text).not.toContain('sensitive publish cause');
    expect(response.text).not.toContain('sensitive rollback cause');
    expect((await getServer()).images).toEqual(before.images);
  });

  it('authenticates and projects only narrow Images capability and utilization metadata', async () => {
    const token = 'ADMIN_TOKEN_SENTINEL';
    let unsafeStatusProjection = false;
    const capabilities = {
      available: true,
      models: ['gpt-image-2'],
      generate: true,
      edit: false,
      maskEdit: false,
      maxInputImages: 0,
      maxOutputImages: 1,
      streaming: false,
      maxPartialImages: 0,
      transparentBackground: false,
      flexibleSizes: true,
      outputFormats: ['png'],
      qualityLevels: ['low'],
      moderationModes: ['auto'],
      outputCompression: { supported: false },
      responsesTool: false,
      multiTurnEdit: false,
      supportsFileId: false,
      supportsImageUrl: false,
      resolvedAt: 2_000,
      oldestEvidenceAt: 1_000,
      accountId: 'RAW_ACCOUNT_ID_SENTINEL',
      prompt: 'PROMPT_SENTINEL',
      providerReference: 'PROVIDER_REFERENCE_SENTINEL',
    } as ImageCapabilities;
    const inspectCapability = vi.fn(async () => ({
      generationId: 'image-runtime-2',
      enabled: true,
      available: true,
      providerId: 'codex-subscription' as const,
      model: 'gpt-image-2',
      capabilities,
    }));
    await bootDaemon({
      imageRuntimeStatus: {
        inspectCapability,
        status: () => ({
          disposed: false,
          current: {
            generationId: unsafeStatusProjection
              ? 'PRIVATE_PATH_GENERATION_SENTINEL'
              : 'image-runtime-2',
            enabled: true,
            httpLeases: 0,
            hostedLeases: 0,
          },
          draining: [{
            generationId: unsafeStatusProjection
              ? 'RAW_ACCOUNT_GENERATION_SENTINEL'
              : 'image-runtime-1',
            enabled: true,
            httpLeases: 1,
            hostedLeases: 2,
          }],
        }),
        resourceStatus: () => ({
          queue: {
            activeJobs: 1,
            waitingJobs: 2,
            activeAccounts: 1,
            waitingAccounts: 1,
            waitingTenants: 2,
            maxConcurrentJobsPerAccount: 1,
            maxQueuedJobs: 20,
            accepting: true,
            shuttingDown: false,
          },
          temporary: {
            activeScopes: 1,
            totalBytes: 2_048,
            tenantCount: 1,
            maxActiveScopes: 64,
            maxTotalBytes: 1024 * 1024,
            maxTenantBytes: 512 * 1024,
          },
          storage: {
            mounts: 2,
            retiredMounts: 1,
            referenceEntries: 3,
            referenceBytes: 4_096,
            referenceTombstones: 1,
            stateCalls: 2,
            stateResponses: 1,
            stateTombstones: 1,
            pendingReferenceDeletes: 0,
            maxReferenceEntries: 10_000,
            maxReferenceBytes: 1024 * 1024,
            maxTenantReferenceBytes: 512 * 1024,
            maxStateCalls: 20_000,
            maxStateResponses: 10_000,
          },
        }),
      },
    }, token);

    const unauthorized = await adminFetch('GET', '/admin/api/images/capabilities');
    expect(unauthorized.status).toBe(401);
    expect(inspectCapability).not.toHaveBeenCalled();

    const current = await getServer(token);
    const enabled = await adminFetch('PUT', '/admin/api/server', {
      enabled: true,
      images: enabledImages(current),
    }, token);
    expect(enabled.status).toBe(200);

    const response = await adminFetch(
      'GET',
      '/admin/api/images/capabilities',
      undefined,
      token,
    );
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      configured: {
        enabled: true,
        provider: 'codex-subscription',
        model: 'gpt-image-2',
        remoteUrlsEnabled: false,
      },
      effective: {
        available: true,
        reason: null,
        evidence: { verifiedAt: 1_000, ageMs: 1_000 },
        features: {
          generate: true,
          edit: false,
          outputFormats: ['png'],
          qualityLevels: ['low'],
        },
      },
      runtime: {
        generationId: 'image-runtime-2',
        drainingCount: 1,
        resources: {
          queue: { activeJobs: 1, waitingJobs: 2 },
          temporary: { activeScopes: 1, totalBytes: 2_048 },
          storage: { mounts: 2, retiredMounts: 1, referenceEntries: 3 },
        },
      },
      endpoints: {
        generations: expect.stringMatching(/\/v1\/images\/generations$/),
        edits: expect.stringMatching(/\/v1\/images\/edits$/),
      },
      lanEndpoints: null,
    });
    expect(inspectCapability).toHaveBeenCalledOnce();
    expect(inspectCapability).toHaveBeenCalledWith('admin:image-capability-status');
    for (const sentinel of [
      token,
      'RAW_ACCOUNT_ID_SENTINEL',
      'PROMPT_SENTINEL',
      'PROVIDER_REFERENCE_SENTINEL',
      tempHome!,
    ]) {
      expect(response.text).not.toContain(sentinel);
    }

    inspectCapability.mockResolvedValueOnce({
      generationId: 'PROMPT_GENERATION_SENTINEL',
      enabled: true,
      available: false,
      providerId: 'codex-subscription',
      model: 'gpt-image-2',
      reason: 'PROMPT_REASON_SENTINEL',
    } as never);
    unsafeStatusProjection = true;
    const unsafe = await adminFetch('GET', '/admin/api/images/capabilities', undefined, token);
    expect(unsafe.status).toBe(200);
    expect(unsafe.json).toMatchObject({
      effective: { available: false, reason: 'runtime_unavailable' },
      runtime: {
        generationId: 'image-runtime-unavailable',
        draining: [{ generationId: 'image-runtime-unavailable' }],
      },
    });
    for (const sentinel of [
      'PROMPT_GENERATION_SENTINEL',
      'PROMPT_REASON_SENTINEL',
      'PRIVATE_PATH_GENERATION_SENTINEL',
      'RAW_ACCOUNT_GENERATION_SENTINEL',
    ]) {
      expect(unsafe.text).not.toContain(sentinel);
    }
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import type {
  ImagesServerConfig,
  OutboundApiServerConfig,
  OutboundPermission,
} from '@omnicross/core/outbound-api';

import {
  buildDaemon,
  type Daemon,
  type DaemonPaths,
  resetDaemonSingletonsForTests,
} from '../bootstrap';
import { loadConfig } from '../config';
import {
  createSyntheticVerifiedImageCapture,
  createSyntheticVerifiedImageProviderSeam,
  type SyntheticVerifiedImageBehavior,
  type SyntheticVerifiedImageCapture,
} from './syntheticVerifiedImageProvider';

interface AdminResponse {
  readonly status: number;
  readonly text: string;
  readonly json: unknown;
}

export interface DaemonImageE2eHarness {
  readonly daemon: Daemon;
  readonly capture: SyntheticVerifiedImageCapture;
  readonly tempHome: string;
  readonly configPath: string;
  readonly baseURL: string;
  readonly token: string;
  readonly keyId: string;
  adminFetch(method: string, path: string, body?: unknown): Promise<AdminResponse>;
  close(): Promise<void>;
}

export interface DaemonImageE2eHarnessOptions {
  readonly tempHome?: string;
  readonly initializeConfig?: boolean;
  readonly imagesEnabled?: boolean;
  readonly permissions?: readonly OutboundPermission[] | null;
  readonly existingKey?: { readonly token: string; readonly keyId: string };
  readonly removeTempHomeOnClose?: boolean;
  readonly imageConfigAudit?: DaemonPaths['imageConfigAudit'];
}

export async function createDaemonImageE2eHarness(
  behavior: SyntheticVerifiedImageBehavior = {},
  options: DaemonImageE2eHarnessOptions = {},
): Promise<DaemonImageE2eHarness> {
  resetDaemonSingletonsForTests();
  const tempHome = options.tempHome ??
    mkdtempSync(join(tmpdir(), 'omnicross-daemon-images-e2e-'));
  const configPath = join(tempHome, 'config.json');
  const initializeConfig = options.initializeConfig ?? options.tempHome === undefined;
  if (initializeConfig) {
    writeFileSync(configPath, JSON.stringify({
      providers: [],
      server: { enabled: false, networkBinding: false, port: 0, endpoints: [] },
      admin: { port: 0 },
    }, null, 2), 'utf8');
  }
  const capture = createSyntheticVerifiedImageCapture();
  const daemon = buildDaemon(loadConfig(configPath), {
    configPath,
    keysPath: join(tempHome, 'keys.json'),
    tokensPath: join(tempHome, 'tokens.json'),
    masterKeyFilePath: join(tempHome, 'master.key'),
    testOnlySyntheticVerifiedImageProvider:
      createSyntheticVerifiedImageProviderSeam(capture, behavior),
    ...(options.imageConfigAudit ? { imageConfigAudit: options.imageConfigAudit } : {}),
  });
  const removeTempHomeOnClose = options.removeTempHomeOnClose ?? options.tempHome === undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await daemon.imageCleanupService.stop();
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
    resetDaemonSingletonsForTests();
    if (removeTempHomeOnClose) {
      const temporaryRoot = resolve(tmpdir());
      const resolvedHome = resolve(tempHome);
      const relativeHome = relative(temporaryRoot, resolvedHome);
      if (
        !relativeHome ||
        relativeHome.startsWith('..') ||
        isAbsolute(relativeHome) ||
        !basename(resolvedHome).startsWith('omnicross-daemon-images-e2e-')
      ) {
        throw new Error('refused to remove an unverified daemon Images E2E directory');
      }
      rmSync(resolvedHome, { recursive: true, force: true });
    }
  };

  try {
    await daemon.llmConfig.ready();
    await daemon.imageCleanupService.runOnce();
    daemon.imageCleanupService.start();
    await daemon.adminServer.start();
    const adminBase = daemon.adminServer.getStatus().url as string;
    const adminFetch = async (
      method: string,
      path: string,
      body?: unknown,
    ): Promise<AdminResponse> => {
      const response = await fetch(`${adminBase}${path}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, text, json: text ? JSON.parse(text) : null };
    };

    const currentResponse = await adminFetch('GET', '/admin/api/server');
    if (currentResponse.status !== 200) throw new Error('failed to read initial server config');
    const current = (currentResponse.json as { server: OutboundApiServerConfig }).server;
    const images: ImagesServerConfig = {
      ...current.images!,
      enabled: options.imagesEnabled ?? true,
    };
    const enabled = await adminFetch('PUT', '/admin/api/server', {
      enabled: true,
      images,
    });
    if (enabled.status !== 200) throw new Error('failed to enable synthetic Images runtime');

    let token: string;
    let keyId: string;
    if (options.existingKey) {
      token = options.existingKey.token;
      keyId = options.existingKey.keyId;
    } else {
      const created = await adminFetch('POST', '/admin/api/keys', { name: 'tier-a-images' });
      if (created.status !== 201) throw new Error('failed to create Tier-A Images key');
      const createdKey = created.json as { id: string; plaintextOnce: string };
      token = createdKey.plaintextOnce;
      keyId = createdKey.id;
      const permissions = options.permissions === undefined ? ['images'] : options.permissions;
      if (permissions !== null) {
        const permitted = await adminFetch(
          'POST',
          `/admin/api/keys/${encodeURIComponent(keyId)}/permissions`,
          { permissions },
        );
        if (permitted.status !== 200) throw new Error('failed to set Tier-A Images permissions');
      }
    }

    const status = await adminFetch('GET', '/admin/api/status');
    const loopbackUrl = (status.json as { loopbackUrl?: string }).loopbackUrl;
    if (status.status !== 200 || !loopbackUrl) throw new Error('Images listener did not bind');
    return {
      daemon,
      capture,
      tempHome,
      configPath,
      baseURL: `${loopbackUrl}/v1`,
      token,
      keyId,
      adminFetch,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

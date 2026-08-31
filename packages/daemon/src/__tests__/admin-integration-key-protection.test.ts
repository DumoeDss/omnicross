import { EventEmitter } from 'node:events';
import type http from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { handleAdminApi, type AdminApiDeps } from '../admin/adminApi';
import type { IntegrationManager } from '../integrations';

class Req extends EventEmitter {
  headers = {};
  url: string;
  constructor(readonly method: string, url: string, private readonly body = '') {
    super();
    this.url = url;
  }
  start(): void {
    process.nextTick(() => {
      if (this.body) this.emit('data', Buffer.from(this.body));
      this.emit('end');
    });
  }
}

class Res {
  statusCode = 0;
  body = '';
  writeHead(status: number): this { this.statusCode = status; return this; }
  end(chunk?: string): void { if (chunk) this.body += chunk; }
}

function fixture() {
  const row = {
    id: 'bound-key',
    name: 'Bound key',
    keyHash: 'hash',
    keyPrefix: 'sk-omnicross-',
    enabled: true,
    createdAt: 1,
    lastUsedAt: null,
    revokedAt: null,
    allowedEndpoints: ['responses', 'images'] as const,
  };
  const keyDb = {
    outboundApiKeysList: vi.fn(async () => [row]),
    outboundApiKeysRevoke: vi.fn(async () => true),
    outboundApiKeysDelete: vi.fn(async () => true),
    outboundApiKeysSetEnabled: vi.fn(async () => true),
    outboundApiKeysSetPermissions: vi.fn(async () => true),
  };
  const manager = {
    listStatus: vi.fn(async () => [{
      client: 'codex' as const,
      status: 'enabled' as const,
      configPath: 'config.toml',
      key: {
        id: row.id,
        name: row.name,
        keyPrefix: row.keyPrefix,
        ownership: 'selected' as const,
        revealable: true,
        enabled: true,
        revoked: false,
        allowedEndpoints: ['responses', 'images'] as const,
        requiredEndpoints: ['responses', 'images'] as const,
        loopbackOnly: false,
      },
    }]),
  };
  const deps = {
    keyDb,
    integrationManagerFactory: () => manager as unknown as IntegrationManager,
  } as unknown as AdminApiDeps;
  return { deps, keyDb };
}

async function call(deps: AdminApiDeps, method: string, path: string, body?: unknown) {
  const req = new Req(method, path, body === undefined ? '' : JSON.stringify(body));
  const res = new Res();
  req.start();
  await handleAdminApi(
    req as unknown as http.IncomingMessage,
    res as unknown as http.ServerResponse,
    path,
    deps,
  );
  return res;
}

describe('bound integration key protections', () => {
  it.each([
    ['POST', '/admin/api/keys/bound-key/revoke', undefined, 'outboundApiKeysRevoke'],
    ['DELETE', '/admin/api/keys/bound-key', undefined, 'outboundApiKeysDelete'],
    ['POST', '/admin/api/keys/bound-key/enabled', { enabled: false }, 'outboundApiKeysSetEnabled'],
  ] as const)('blocks %s %s', async (method, path, body, mutation) => {
    const { deps, keyDb } = fixture();
    const result = await call(deps, method, path, body);
    expect(result.statusCode).toBe(409);
    expect(keyDb[mutation]).not.toHaveBeenCalled();
  });

  it('blocks removal of a required permission but allows additive changes', async () => {
    const blocked = fixture();
    expect((await call(blocked.deps, 'POST', '/admin/api/keys/bound-key/permissions', {
      permissions: ['responses'],
    })).statusCode).toBe(409);
    expect(blocked.keyDb.outboundApiKeysSetPermissions).not.toHaveBeenCalled();

    const allowed = fixture();
    expect((await call(allowed.deps, 'POST', '/admin/api/keys/bound-key/permissions', {
      permissions: ['responses', 'images', 'messages'],
    })).statusCode).toBe(200);
    expect(allowed.keyDb.outboundApiKeysSetPermissions).toHaveBeenCalledWith(
      'bound-key',
      ['responses', 'images', 'messages'],
    );
  });
});

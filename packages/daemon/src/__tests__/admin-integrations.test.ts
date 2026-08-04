import { EventEmitter } from 'node:events';
import type http from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { handleAdminApi, type AdminApiDeps } from '../admin/adminApi';
import { IntegrationConflictError, type IntegrationManager } from '../integrations';

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

function deps(manager: Partial<IntegrationManager>): AdminApiDeps {
  return {
    integrationManagerFactory: () => manager as IntegrationManager,
    outboundApiServer: {
      getStatus: () => ({ running: true, port: 8765, loopbackUrl: 'http://127.0.0.1:8765',
        lanUrl: null, formats: null, lanFormats: null }),
    },
  } as unknown as AdminApiDeps;
}

async function call(
  manager: Partial<IntegrationManager>, method: string, path: string, body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const req = new Req(method, path, body === undefined ? '' : JSON.stringify(body));
  const res = new Res();
  req.start();
  await handleAdminApi(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse,
    path, deps(manager));
  return { status: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown>, text: res.body };
}

describe('admin native integrations routes', () => {
  it('lists token-free status and installs a selected client', async () => {
    const status = { client: 'codex' as const, status: 'enabled' as const,
      configPath: 'C:\\Users\\test\\.codex\\config.toml' };
    const manager = {
      listStatus: vi.fn(async () => [status]),
      install: vi.fn(async () => status),
    };
    const listed = await call(manager, 'GET', '/admin/api/integrations');
    expect(listed.status).toBe(200);
    expect(listed.text).not.toContain('sk-omnicross-');

    const installed = await call(manager, 'POST', '/admin/api/integrations/codex/install',
      { configPath: 'D:\\codex\\config.toml' });
    expect(installed.status).toBe(200);
    expect(manager.install).toHaveBeenCalledWith('codex', 'D:\\codex\\config.toml');
  });

  it('maps drift conflicts to 409 instead of overwriting', async () => {
    const manager = {
      remove: vi.fn(async () => { throw new IntegrationConflictError('configuration drift'); }),
    };
    const result = await call(manager, 'DELETE', '/admin/api/integrations/claude');
    expect(result.status).toBe(409);
    expect(result.text).toContain('configuration drift');
  });
});

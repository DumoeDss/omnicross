import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../adminClient', () => ({
  adminClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import { adminClient } from '../adminClient';
import { createCliAdapter } from '../cliAdapter';

import type { CliIntegrationsOverview } from '../types';

const mocked = vi.mocked(adminClient);

const OVERVIEW: CliIntegrationsOverview = {
  integrations: [
    { client: 'codex', status: 'enabled', configPath: 'C:\\Users\\test\\.codex\\config.toml' },
    { client: 'claude', status: 'not-installed', configPath: 'C:\\Users\\test\\.claude\\settings.json' },
  ],
  gateway: {
    running: true,
    port: 8765,
    loopbackUrl: 'http://127.0.0.1:8765',
    lanUrl: null,
    formats: null,
    lanFormats: null,
    endpoints: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CLI persistent integration adapter', () => {
  it('loads the secret-free integration overview', async () => {
    mocked.get.mockResolvedValueOnce(OVERVIEW);

    const result = await createCliAdapter().getIntegrations();

    expect(mocked.get).toHaveBeenCalledWith('/integrations');
    expect(result).toEqual({ success: true, overview: OVERVIEW });
    expect(JSON.stringify(result)).not.toContain('plaintextOnce');
  });

  it('installs using the default path when the input is blank', async () => {
    mocked.post.mockResolvedValueOnce({ integration: OVERVIEW.integrations[0] });

    const result = await createCliAdapter().installIntegration('codex', { configPath: '   ' });

    expect(mocked.post).toHaveBeenCalledWith('/integrations/codex/install', {});
    expect(result).toEqual({ success: true });
  });

  it('trims and sends an explicit configuration path', async () => {
    mocked.post.mockResolvedValueOnce({ integration: OVERVIEW.integrations[1] });

    await createCliAdapter().installIntegration('claude', { configPath: ' D:\\claude\\settings.json ' });

    expect(mocked.post).toHaveBeenCalledWith('/integrations/claude/install', {
      configPath: 'D:\\claude\\settings.json',
    });
  });

  it('previews only the redacted logical change plan before installation', async () => {
    const plan = {
      client: 'codex' as const,
      configPath: 'C:\\Users\\test\\.codex\\config.toml',
      action: 'install' as const,
      canApply: true,
      changes: [
        'model_provider',
        'model_providers.omnicross',
        'model_providers.omnicross.auth',
      ],
      warnings: [],
    };
    mocked.post.mockResolvedValueOnce({ plan });

    const result = await createCliAdapter().planIntegration('codex');

    expect(mocked.post).toHaveBeenCalledWith('/integrations/codex/plan', {});
    expect(result).toEqual({ success: true, plan });
    expect(JSON.stringify(result)).not.toContain('fileContent');
    expect(JSON.stringify(result)).not.toContain('plaintextOnce');
  });

  it('maps removal and shared-key rotation to their dedicated routes', async () => {
    mocked.delete.mockResolvedValueOnce({ integration: OVERVIEW.integrations[1] });
    mocked.post.mockResolvedValueOnce({ ok: true, integrations: OVERVIEW.integrations });
    const adapter = createCliAdapter();

    expect(await adapter.removeIntegration('claude')).toEqual({ success: true });
    expect(await adapter.rotateIntegrationKey()).toEqual({ success: true });

    expect(mocked.delete).toHaveBeenCalledWith('/integrations/claude');
    expect(mocked.post).toHaveBeenCalledWith('/integrations/rotate', {});
  });

  it('uses the dedicated reconciliation route for repair', async () => {
    mocked.post.mockResolvedValueOnce({ integration: OVERVIEW.integrations[0] });

    expect(await createCliAdapter().repairIntegration('codex')).toEqual({ success: true });
    expect(mocked.post).toHaveBeenCalledWith('/integrations/codex/repair', {});
  });

  it('binds an access key by id without sending plaintext', async () => {
    mocked.post.mockResolvedValueOnce({ integration: OVERVIEW.integrations[0] });

    expect(await createCliAdapter().bindIntegrationKey('codex', 'oak_123')).toEqual({ success: true });
    expect(mocked.post).toHaveBeenCalledWith('/integrations/codex/key', { keyId: 'oak_123' });
    expect(JSON.stringify(mocked.post.mock.calls)).not.toContain('sk-omnicross-');
  });

  it('surfaces conflict errors without claiming success', async () => {
    mocked.delete.mockRejectedValueOnce(new Error('configuration changed; refusing to overwrite'));

    const result = await createCliAdapter().removeIntegration('codex');

    expect(result).toEqual({ success: false, message: 'configuration changed; refusing to overwrite' });
  });
});

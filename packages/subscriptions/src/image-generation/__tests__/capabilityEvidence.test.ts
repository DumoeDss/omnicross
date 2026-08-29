import { describe, expect, it, vi } from 'vitest';

import type { AuthStrategy } from '../../auth';
import { createCodexSubscriptionImageProvider } from '../CodexSubscriptionImageProvider';
import { UnknownCodexImageCapabilityEvidenceSource } from '../capabilityEvidence';

function auth(): AuthStrategy {
  return {
    kind: 'oauth-bearer',
    providerId: 'codex',
    async applyHeaders(headers, hints) {
      headers.Authorization = 'Bearer subscription-token';
      hints?.reportSelection?.('account-internal-id', true);
    },
    async onUnauthorized() { return false; },
    async describeStatus() { return { providerId: 'codex', ok: true }; },
  };
}

describe('Codex image capability evidence', () => {
  it('returns unknown account/protocol evidence by default', async () => {
    const source = new UnknownCodexImageCapabilityEvidenceSource();
    const evidence = await source.resolve({
      accountId: 'account-internal-id',
      signal: new AbortController().signal,
    });
    expect(evidence.account.values).toBeUndefined();
    expect(evidence.upstream.values).toBeUndefined();
  });

  it('does not upgrade from text success, config toggles, or a gpt-image-2 name', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = createCodexSubscriptionImageProvider({ authStrategy: auth(), now: () => 1_000 });
    const lease = await provider.acquire({
      requestId: 'text-responses-succeeded',
      tenantId: 'images-enabled-config-toggle',
      sessionKey: 'gpt-image-2',
      signal: new AbortController().signal,
    });
    expect(lease.capabilities).toMatchObject({
      available: false,
      reason: 'account_unverified',
      streaming: false,
      transparentBackground: false,
    });
    expect(() => lease.start({
      action: 'generate', model: 'gpt-image-2', prompt: 'not dispatched', n: 1,
      quality: 'auto', size: { kind: 'auto' }, background: 'auto', outputFormat: 'png',
      moderation: 'auto', stream: false, partialImages: 0,
    })).toThrow(/capability/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    await lease.release();
    fetchSpy.mockRestore();
  });
});

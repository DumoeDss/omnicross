/**
 * Unit tests for `resolveSubscriptionChain` — the shared subscription
 * provider-chain resolver (cross-vendor route-to, task #29).
 *
 * Proves the Responses ingress no longer hard-codes `[openai-response]` but
 * builds the chain from the profile's OWN `providerTransformerNames`:
 *   - codex profile `['openai-response']`  → the openai-response transformer
 *   - opencodego profile `['opencodego']`  → the opencodego transformer (NOT
 *                                             openai-response — the cross-vendor
 *                                             generalization)
 *   - empty/missing names                  → fallback endpoint (codex byte-identity)
 *   - declared-but-no-registry             → throws (fail loud, not mis-route)
 *   - all names unresolvable               → fallback endpoint
 *
 * @module pipeline/__tests__/resolveSubscriptionChain.test
 */

import { describe, expect, it } from 'vitest';

import { OpenAIResponseTransformer } from '../../transformer/transformers/OpenAIResponseTransformer';
import { OpenCodeGoTransformer } from '../../transformer/transformers/OpenCodeGoTransformer';
import { TransformerService } from '../../transformer/TransformerService';
import { resolveSubscriptionChain } from '../resolveSubscriptionChain';
import type { SubscriptionAuthProfile } from '../SubscriptionAuthSource';

function makeService(): TransformerService {
  const svc = new TransformerService();
  svc.registerTransformer('openai-response', OpenAIResponseTransformer);
  svc.registerTransformer('opencodego', OpenCodeGoTransformer);
  return svc;
}

/** A profile is structurally `{ authStrategy, resolveUpstreamUrl, *TransformerNames }`;
 *  resolveSubscriptionChain only reads the transformer-name fields. */
function profile(names?: readonly string[], modelNames?: readonly string[]): SubscriptionAuthProfile {
  return {
    authStrategy: {} as never,
    providerTransformerNames: names,
    modelTransformerNames: modelNames,
  };
}

describe('resolveSubscriptionChain', () => {
  const fallback = new OpenAIResponseTransformer();

  it('resolves the codex profile chain to the openai-response transformer', () => {
    const chain = resolveSubscriptionChain(profile(['openai-response']), makeService(), fallback);
    expect(chain.providerTransformers).toHaveLength(1);
    expect(chain.providerTransformers[0]).toBeInstanceOf(OpenAIResponseTransformer);
    expect(chain.modelTransformers).toHaveLength(0);
  });

  it('resolves a cross-vendor (opencodego) profile chain to the opencodego transformer (NOT openai-response)', () => {
    const chain = resolveSubscriptionChain(profile(['opencodego']), makeService(), fallback);
    expect(chain.providerTransformers).toHaveLength(1);
    expect(chain.providerTransformers[0]).toBeInstanceOf(OpenCodeGoTransformer);
    expect(chain.providerTransformers[0]).not.toBeInstanceOf(OpenAIResponseTransformer);
  });

  it('falls back to the endpoint transformer when the profile declares NO names (codex byte-identity)', () => {
    const chain = resolveSubscriptionChain(profile(undefined), makeService(), fallback);
    expect(chain.providerTransformers).toEqual([fallback]);
    expect(chain.modelTransformers).toHaveLength(0);
  });

  it('falls back to the endpoint transformer for an empty names array', () => {
    const chain = resolveSubscriptionChain(profile([]), makeService(), fallback);
    expect(chain.providerTransformers).toEqual([fallback]);
  });

  it('throws when names are declared but no TransformerService is wired (fail loud, not mis-route)', () => {
    expect(() => resolveSubscriptionChain(profile(['opencodego']), undefined, fallback)).toThrow(
      /no TransformerService/,
    );
  });

  it('falls back to the endpoint transformer when every declared name is unregistered', () => {
    const empty = new TransformerService();
    const chain = resolveSubscriptionChain(profile(['nonexistent']), empty, fallback);
    expect(chain.providerTransformers).toEqual([fallback]);
  });

  it('resolves model transformers too when declared', () => {
    const chain = resolveSubscriptionChain(profile(['opencodego'], ['openai-response']), makeService(), fallback);
    expect(chain.providerTransformers[0]).toBeInstanceOf(OpenCodeGoTransformer);
    expect(chain.modelTransformers).toHaveLength(1);
    expect(chain.modelTransformers[0]).toBeInstanceOf(OpenAIResponseTransformer);
  });
});

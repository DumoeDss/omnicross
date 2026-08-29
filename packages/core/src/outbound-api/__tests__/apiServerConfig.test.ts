/**
 * Unit tests for outbound API server config default / normalize / merge
 * (`outbound-api-server`, model-kind-mapping contract). The persisted shape is
 * heterogeneous by endpoint class and there is NO legacy migration — normalize
 * drops legacy/unknown fields (incl. `visionModel`) and fills blanks.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ACCOUNT_PROBE,
  DEFAULT_ALLOWANCE_SCHEDULING,
  DEFAULT_ANTHROPIC_SEGMENT,
  DEFAULT_CONCURRENCY_QUEUE,
  DEFAULT_USER_MESSAGE_QUEUE,
  defaultServerConfig,
  mergeServerConfig,
  normalizeAccountProbe,
  normalizeAllowanceScheduling,
  normalizeAnthropicSegment,
  normalizeEndpointConfig,
  normalizeServerConfig,
} from '../apiServerConfig';
import type { EndpointRoutingConfig, OutboundApiServerConfig, OutboundEndpoint } from '../types';

function endpoint(
  config: OutboundApiServerConfig,
  ep: OutboundEndpoint,
): EndpointRoutingConfig {
  const found = config.endpoints.find((e) => e.endpoint === ep);
  if (!found) throw new Error(`missing endpoint ${ep}`);
  return found;
}

/**
 * Normalize ONE raw endpoint block. `normalizeServerConfig` no longer keeps
 * these blocks (routing moved to downstream routes), but the per-endpoint-class
 * normalization still runs — it is the shape every route carries.
 */
function normalizedBlock(
  raw: Partial<OutboundApiServerConfig>,
  ep: OutboundEndpoint,
): EndpointRoutingConfig {
  const found = raw.endpoints?.find((e) => e.endpoint === ep);
  if (!found) throw new Error(`missing endpoint ${ep}`);
  return normalizeEndpointConfig(found);
}

describe('defaultServerConfig — endpoint-aware blanks', () => {
  it('kind-mapped endpoints carry a blank declared-kind modelMap and no default/background', () => {
    const config = defaultServerConfig();
    const messages = endpoint(config, 'messages');
    expect(messages.modelMap).toEqual({ fable: '', opus: '', sonnet: '', haiku: '' });
    expect(messages).not.toHaveProperty('defaultModel');
    expect(messages).not.toHaveProperty('backgroundModel');
    expect(messages).not.toHaveProperty('visionModel');

    const responses = endpoint(config, 'responses');
    expect(responses.modelMap).toEqual({ codex: '', mini: '' });
  });

  it('the list-mapped chat endpoint carries an empty models list only', () => {
    const config = defaultServerConfig();
    const chat = endpoint(config, 'chat');
    expect(chat.models).toEqual([]);
    expect(chat).not.toHaveProperty('defaultModel');
    expect(chat).not.toHaveProperty('backgroundModel');
    expect(chat).not.toHaveProperty('modelMap');
    expect(chat).not.toHaveProperty('visionModel');
  });

  it('the role-based gemini endpoint carries blank default/background and no modelMap', () => {
    const config = defaultServerConfig();
    const gemini = endpoint(config, 'gemini');
    expect(gemini.defaultModel).toBe('');
    expect(gemini.backgroundModel).toBe('');
    expect(gemini).not.toHaveProperty('modelMap');
    expect(gemini).not.toHaveProperty('visionModel');
  });

  it('is disabled, loopback, four endpoints', () => {
    const config = defaultServerConfig();
    expect(config.enabled).toBe(false);
    expect(config.networkBinding).toBe(false);
    expect(config.endpoints).toHaveLength(4);
  });
});

describe('normalizeServerConfig — no migration', () => {
  it('drops legacy visionModel and legacy default/background on a kind-mapped endpoint WITHOUT remap', () => {
    const raw = {
      enabled: true,
      networkBinding: false,
      endpoints: [
        {
          endpoint: 'messages',
          // legacy role-based fields that must be DROPPED (no remap into a kind)
          defaultModel: 'legacy-provider,legacy-default',
          backgroundModel: 'legacy-provider,legacy-bg',
          visionModel: 'legacy-provider,legacy-vision',
          useSubscription: true,
        },
      ],
    } as unknown as Partial<OutboundApiServerConfig>;

    const messages = normalizedBlock(raw, 'messages');
    // filled blank kinds, NOT the legacy default/background values
    expect(messages.modelMap).toEqual({ fable: '', opus: '', sonnet: '', haiku: '' });
    expect(messages).not.toHaveProperty('defaultModel');
    expect(messages).not.toHaveProperty('backgroundModel');
    expect(messages).not.toHaveProperty('visionModel');
    expect(messages.useSubscription).toBe(true);
  });

  it('drops unknown kind keys and coerces non-string refs to blank on a kind-mapped endpoint', () => {
    const raw = {
      endpoints: [
        {
          endpoint: 'messages',
          modelMap: { opus: 'p,opus', bogus: 'x', haiku: 42 },
          useSubscription: false,
        },
      ],
    } as unknown as Partial<OutboundApiServerConfig>;

    const messages = normalizedBlock(raw, 'messages');
    expect(messages.modelMap).toEqual({ fable: '', opus: 'p,opus', sonnet: '', haiku: '' });
    expect(messages.modelMap).not.toHaveProperty('bogus');
  });

  it('drops modelMap and keeps default/background (+ array backgroundModelIds) on the role-based gemini endpoint', () => {
    const raw = {
      endpoints: [
        {
          endpoint: 'gemini',
          defaultModel: 'p,default',
          backgroundModel: 'p,bg',
          backgroundModelIds: ['p,small'],
          // stray modelMap on a role-based endpoint must be dropped
          modelMap: { opus: 'nope' },
          useSubscription: false,
        },
      ],
    } as unknown as Partial<OutboundApiServerConfig>;

    const gemini = normalizedBlock(raw, 'gemini');
    expect(gemini.defaultModel).toBe('p,default');
    expect(gemini.backgroundModel).toBe('p,bg');
    expect(gemini.backgroundModelIds).toEqual(['p,small']);
    expect(gemini).not.toHaveProperty('modelMap');
  });

  it('chat keeps only string list entries and drops legacy role fields (no migration)', () => {
    const raw = {
      endpoints: [
        {
          endpoint: 'chat',
          models: ['p,gpt-4o', '', 42, 'p,glm-4.7'],
          // legacy role-based fields must be DROPPED (no remap into the list)
          defaultModel: 'p,default',
          backgroundModel: 'p,bg',
          backgroundModelIds: ['p,small'],
          useSubscription: false,
        },
      ],
    } as unknown as Partial<OutboundApiServerConfig>;

    const chat = normalizedBlock(raw, 'chat');
    expect(chat.models).toEqual(['p,gpt-4o', 'p,glm-4.7']);
    expect(chat).not.toHaveProperty('defaultModel');
    expect(chat).not.toHaveProperty('backgroundModel');
    expect(chat).not.toHaveProperty('backgroundModelIds');
  });

  it('migrates a bound endpoint without policy to strict failure and round-trips pool opt-in', () => {
    const strict = normalizedBlock({
      endpoints: [
        {
          endpoint: 'messages',
          modelMap: { opus: 'claude,claude-opus' },
          useSubscription: true,
          boundAccountId: ' acct-strict ',
        },
      ],
    } as unknown as Partial<OutboundApiServerConfig>, 'messages');
    expect(strict.boundAccountId).toBe('acct-strict');
    expect(strict.boundAccountFallbackPolicy).toBe('strict');

    const pool = normalizedBlock({
      endpoints: [
        {
          endpoint: 'messages',
          useSubscription: true,
          boundAccountId: 'acct-pool',
          boundAccountFallbackPolicy: 'pool',
        },
      ],
    } as unknown as Partial<OutboundApiServerConfig>, 'messages');
    expect(pool.boundAccountFallbackPolicy).toBe('pool');
  });

  it('drops a policy when the binding is blank and rejects invalid policy values to strict', () => {
    const raw = {
      endpoints: [
        {
          endpoint: 'messages',
          useSubscription: true,
          boundAccountId: '   ',
          boundAccountFallbackPolicy: 'pool',
        },
        {
          endpoint: 'responses',
          useSubscription: true,
          boundAccountId: 'acct-1',
          boundAccountFallbackPolicy: 'unexpected',
        },
      ],
    } as unknown as Partial<OutboundApiServerConfig>;
    expect(normalizedBlock(raw, 'messages')).not.toHaveProperty('boundAccountFallbackPolicy');
    expect(normalizedBlock(raw, 'responses').boundAccountFallbackPolicy).toBe('strict');
  });

  it('projects a configured legacy endpoint into a downstream route and blanks the block', () => {
    const config = normalizeServerConfig({
      endpoints: [
        {
          endpoint: 'messages',
          modelMap: { opus: 'claude,claude-opus', sonnet: 'glm,glm-4.7' },
          useSubscription: true,
        },
      ],
    } as unknown as Partial<OutboundApiServerConfig>);

    // The legacy block is no longer a routing source.
    expect(endpoint(config, 'messages').modelMap).toEqual({ fable: '', opus: '', sonnet: '', haiku: '' });
    // One route per referenced provider, since a route carries a single target.
    expect(config.bindings?.map((b) => b.target)).toEqual([
      { kind: 'account-pool', providerId: 'claude' },
      { kind: 'account-pool', providerId: 'glm' },
    ]);
    expect(config.bindings?.[0].modelMap).toMatchObject({ opus: 'claude,claude-opus', sonnet: '' });
    expect(config.bindings?.[1].modelMap).toMatchObject({ opus: '', sonnet: 'glm,glm-4.7' });

    // Idempotent: re-normalizing the migrated config produces no new routes.
    expect(normalizeServerConfig(config).bindings).toEqual(config.bindings);
  });

  it('does not resurrect legacy endpoints once routes exist', () => {
    const config = normalizeServerConfig({
      endpoints: [
        { endpoint: 'chat', models: ['openai,gpt-4o'], useSubscription: false },
      ],
      bindings: [],
      // A user who deleted every route keeps zero routes.
    } as unknown as Partial<OutboundApiServerConfig>);
    expect(config.bindings).toHaveLength(1);
    expect(normalizeServerConfig({ ...config, bindings: [] }).bindings).toEqual([]);
  });

  it('missing/blank raw → full default shape', () => {
    expect(normalizeServerConfig(undefined)).toEqual(defaultServerConfig());
    expect(normalizeServerConfig(null)).toEqual(defaultServerConfig());
  });
});

describe('mergeServerConfig', () => {
  it('round-trips through normalize and applies the patch', () => {
    const current = defaultServerConfig();
    const merged = mergeServerConfig(current, { enabled: true, networkBinding: true });
    expect(merged.enabled).toBe(true);
    expect(merged.networkBinding).toBe(true);
    // endpoints preserved in the normalized heterogeneous shape
    expect(endpoint(merged, 'messages').modelMap).toEqual({
      fable: '',
      opus: '',
      sonnet: '',
      haiku: '',
    });
    expect(endpoint(merged, 'chat').models).toEqual([]);
    expect(endpoint(merged, 'gemini').defaultModel).toBe('');
  });

  it('a patched legacy endpoint is projected into a route, not kept as a block', () => {
    const current = defaultServerConfig();
    const patchedEndpoints = [
      {
        endpoint: 'messages',
        modelMap: { opus: 'p,opus' },
        visionModel: 'legacy',
        useSubscription: false,
      },
    ] as unknown as EndpointRoutingConfig[];
    const merged = mergeServerConfig(current, { endpoints: patchedEndpoints });
    expect(endpoint(merged, 'messages').modelMap).toEqual({ fable: '', opus: '', sonnet: '', haiku: '' });

    const route = merged.bindings?.[0];
    expect(route?.target).toEqual({ kind: 'provider', providerId: 'p' });
    expect(route?.modelMap).toEqual({ fable: '', opus: 'p,opus', sonnet: '', haiku: '' });
    expect(route).not.toHaveProperty('visionModel');
  });

  it('carries the accountProbe segment through a patch', () => {
    const current = defaultServerConfig();
    const merged = mergeServerConfig(current, {
      accountProbe: { ...DEFAULT_ACCOUNT_PROBE, enabled: true, intervalMs: 120_000 },
    });
    expect(merged.accountProbe).toEqual({ ...DEFAULT_ACCOUNT_PROBE, enabled: true, intervalMs: 120_000 });
  });
});

describe('normalizeAccountProbe (subscription-account-probe #8)', () => {
  it('defaults OFF with the frozen conservative cadence', () => {
    expect(normalizeAccountProbe(undefined)).toEqual(DEFAULT_ACCOUNT_PROBE);
    expect(defaultServerConfig().accountProbe).toEqual(DEFAULT_ACCOUNT_PROBE);
    expect(DEFAULT_ACCOUNT_PROBE.enabled).toBe(false);
  });

  it('clamps out-of-range knobs to their bounds', () => {
    const probe = normalizeAccountProbe({
      accountProbe: {
        enabled: true,
        intervalMs: 1, // below 60_000 floor
        onlyMultiAccount: false,
        timeoutMs: 999_999, // above 60_000 ceiling
        historySize: 0, // below 1 floor
        staggerMs: -5, // below 0 floor
      },
    });
    expect(probe).toEqual({
      enabled: true,
      intervalMs: 60_000,
      onlyMultiAccount: false,
      timeoutMs: 60_000,
      historySize: 1,
      staggerMs: 0,
    });
  });

  it('onlyMultiAccount defaults true; enabled coerces to a strict boolean', () => {
    const probe = normalizeAccountProbe({
      accountProbe: { enabled: 'yes' } as unknown as (typeof DEFAULT_ACCOUNT_PROBE),
    });
    expect(probe.enabled).toBe(false); // non-true ⇒ false
    expect(probe.onlyMultiAccount).toBe(true); // absent ⇒ true
  });
});

describe('normalizeAllowanceScheduling', () => {
  it('defaults OFF and is included in the persisted server shape', () => {
    expect(normalizeAllowanceScheduling(undefined)).toEqual(DEFAULT_ALLOWANCE_SCHEDULING);
    expect(defaultServerConfig().allowanceScheduling).toEqual(DEFAULT_ALLOWANCE_SCHEDULING);
    expect(DEFAULT_ALLOWANCE_SCHEDULING.enabled).toBe(false);
  });

  it('clamps thresholds and never lets pause precede demotion', () => {
    expect(normalizeAllowanceScheduling({
      allowanceScheduling: {
        enabled: true,
        demoteAtPercent: 90,
        pauseAtPercent: 50,
        priorityPenalty: 9_999,
      },
    })).toEqual({
      enabled: true,
      demoteAtPercent: 90,
      pauseAtPercent: 90,
      priorityPenalty: 1_000,
    });
  });

  it('coerces enabled strictly and restores invalid numeric values', () => {
    expect(normalizeAllowanceScheduling({
      allowanceScheduling: {
        enabled: 'yes',
        demoteAtPercent: Number.NaN,
        pauseAtPercent: Number.POSITIVE_INFINITY,
        priorityPenalty: 0,
      } as unknown as typeof DEFAULT_ALLOWANCE_SCHEDULING,
    })).toEqual({ ...DEFAULT_ALLOWANCE_SCHEDULING, priorityPenalty: 1 });
  });
});

describe('anthropic segment (claude-api-protocol-fidelity, §10)', () => {
  it('defaults: auto count_tokens (2000ms budget), auto models shape, 20000ms heartbeat, 2000ms pdf budget, proxy off, hello on', () => {
    expect(normalizeAnthropicSegment(undefined)).toEqual({
      countTokens: { mode: 'auto', estimateBudgetMs: 2000 },
      modelsShape: 'auto',
      heartbeatIntervalMs: 20_000,
      pdfTextExtraction: { budgetMs: 2000 },
      proxyOauthUsage: false,
      apiHello: true,
    });
    expect(defaultServerConfig().anthropic).toEqual(DEFAULT_ANTHROPIC_SEGMENT);
    expect(normalizeServerConfig(null).anthropic).toEqual(DEFAULT_ANTHROPIC_SEGMENT);
  });

  it('accepts valid values and clamps the numeric knobs', () => {
    expect(
      normalizeAnthropicSegment({
        anthropic: {
          countTokens: { mode: 'estimate', estimateBudgetMs: 999_999 },
          modelsShape: 'openai',
          heartbeatIntervalMs: 0,
          pdfTextExtraction: { budgetMs: 999_999 },
        },
      }),
    ).toEqual({
      countTokens: { mode: 'estimate', estimateBudgetMs: 60_000 },
      modelsShape: 'openai',
      heartbeatIntervalMs: 0, // ≤0 is a legal "disabled" value
      pdfTextExtraction: { budgetMs: 60_000 },
      proxyOauthUsage: false,
      apiHello: true,
    });
  });

  it('proxyOauthUsage/apiHello accept booleans (hello false is honored)', () => {
    expect(
      normalizeAnthropicSegment({
        anthropic: { proxyOauthUsage: true, apiHello: false },
      }),
    ).toMatchObject({ proxyOauthUsage: true, apiHello: false });
  });

  it('falls back to defaults on unknown enum values / junk numbers', () => {
    expect(
      normalizeAnthropicSegment({
        anthropic: {
          countTokens: { mode: 'sometimes', estimateBudgetMs: Number.NaN },
          modelsShape: 'xml',
          heartbeatIntervalMs: Number.NaN,
        } as unknown as never,
      }),
    ).toEqual(DEFAULT_ANTHROPIC_SEGMENT);
  });

  it('mergeServerConfig keeps the current segment when the patch omits it', () => {
    const current = normalizeServerConfig({
      anthropic: { countTokens: { mode: 'reject' }, modelsShape: 'openai', heartbeatIntervalMs: 30_000 },
    });
    const merged = mergeServerConfig(current, { networkBinding: true });
    expect(merged.anthropic).toEqual({
      countTokens: { mode: 'reject', estimateBudgetMs: 2000 },
      modelsShape: 'openai',
      heartbeatIntervalMs: 30_000,
      pdfTextExtraction: { budgetMs: 2000 },
      proxyOauthUsage: false,
      apiHello: true,
    });
  });
});

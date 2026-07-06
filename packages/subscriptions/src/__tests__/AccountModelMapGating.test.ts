/**
 * Per-account model-map gating tests (subscription-account-model-map, tasks 2.5 / 3.4).
 *
 * The `supportedModels` skip folds into the SAME `accountSelection.gateSchedulable`
 * eligibility path as health (NOT a new mechanism): a ≥2-account pool routes AROUND
 * an account that does not support the resolved model to a supporting sibling,
 * EXACTLY like an unhealthy one; an all-unsupported pool falls to the active-mirror
 * path; a single-account provider is never model-gated (never-strand / zero
 * regression); and a selected account's OBJECT map reports its actual upstream
 * model so the relay can rewrite the outbound body model. #6 (key restriction on
 * the LOGICAL model) is evaluated BEFORE any per-account remap.
 */

import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import { __resetSharedAccountHealthForTests } from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { checkModelAllowed } from '@omnicross/core/outbound-api/keyPolicy';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubscriptionCredentialStore } from '../ports/credential-store';
import { remapForAccount } from '../scheduler/accountModelMap';
import { SubscriptionAccountService } from '../SubscriptionAccountService';

type Acct = { id: string; token: string | null; supportedModels?: string[] | Record<string, string> };

/** A fake claude credential store over an in-memory account list (with per-account
 *  `supportedModels`). Mirrors AccountHealthGating's store. */
function makeStore(
  accounts: Acct[],
  activeId: string | undefined,
): SubscriptionCredentialStore & { getAccessTokenForAccount: ReturnType<typeof vi.fn> } {
  const config: AccountTokensConfig = {
    updatedAt: '',
    claude: activeId
      ? { authMethod: 'oauth', status: 'authorized', accessToken: accounts.find((a) => a.id === activeId)?.token ?? undefined }
      : undefined,
    claudeAccounts: accounts.map((a) => ({
      id: a.id,
      createdAt: '2026-01-01T00:00:00.000Z',
      supportedModels: a.supportedModels,
      tokens: { authMethod: 'oauth', status: 'authorized', accessToken: a.token ?? undefined },
    })),
    activeClaudeAccountId: activeId,
  };
  const getAccessTokenForAccount = vi.fn(async (_p: SubscriptionProviderId, id: string) =>
    accounts.find((a) => a.id === id)?.token ?? null,
  );
  return {
    getFullConfig: vi.fn(async () => config),
    getValidClaudeAccessToken: vi.fn(async () => accounts.find((a) => a.id === activeId)?.token ?? null),
    getValidOpenCodeGoApiKey: vi.fn(async () => null),
    refreshClaudeToken: vi.fn(async () => false),
    refreshCodexToken: vi.fn(async () => false),
    refreshGeminiToken: vi.fn(async () => false),
    getAccessTokenForAccount,
    refreshAccountToken: vi.fn(async () => true),
    touchAccountLastUsed: vi.fn(async () => undefined),
  } as unknown as SubscriptionCredentialStore & { getAccessTokenForAccount: ReturnType<typeof vi.fn> };
}

interface Report {
  accountId: string;
  isActive: boolean;
  remappedModel?: string;
}

async function bearerFor(
  strategy: { applyHeaders: (h: Record<string, string>, hints?: unknown) => Promise<void> },
  resolvedModel: string,
): Promise<{ bearer?: string; report?: Report }> {
  const headers: Record<string, string> = {};
  let report: Report | undefined;
  await strategy.applyHeaders(headers, {
    resolvedModel,
    reportSelection: (accountId: string, isActive: boolean, remappedModel?: string) => {
      report = { accountId, isActive, remappedModel };
    },
  });
  return { bearer: headers['Authorization'], report };
}

beforeEach(() => __resetSharedAccountHealthForTests());

describe('model-map gating — multi-account routing', () => {
  it('routes AROUND an unsupported account to the supporting sibling', async () => {
    // A (active) supports only M1; B supports only M2. A request for M2 must serve B.
    const tokens = makeStore(
      [
        { id: 'A', token: 'AT-A', supportedModels: ['model-1'] },
        { id: 'B', token: 'AT-B', supportedModels: ['model-2'] },
      ],
      'A',
    );
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    const m2 = await bearerFor(strategy, 'model-2');
    expect(m2.bearer).toBe('Bearer AT-B');
    expect(tokens.getAccessTokenForAccount).toHaveBeenCalledWith('claude', 'B');
    expect(tokens.getAccessTokenForAccount).not.toHaveBeenCalledWith('claude', 'A');

    // A request for M1 stays on the active account A (B unsupported → 1 schedulable).
    const m1 = await bearerFor(strategy, 'model-1');
    expect(m1.bearer).toBe('Bearer AT-A');
  });

  it('all-unsupported multi-account pool falls to the active account (surfaces upstream)', async () => {
    const tokens = makeStore(
      [
        { id: 'A', token: 'AT-A', supportedModels: ['model-1'] },
        { id: 'B', token: 'AT-B', supportedModels: ['model-1'] },
      ],
      'A',
    );
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    // Neither supports model-2 → 0 schedulable → active-mirror (never a silent
    // non-supporting pick); the upstream stays authoritative.
    const res = await bearerFor(strategy, 'model-2');
    expect(res.bearer).toBe('Bearer AT-A');
    expect(tokens.getAccessTokenForAccount).not.toHaveBeenCalledWith('claude', 'B');
  });

  it('is case-insensitive on the model id', async () => {
    const tokens = makeStore(
      [
        { id: 'A', token: 'AT-A', supportedModels: ['model-1'] },
        { id: 'B', token: 'AT-B', supportedModels: ['MODEL-2'] },
      ],
      'A',
    );
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;
    expect((await bearerFor(strategy, 'Model-2')).bearer).toBe('Bearer AT-B');
  });
});

describe('single-account / map-less — zero regression + never-strand', () => {
  it('a sole account whose allow-list excludes the model still serves it', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A', supportedModels: ['model-1'] }], 'A');
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    // Not model-gated (single account): byte-identical active path, NO by-id read.
    expect((await bearerFor(strategy, 'model-2')).bearer).toBe('Bearer AT-A');
    expect(tokens.getAccessTokenForAccount).not.toHaveBeenCalled();
  });

  it('a map-less multi-account pool ignores the resolved model (both stay reachable)', async () => {
    const tokens = makeStore(
      [
        { id: 'A', token: 'AT-A' },
        { id: 'B', token: 'AT-B' },
      ],
      'A',
    );
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    // With no supportedModels, gating computes modelOk=true for all → normal
    // priority/LRU rotation, unaffected by resolvedModel (never model-excluded).
    const seen = new Set<string | undefined>();
    for (let i = 0; i < 6; i++) seen.add((await bearerFor(strategy, 'model-2')).bearer);
    expect(seen).toEqual(new Set(['Bearer AT-A', 'Bearer AT-B']));
  });
});

describe('per-account remap (object form) reporting', () => {
  it('a selected NON-ACTIVE account reports its actual upstream model', async () => {
    const tokens = makeStore(
      [
        { id: 'A', token: 'AT-A', supportedModels: ['model-1'] },
        { id: 'B', token: 'AT-B', supportedModels: { 'model-2': 'model-2-actual' } },
      ],
      'A',
    );
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    const res = await bearerFor(strategy, 'model-2');
    expect(res.bearer).toBe('Bearer AT-B');
    expect(res.report).toEqual({ accountId: 'B', isActive: false, remappedModel: 'model-2-actual' });
  });

  it('a sole/active account with an object map reports the remap on the active path', async () => {
    const tokens = makeStore(
      [{ id: 'A', token: 'AT-A', supportedModels: { 'model-2': 'model-2-actual' } }],
      'A',
    );
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    const res = await bearerFor(strategy, 'model-2');
    expect(res.bearer).toBe('Bearer AT-A');
    expect(res.report).toEqual({ accountId: 'A', isActive: true, remappedModel: 'model-2-actual' });
  });

  it('an array-form / no-mapping account reports no remap (undefined)', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A', supportedModels: ['model-2'] }], 'A');
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;
    const res = await bearerFor(strategy, 'model-2');
    expect(res.report).toEqual({ accountId: 'A', isActive: true, remappedModel: undefined });
  });
});

describe('#6 (key restriction) before #12 (remap) — ordering coherence', () => {
  it('the key check gates the LOGICAL model; the account remap is not re-gated', () => {
    // A key that permits the logical model on an allowlist.
    const restriction = { mode: 'allowlist' as const, models: ['model-2'] };
    // #6 runs on the caller's LOGICAL model (before dispatch) → allowed.
    expect(checkModelAllowed(restriction, 'model-2').allowed).toBe(true);
    // #12 remaps to the account's ACTUAL model (internal routing, after selection).
    const actual = remapForAccount({ 'model-2': 'model-2-actual' }, 'model-2');
    expect(actual).toBe('model-2-actual');
    // The actual model is NEVER fed back to the key restriction — the caller is not
    // 403'd for an internal substitution it never asked for. (Documenting: were it
    // re-checked it would be denied, which is exactly what the ordering prevents.)
    expect(checkModelAllowed(restriction, actual).allowed).toBe(false);
  });
});

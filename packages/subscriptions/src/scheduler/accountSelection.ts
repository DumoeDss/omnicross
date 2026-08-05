/**
 * accountSelection — the shared glue the three concrete `AuthStrategy` impls use
 * to fold `SubscriptionAccountSelector` into token resolution
 * (subscription-account-scheduling, design D1/D4/D6/D7).
 *
 * Each strategy already holds the `SubscriptionCredentialStore`; these helpers add
 * the by-id branch WITHOUT duplicating the selection/feature-detect/throttle logic
 * across all three:
 *
 *  - `readSchedulableAccounts` projects a provider's stored account array into the
 *    selector's `SchedulableAccount[]` (+ the active pointer).
 *  - `resolveSelectedToken` runs the selector; on a non-active pick it resolves
 *    THAT account's token by id (feature-detected), touching `lastUsedAt` sparingly;
 *    on `null`/`isActive`/absent-port it calls the strategy's own active getter —
 *    byte-identical to before this change.
 *  - `refreshSelectedAccount` refreshes the sticky account a 401 was actually
 *    served by (mutex key `${providerId}:${accountId}`), returning `null` to mean
 *    "fall back to the active refresh".
 *
 * @module scheduler/accountSelection
 */

import type { AccountTokensConfig, SubscriptionAccountEntry } from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import {
  AccountAllowanceExhaustedError,
  getSharedAccountAllowanceScheduling,
} from '@omnicross/core/pipeline/AccountAllowanceScheduling';
import {
  BoundAccountSelectionError,
  type BoundAccountFallbackPolicy,
} from '@omnicross/core/pipeline/BoundAccountSelectionError';
import type { SubscriptionAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';

import type { RefreshMutex } from '../auth/RefreshMutex';
import type { SubscriptionCredentialStore } from '../ports/credential-store';

import {
  accountSupportsModel,
  remapReportForAccount,
  type SupportedModels,
} from './accountModelMap';
import {
  DEFAULT_ACCOUNT_PRIORITY,
  type SchedulableAccount,
  type SubscriptionAccountSelector,
} from './SubscriptionAccountSelector';

/** Extra health-aware inputs for `resolveSelectedToken` (subscription-account-health
 *  + subscription-account-model-map). All optional so the pre-health / test call
 *  path stays byte-identical. */
export interface SelectionHealthContext {
  /** The shared health tracker; when present, computes `schedulable` per account. */
  health?: SubscriptionAccountHealth;
  /**
   * The resolved (logical) model for this request (subscription-account-model-map).
   * When present, an account whose `supportedModels` excludes it is filtered out of
   * a ≥2-account pool EXACTLY like an unhealthy one, and the selected account's
   * object-form remap is reported to the relay. Absent ⇒ no model gating / no remap.
   */
  resolvedModel?: string;
  /** Fires with the EFFECTIVE account id + `isActive`, plus the account's ACTUAL
   *  upstream model when its `supportedModels` object remaps `resolvedModel`
   *  (subscription-account-model-map) — the relay rewrites `body.model` to it. */
  reportSelection?: (accountId: string, isActive: boolean, remappedModel?: string) => void;
  /**
   * Per-request preferred account id (provider/subscription duality). When set,
   * strict selection is the default; only the explicit pool policy permits
   * fallback. Absent bindings retain pool auto-scheduling.
   */
  preferredAccountId?: string;
  /** Optional account group to prefer/restrict before normal pool scheduling. */
  preferredAccountGroup?: string;
  /** `'pool'` is the explicit fallback opt-in; bound accounts otherwise fail. */
  boundAccountFallbackPolicy?: BoundAccountFallbackPolicy;
  /** Injectable clock (default `Date.now()` inside the selector). */
  now?: number;
}

const ACCOUNTS_KEY: Record<SubscriptionProviderId, keyof AccountTokensConfig> = {
  claude: 'claudeAccounts',
  codex: 'codexAccounts',
  gemini: 'geminiAccounts',
  opencodego: 'opencodegoAccounts',
};

const ACTIVE_KEY: Record<SubscriptionProviderId, keyof AccountTokensConfig> = {
  claude: 'activeClaudeAccountId',
  codex: 'activeCodexAccountId',
  gemini: 'activeGeminiAccountId',
  opencodego: 'activeOpencodegoAccountId',
};

/**
 * Compute each account's `schedulable` from health (subscription-account-health,
 * D4) AND per-account model support (subscription-account-model-map, D2) — but
 * ONLY when the provider has ≥2 accounts. Both eligibility reasons fold into the
 * SAME `schedulable` boolean the selector already consumes (no new mechanism): an
 * account is skipped when it is unhealthy OR (given a `resolvedModel`) its
 * `supportedModels` does not include that model. With exactly one account the
 * single-account degraded policy leaves `schedulable` unset so the selector
 * returns `null` → the #1 active-mirror path serves it (byte-identical single
 * account; never-strand — the upstream stays authoritative).
 */
function gateSchedulable(
  accounts: SchedulableAccount[],
  providerId: SubscriptionProviderId,
  health: SubscriptionAccountHealth | undefined,
  now: number | undefined,
  resolvedModel: string | undefined,
  supportedModelsById: Map<string, SupportedModels | undefined>,
): SchedulableAccount[] {
  if ((!health && !resolvedModel) || accounts.length < 2) return accounts;
  return accounts.map((a) => {
    const healthOk = health ? health.isSchedulable(providerId, a.id, now) : true;
    const modelOk = resolvedModel
      ? accountSupportsModel(supportedModelsById.get(a.id), resolvedModel)
      : true;
    return { ...a, schedulable: a.schedulable !== false && healthOk && modelOk };
  });
}

/** Whether `gateSchedulable` actually gated the pool — a tracker OR a resolved
 *  model was supplied AND the pool has ≥2 accounts. Drives the `pickByIdTarget`
 *  "filtered-to-1-non-active → route by id" edge for BOTH health and model gating. */
function isPoolGated(
  accounts: SchedulableAccount[],
  health: SubscriptionAccountHealth | undefined,
  resolvedModel: string | undefined,
): boolean {
  return (health !== undefined || resolvedModel !== undefined) && accounts.length >= 2;
}

function hasUsableToken(token: string | null): token is string {
  return typeof token === 'string' && token.trim() !== '';
}

/**
 * Resolve a bound account without consulting another account. This path is
 * intentionally separate from the pool selector: the selector's historical
 * single-account degraded behavior is correct for pools but would violate a
 * strict endpoint binding (especially for model maps and allowance pauses).
 */
async function resolveStrictPreferredToken(
  tokens: SubscriptionCredentialStore,
  providerId: SubscriptionProviderId,
  preferredId: string,
  activeGetter: () => Promise<string | null>,
  ctx: SelectionHealthContext,
): Promise<string> {
  let config: AccountTokensConfig;
  try {
    config = await tokens.getFullConfig();
  } catch {
    throw new BoundAccountSelectionError(providerId, 'unavailable');
  }

  let accounts: SchedulableAccount[];
  let activeAccountId: string | undefined;
  let supportedModelsById: Map<string, SupportedModels | undefined>;
  try {
    ({ accounts, activeAccountId, supportedModelsById } = readSchedulableAccounts(config, providerId));
  } catch {
    throw new BoundAccountSelectionError(providerId, 'unavailable');
  }
  const preferred = accounts.find((account) => account.id === preferredId);
  if (!preferred) {
    throw new BoundAccountSelectionError(providerId, 'not-found');
  }
  if (preferred.schedulable === false) {
    throw new BoundAccountSelectionError(providerId, 'disabled');
  }
  if (ctx.health && !ctx.health.isSchedulable(providerId, preferredId, ctx.now)) {
    throw new BoundAccountSelectionError(providerId, 'unhealthy');
  }
  if (ctx.resolvedModel && !accountSupportsModel(supportedModelsById.get(preferredId), ctx.resolvedModel)) {
    throw new BoundAccountSelectionError(providerId, 'model-incompatible');
  }

  const allowance = getSharedAccountAllowanceScheduling().evaluate(
    providerId,
    preferredId,
    preferred.priority ?? DEFAULT_ACCOUNT_PRIORITY,
    ctx.now,
  );
  if (allowance.action === 'pause') {
    throw new BoundAccountSelectionError(providerId, 'allowance-paused', allowance.resumeAt);
  }

  let token: string | null = null;
  try {
    token = tokens.getAccessTokenForAccount
      ? await tokens.getAccessTokenForAccount(providerId, preferredId)
      : preferredId === activeAccountId
        ? await activeGetter()
        : null;
  } catch {
    throw new BoundAccountSelectionError(providerId, 'unavailable');
  }
  if (!hasUsableToken(token)) {
    throw new BoundAccountSelectionError(providerId, 'empty-token');
  }

  const remapped = remapReportForAccount(supportedModelsById.get(preferredId), ctx.resolvedModel);
  ctx.reportSelection?.(preferredId, preferredId === activeAccountId, remapped);
  return token;
}

/**
 * Apply the default-off allowance policy after operator/health/model gates. A
 * stale or absent snapshot evaluates to `ignore`; only fresh provider data can
 * alter priority or eligibility. Unlike transient health's single-account
 * degraded behavior, an explicitly enabled pause threshold is authoritative for
 * a one-account pool as well.
 */
function gateByAllowance(
  accounts: SchedulableAccount[],
  providerId: SubscriptionProviderId,
  now: number | undefined,
): SchedulableAccount[] {
  const scheduling = getSharedAccountAllowanceScheduling();
  const evaluatedAt = now ?? Date.now();
  const eligibleBeforePolicy = accounts.filter((account) => account.schedulable !== false);
  if (eligibleBeforePolicy.length === 0) return accounts;

  const decisions = new Map<string, ReturnType<typeof scheduling.evaluate>>();
  const gated = accounts.map((account) => {
    if (account.schedulable === false) return account;
    const decision = scheduling.evaluate(
      providerId,
      account.id,
      account.priority ?? DEFAULT_ACCOUNT_PRIORITY,
      evaluatedAt,
    );
    decisions.set(account.id, decision);
    return {
      ...account,
      priority: decision.effectivePriority,
      schedulable: decision.schedulable,
    };
  });

  if (gated.some((account) => account.schedulable !== false)) return gated;
  const paused = eligibleBeforePolicy
    .map((account) => decisions.get(account.id))
    .filter((decision) => decision?.action === 'pause');
  if (paused.length !== eligibleBeforePolicy.length) return gated;
  const resumeAt = paused
    .map((decision) => decision?.resumeAt)
    .filter((value): value is string => !!value)
    .sort()[0];
  throw new AccountAllowanceExhaustedError(providerId, resumeAt);
}

/** Project a provider's stored accounts into the selector's candidate shape.
 *  `schedulable` is left unset (defaults true) — child #2 (health) fills it.
 *  Also returns each account's `supportedModels` in a side map (NOT on
 *  `SchedulableAccount`, whose shape the selector owns) for the model-map gate. */
export function readSchedulableAccounts(
  config: AccountTokensConfig,
  providerId: SubscriptionProviderId,
): {
  accounts: SchedulableAccount[];
  activeAccountId?: string;
  supportedModelsById: Map<string, SupportedModels | undefined>;
} {
  const raw =
    (config[ACCOUNTS_KEY[providerId]] as SubscriptionAccountEntry<unknown>[] | undefined) ?? [];
  const accounts: SchedulableAccount[] = raw.map((a) => ({
    id: a.id,
    group: typeof a.group === 'string' && a.group.trim() !== '' ? a.group.trim() : providerId,
    priority: a.priority,
    lastUsedAt: a.lastUsedAt,
    createdAt: a.createdAt,
    // Persisted opt-out is absolute, including a one-account pool. Legacy rows
    // omit the field and therefore remain enabled.
    schedulable: a.enabled !== false,
  }));
  const supportedModelsById = new Map<string, SupportedModels | undefined>(
    raw.map((a) => [a.id, a.supportedModels]),
  );
  const activeAccountId = config[ACTIVE_KEY[providerId]] as string | undefined;
  return { accounts, activeAccountId, supportedModelsById };
}

/**
 * Choose the NON-ACTIVE account id to resolve by id, or `undefined` to fall to
 * the active getter. Runs the #1 selector first (affinity + priority/LRU over ≥2
 * schedulable). When health-gating leaves EXACTLY ONE schedulable account of a
 * ≥2-account pool and it is NOT the active one, the selector returns `null` (≤1
 * schedulable) yet we must still route to that healthy sibling by id rather than
 * serve the unhealthy active account — that "route around" case is the whole
 * point of health gating. When the sole schedulable IS the active account (or 0
 * are schedulable, or it is a single-account provider), `undefined` ⇒ the active
 * path (byte-identical single-account, upstream-authoritative error on all-unhealthy).
 */
function pickByIdTarget(
  selector: SubscriptionAccountSelector,
  gated: SchedulableAccount[],
  providerId: SubscriptionProviderId,
  activeAccountId: string | undefined,
  sessionKey: string | undefined,
  now: number | undefined,
  healthGated: boolean,
): string | undefined {
  const selection = selector.select({ providerId, accounts: gated, activeAccountId, sessionKey, now });
  if (selection && !selection.isActive) return selection.accountId;
  if (selection === null && healthGated) {
    const schedulable = gated.filter((a) => a.schedulable !== false);
    if (schedulable.length === 1 && schedulable[0].id !== activeAccountId) return schedulable[0].id;
  }
  return undefined;
}

/**
 * Resolve the outbound token, folding the pool scheduler + health gating in. On a
 * non-active target the selected account's token is read by id (feature-detected);
 * otherwise `activeGetter()` runs verbatim (the zero-regression / single-account /
 * all-unhealthy path). A non-active target whose by-id read yields `null` evicts
 * that account's affinity, marks it transiently unhealthy, and re-selects (#1
 * [Minor]).
 */
export async function resolveSelectedToken(
  selector: SubscriptionAccountSelector | undefined,
  tokens: SubscriptionCredentialStore,
  providerId: SubscriptionProviderId,
  sessionKey: string | undefined,
  activeGetter: () => Promise<string | null>,
  ctx?: SelectionHealthContext,
): Promise<string | null> {
  const health = ctx?.health;
  const report = ctx?.reportSelection;
  const now = ctx?.now;
  const resolvedModel = ctx?.resolvedModel;
  const preferredId =
    typeof ctx?.preferredAccountId === 'string' && ctx.preferredAccountId.trim() !== ''
      ? ctx.preferredAccountId.trim()
      : undefined;
  const preferredGroup =
    typeof ctx?.preferredAccountGroup === 'string' && ctx.preferredAccountGroup.trim() !== ''
      ? ctx.preferredAccountGroup.trim()
      : undefined;
  if (preferredId && ctx && ctx.boundAccountFallbackPolicy !== 'pool') {
    return resolveStrictPreferredToken(tokens, providerId, preferredId, activeGetter, ctx);
  }
  if (selector && tokens.getAccessTokenForAccount) {
    const config = await tokens.getFullConfig();
    const { accounts, activeAccountId, supportedModelsById } = readSchedulableAccounts(config, providerId);
    const groupAccounts = preferredGroup
      ? accounts.filter((account) => account.group === preferredGroup)
      : accounts;
    if (preferredGroup && groupAccounts.length === 0 && ctx?.boundAccountFallbackPolicy !== 'pool') {
      throw new BoundAccountSelectionError(providerId, 'not-found');
    }
    let candidates = groupAccounts.length > 0 ? groupAccounts : accounts;
    let healthAndModelGated = gateSchedulable(
      candidates,
      providerId,
      health,
      now,
      resolvedModel,
      supportedModelsById,
    );
    let gated = gateByAllowance(healthAndModelGated, providerId, now);
    // An explicit global/pool fallback must leave an existing-but-unavailable
    // group as well as a missing group. Otherwise a disabled group member can
    // strand selection inside that group despite a healthy provider pool.
    let groupHasUsableCredential = gated.some((account) => account.schedulable !== false);
    if (
      groupHasUsableCredential &&
      preferredGroup &&
      ctx?.boundAccountFallbackPolicy === 'pool' &&
      candidates !== accounts
    ) {
      groupHasUsableCredential = false;
      for (const account of gated) {
        if (account.schedulable === false) continue;
        if (await tokens.getAccessTokenForAccount(providerId, account.id)) {
          groupHasUsableCredential = true;
          break;
        }
      }
    }
    if (
      preferredGroup &&
      ctx?.boundAccountFallbackPolicy === 'pool' &&
      candidates !== accounts &&
      !groupHasUsableCredential
    ) {
      candidates = accounts;
      healthAndModelGated = gateSchedulable(
        candidates,
        providerId,
        health,
        now,
        resolvedModel,
        supportedModelsById,
      );
      gated = gateByAllowance(healthAndModelGated, providerId, now);
    }
    // Gating actually ran only when a tracker OR a resolved model was supplied AND
    // the pool has ≥2 accounts (the single-account degraded policy leaves `gated`
    // ungated). Drives the route-around edge for BOTH health and model gating.
    const poolGated =
      isPoolGated(candidates, health, resolvedModel) ||
      candidates.some((account) => account.schedulable === false) ||
      preferredGroup !== undefined;
    // The remapped model to report for a selected account (object-form map) — or
    // `undefined` (no remap) which the relay treats as "forward the body verbatim".
    const remapFor = (id: string): string | undefined =>
      remapReportForAccount(supportedModelsById.get(id), resolvedModel);

    // Explicit pool fallback (provider/subscription duality): a strict binding
    // returned above, so this legacy selector path is reached only when the
    // endpoint opted into pool fallback or has no binding.
    if (preferredId) {
      const preferred = gated.find((a) => a.id === preferredId);
      if (preferred && preferred.schedulable !== false) {
        const preferredToken = await tokens.getAccessTokenForAccount(providerId, preferredId);
        if (preferredToken) {
          maybeTouchLastUsed(selector, tokens, providerId, preferredId);
          report?.(preferredId, preferredId === activeAccountId, remapFor(preferredId));
          return preferredToken;
        }
      }
    }

    const targetId = pickByIdTarget(selector, gated, providerId, activeAccountId, sessionKey, now, poolGated);
    if (targetId !== undefined) {
      const byId = await tokens.getAccessTokenForAccount(providerId, targetId);
      if (byId) {
        maybeTouchLastUsed(selector, tokens, providerId, targetId);
        report?.(targetId, false, remapFor(targetId));
        return byId;
      }
      // #1 [Minor] (task 4.2): a null/invalid by-id token → evict this account's
      // affinity, mark it transiently unhealthy, and RE-SELECT (excluding it)
      // instead of leaving stale stickiness.
      selector.evictAffinity(providerId, targetId);
      health?.recordUpstreamOutcome(providerId, targetId, { status: 401, now });
      const remaining = gated.filter((a) => a.id !== targetId);
      const retryId = pickByIdTarget(selector, remaining, providerId, activeAccountId, sessionKey, now, poolGated);
      if (retryId !== undefined) {
        const retryToken = await tokens.getAccessTokenForAccount(providerId, retryId);
        if (retryToken) {
          maybeTouchLastUsed(selector, tokens, providerId, retryId);
          report?.(retryId, false, remapFor(retryId));
          return retryToken;
        }
      }
    }
    // No non-active target (null / isActive / by-id-failed) → the active-mirror
    // path. Report the active account so the relay marks what it actually served
    // (and remaps its outbound model when the sole/active account's map dictates —
    // the documented sole-account remap path).
    if (activeAccountId) {
      if (
        preferredGroup &&
        ctx?.boundAccountFallbackPolicy !== 'pool' &&
        !candidates.some((account) => account.id === activeAccountId)
      ) {
        throw new BoundAccountSelectionError(providerId, 'unavailable');
      }
      // Unlike transient health/model degradation, an explicit operator disable
      // must never fall through to the active credential, even for a sole account.
      const persistedActive = accounts.find((account) => account.id === activeAccountId);
      if (persistedActive?.schedulable === false) return null;
      // A by-id failure may leave the active account as the last fallback. Do
      // not let that degraded path bypass an explicit fresh allowance pause;
      // health/model gates still retain their upstream-authoritative fallback.
      const activeAllowance = getSharedAccountAllowanceScheduling().evaluate(
        providerId,
        activeAccountId,
        persistedActive?.priority ?? DEFAULT_ACCOUNT_PRIORITY,
        now,
      );
      if (activeAllowance.action === 'pause') {
        throw new AccountAllowanceExhaustedError(providerId, activeAllowance.resumeAt);
      }
      report?.(activeAccountId, true, remapFor(activeAccountId));
    }
    return activeGetter();
  }
  return activeGetter();
}

/** Best-effort, throttled `lastUsedAt` persist (fire-and-forget). */
export function maybeTouchLastUsed(
  selector: SubscriptionAccountSelector,
  tokens: SubscriptionCredentialStore,
  providerId: SubscriptionProviderId,
  accountId: string,
): void {
  if (!tokens.touchAccountLastUsed) return;
  if (!selector.duePersist(providerId, accountId)) return;
  void tokens.touchAccountLastUsed(providerId, accountId, new Date().toISOString()).catch(() => {
    /* durability is best-effort — a dropped persist never affects correctness. */
  });
}

/**
 * Refresh the sticky account a 401 was served by. Returns:
 *  - `null` when no by-id refresh applies (no sessionKey / no selector / no port /
 *    the sticky pick is the active account) → the strategy runs its active refresh;
 *  - a boolean when the selected non-active account's refresh was attempted
 *    (deduped on `${providerId}:${accountId}` so concurrent 401s for one account
 *    collapse while different accounts refresh independently).
 */
export async function refreshSelectedAccount(
  selector: SubscriptionAccountSelector | undefined,
  tokens: SubscriptionCredentialStore,
  mutex: RefreshMutex<boolean>,
  providerId: SubscriptionProviderId,
  sessionKey: string | undefined,
): Promise<boolean | null> {
  if (!sessionKey || !selector || !tokens.refreshAccountToken) return null;
  const config = await tokens.getFullConfig();
  const { accounts, activeAccountId } = readSchedulableAccounts(config, providerId);
  const selection = selector.select({ providerId, accounts, activeAccountId, sessionKey });
  if (!selection || selection.isActive) return null;
  const accountId = selection.accountId;
  return mutex.run(`${providerId}:${accountId}`, async () => {
    try {
      return (await tokens.refreshAccountToken!(providerId, accountId)) ?? false;
    } catch (err) {
      console.warn(`[accountSelection] ${providerId}:${accountId} by-id refresh failed:`, err);
      return false;
    }
  });
}

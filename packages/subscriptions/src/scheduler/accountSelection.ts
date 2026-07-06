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
import type { SubscriptionAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';

import type { RefreshMutex } from '../auth/RefreshMutex';
import type { SubscriptionCredentialStore } from '../ports/credential-store';

import {
  accountSupportsModel,
  remapReportForAccount,
  type SupportedModels,
} from './accountModelMap';
import type { SchedulableAccount, SubscriptionAccountSelector } from './SubscriptionAccountSelector';

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
    return { ...a, schedulable: healthOk && modelOk };
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
    priority: a.priority,
    lastUsedAt: a.lastUsedAt,
    createdAt: a.createdAt,
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
  if (selector && tokens.getAccessTokenForAccount) {
    const config = await tokens.getFullConfig();
    const { accounts, activeAccountId, supportedModelsById } = readSchedulableAccounts(config, providerId);
    const gated = gateSchedulable(accounts, providerId, health, now, resolvedModel, supportedModelsById);
    // Gating actually ran only when a tracker OR a resolved model was supplied AND
    // the pool has ≥2 accounts (the single-account degraded policy leaves `gated`
    // ungated). Drives the route-around edge for BOTH health and model gating.
    const poolGated = isPoolGated(accounts, health, resolvedModel);
    // The remapped model to report for a selected account (object-form map) — or
    // `undefined` (no remap) which the relay treats as "forward the body verbatim".
    const remapFor = (id: string): string | undefined =>
      remapReportForAccount(supportedModelsById.get(id), resolvedModel);

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
    if (activeAccountId) report?.(activeAccountId, true, remapFor(activeAccountId));
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

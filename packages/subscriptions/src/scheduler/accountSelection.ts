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

import type { RefreshMutex } from '../auth/RefreshMutex';
import type { SubscriptionCredentialStore } from '../ports/credential-store';

import type { SchedulableAccount, SubscriptionAccountSelector } from './SubscriptionAccountSelector';

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

/** Project a provider's stored accounts into the selector's candidate shape.
 *  `schedulable` is left unset (defaults true) — child #2 (health) fills it. */
export function readSchedulableAccounts(
  config: AccountTokensConfig,
  providerId: SubscriptionProviderId,
): { accounts: SchedulableAccount[]; activeAccountId?: string } {
  const raw =
    (config[ACCOUNTS_KEY[providerId]] as SubscriptionAccountEntry<unknown>[] | undefined) ?? [];
  const accounts: SchedulableAccount[] = raw.map((a) => ({
    id: a.id,
    priority: a.priority,
    lastUsedAt: a.lastUsedAt,
    createdAt: a.createdAt,
  }));
  const activeAccountId = config[ACTIVE_KEY[providerId]] as string | undefined;
  return { accounts, activeAccountId };
}

/**
 * Resolve the outbound token, folding the pool scheduler in. On a non-active pick
 * the selected account's token is read by id (feature-detected); on `null` /
 * `isActive` / no selector / no by-id port, `activeGetter()` runs verbatim (the
 * zero-regression path). A non-active pick whose by-id read yields `null`
 * gracefully degrades to the active getter.
 */
export async function resolveSelectedToken(
  selector: SubscriptionAccountSelector | undefined,
  tokens: SubscriptionCredentialStore,
  providerId: SubscriptionProviderId,
  sessionKey: string | undefined,
  activeGetter: () => Promise<string | null>,
): Promise<string | null> {
  if (selector && tokens.getAccessTokenForAccount) {
    const config = await tokens.getFullConfig();
    const { accounts, activeAccountId } = readSchedulableAccounts(config, providerId);
    const selection = selector.select({ providerId, accounts, activeAccountId, sessionKey });
    if (selection && !selection.isActive) {
      const byId = await tokens.getAccessTokenForAccount(providerId, selection.accountId);
      maybeTouchLastUsed(selector, tokens, providerId, selection.accountId);
      if (byId) return byId;
    }
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

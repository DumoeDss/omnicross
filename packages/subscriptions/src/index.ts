/**
 * @omnicross/subscriptions — the subscription-as-provider block (auth
 * strategies, account service, provider registry, dispatcher, opencodego
 * routing). Depends on `@omnicross/core`; the host injects its concrete
 * token store as the `SubscriptionCredentialStore` port at bootstrap.
 */

// Credential port — the host injects its token store (which structurally satisfies it).
export type { SubscriptionCredentialStore } from './ports/credential-store';

// Account pool scheduler (subscription-account-scheduling) — the pure selector +
// its types, constructed once at bootstrap and shared by the auth strategies.
export {
  DEFAULT_ACCOUNT_PRIORITY,
  LAST_USED_PERSIST_THROTTLE_MS,
  type SchedulableAccount,
  type SelectInput,
  type SelectResult,
  SESSION_AFFINITY_TTL_MS,
  SubscriptionAccountSelector,
} from './scheduler/SubscriptionAccountSelector';

// Account service (auth-strategy holder) + its module singleton accessors.
export {
  getSubscriptionAccountService,
  setSubscriptionAccountService,
  SubscriptionAccountService,
} from './SubscriptionAccountService';

// Provider registry (dispatch-profile catalog) + its module singleton accessors.
export {
  getSubscriptionProviderRegistry,
  setSubscriptionProviderRegistry,
  SubscriptionProviderRegistry,
} from './SubscriptionProviderRegistry';

// Re-exported dispatch-profile shapes (defined in @omnicross/core, re-exported
// from the registry so host consumers keep a single subscription import source).
export type {
  SubscriptionDispatchProfile,
  SubscriptionRequestSummary,
} from './SubscriptionProviderRegistry';

// Dispatcher (subscription-mode proxy flow).
export type { DispatcherHooks,DispatchRequest } from './SubscriptionDispatcher';
export { SubscriptionDispatcher } from './SubscriptionDispatcher';

// Auth strategy contract type (re-exported from @omnicross/core via auth/).
export type { AuthApplyHints, AuthStrategy } from './auth';

// Host-clean OAuth flow logic (authorize/exchange/refresh per provider) usable
// by a desktop host + the daemon login/refresh paths. Network goes
// through the injected `FetchLike` port (no electron / host imports under oauth/).
export { claudeOAuth, codexOAuth, type FetchLike, geminiOAuth } from './oauth';

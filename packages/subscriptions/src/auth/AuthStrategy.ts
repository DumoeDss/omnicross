/**
 * AuthStrategy — pluggable authentication for subscription dispatch through the proxy.
 *
 * Each subscription provider in `SubscriptionProviderRegistry` carries an
 * `AuthStrategy` instance. The proxy calls `applyHeaders` before issuing the
 * upstream request and `onUnauthorized` after a 401 to ask whether to retry.
 *
 * The interface itself lives in the serving core
 * (`@omnicross/core/pipeline/SubscriptionAuthStrategy`) — it is a pure
 * contract with no host semantics, down-sunk there so
 * `pipeline/SubscriptionAuthSource` does not import upward into the host.
 * This module RE-EXPORTS the core type so the three concrete strategies and
 * every downstream consumer keep their import paths unchanged.
 */

export type {
  AuthApplyHints,
  AuthStrategy,
} from '@omnicross/core/pipeline/SubscriptionAuthStrategy';

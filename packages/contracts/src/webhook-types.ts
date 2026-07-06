/**
 * Webhook notification contracts (webhook-notifications, design D1).
 *
 * Two small, dependency-light shapes shared across the `@omnicross/*` packages:
 *  - `WebhookEvent` — the FROZEN discriminated union of operational signals a
 *    relay can deliver out-of-band (account recovery/anomaly, key quota
 *    warning/exceeded, server error, and a config-UI `test`). Every payload is
 *    SECRET-FREE BY CONSTRUCTION: it carries only opaque provider/account ids, a
 *    key id (NEVER key material or a hash), a coarse state, limit/spend numbers,
 *    and a sanitized message. Nothing here can hold a token, secret, or hash.
 *  - `WebhookDestination` / `WebhookConfig` — the destination config schema. A
 *    destination's `secret` (its HMAC signing key) is the ONLY secret; it is
 *    encrypted at rest, masked in admin views, and used ONLY to sign an outgoing
 *    request — it is NEVER placed in a payload or a log line.
 *
 * The union is FROZEN: the emit port (core), the dispatcher (daemon), and the
 * sources (#2 health / #4 quota / server-error) all agree on this one shape.
 * Adding a destination `type` is additive behind the dispatcher's formatter.
 *
 * @module webhook-types
 */

/** The coarse anomaly state an account transitioned into (secret-free). */
export type WebhookAnomalyState = 'blocked' | 'unauthorized' | 'rate_limited' | 'overloaded';

/** The cost-limit scope a key quota event refers to. */
export type WebhookQuotaScope = 'daily' | 'weekly' | 'total';

/**
 * The FROZEN webhook event union (design D1). EVERY field is non-secret:
 * opaque provider/account ids, a key id (NOT key material/hash), a coarse state,
 * numbers, and a sanitized message. A test asserts no token/secret/hash string
 * can appear in any serialized payload.
 */
export type WebhookEvent =
  | { kind: 'account.recovery'; at: number; providerId: string; accountId: string }
  | {
      kind: 'account.anomaly';
      at: number;
      providerId: string;
      accountId: string;
      state: WebhookAnomalyState;
    }
  | {
      kind: 'key.quotaWarning';
      at: number;
      keyId: string;
      scope: WebhookQuotaScope;
      limitUsd: number;
      spentUsd: number;
    }
  | {
      kind: 'key.quotaExceeded';
      at: number;
      keyId: string;
      scope: WebhookQuotaScope;
      limitUsd: number;
      spentUsd: number;
    }
  | { kind: 'server.error'; at: number; message: string }
  | { kind: 'test'; at: number };

/** The event discriminator — the value a destination `events` filter matches. */
export type WebhookEventKind = WebhookEvent['kind'];

/** All event kinds (SSOT for validation + the admin UI's filter checklist). */
export const WEBHOOK_EVENT_KINDS: readonly WebhookEventKind[] = [
  'account.recovery',
  'account.anomaly',
  'key.quotaWarning',
  'key.quotaExceeded',
  'server.error',
  'test',
] as const;

/** The v1 destination types (dingtalk/slack/… are additive later). */
export type WebhookDestinationType = 'custom' | 'feishu';

/** All destination types (SSOT for validation + the admin UI's type select). */
export const WEBHOOK_DESTINATION_TYPES: readonly WebhookDestinationType[] = ['custom', 'feishu'] as const;

/**
 * One webhook destination (design D5). `secret` is the OPTIONAL HMAC signing key
 * (a SECRET — encrypted at rest, masked in views, never in a payload/log). An
 * absent/empty `events` filter matches ALL event kinds.
 */
export interface WebhookDestination {
  /** Stable id (the admin CRUD key + the test-button target). */
  id: string;
  /** The formatter/signing scheme to use. */
  type: WebhookDestinationType;
  /** The POST target URL. */
  url: string;
  /** OPTIONAL HMAC signing key (SECRET; may be an `enc:`/`$ENV` envelope at rest). */
  secret?: string;
  /** OPTIONAL event-kind filter; absent/empty ⇒ receive ALL kinds. */
  events?: WebhookEventKind[];
  /** Whether this destination receives events. */
  enabled: boolean;
}

/**
 * The `webhook` config segment (design D5). Absent/`enabled:false` ⇒ inert (no
 * dispatcher wiring, emit is a no-op — byte-identical zero regression).
 */
export interface WebhookConfig {
  /** Master switch; false/absent ⇒ webhooks are inert. */
  enabled: boolean;
  /** Configured destinations (each independently enable-able + filterable). */
  destinations: WebhookDestination[];
}

/**
 * Secret-free projection of a destination for admin GET views: the signing
 * `secret` is replaced by a `hasSecret` presence flag — the plaintext never
 * leaves the daemon.
 */
export interface SanitizedWebhookDestination {
  id: string;
  type: WebhookDestinationType;
  url: string;
  /** Whether a signing secret is configured (the value itself never leaves). */
  hasSecret: boolean;
  events?: WebhookEventKind[];
  enabled: boolean;
}

/** Secret-free projection of the whole webhook segment (admin GET view). */
export interface SanitizedWebhookConfig {
  enabled: boolean;
  destinations: SanitizedWebhookDestination[];
}

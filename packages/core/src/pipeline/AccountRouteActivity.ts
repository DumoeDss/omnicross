/**
 * Bounded, metadata-only history of upstream routing decisions.
 *
 * Records are created at the shared upstream fetch seam, after authentication has
 * reported the credential that will actually serve the request. TWO credential
 * kinds share one timeline: subscription POOL ACCOUNTS (`credentialKind:
 * 'subscription-account'`, identified by `accountId`) and BYO provider API KEYS
 * (`credentialKind: 'provider-key'`, identified by `keyId` when the ApiKeyPool
 * bound one). The store is intentionally process-local: it is useful for live
 * operator diagnostics without turning session/account affinity into a durable
 * tracking database.
 */

export const ACCOUNT_ROUTE_ACTIVITY_LIMIT = 300;

export type AccountRouteEndpoint = 'responses' | 'messages' | 'chat' | 'generateContent';

/**
 * Which kind of upstream credential a row attributes. Absent on records minted
 * by older callers — those are subscription-account rows (the historical only
 * kind), so the DEFAULT is `'subscription-account'`.
 */
export type RouteCredentialKind = 'subscription-account' | 'provider-key';

export type AccountRouteSessionSource =
  | 'session-header'
  | 'thread-header'
  | 'body-session-id'
  | 'body-thread-id'
  | 'prompt-cache-key'
  | 'content-fingerprint'
  | 'api-key-fallback'
  | 'route-session-id'
  | 'none';

export type AccountRouteAffinity = 'new' | 'sticky' | 'switched' | 'untracked';

export interface AccountRouteActivityInput {
  /**
   * Display provider id: a subscription provider id (`claude`/`codex`/…) for
   * account rows, the PROVIDER ROW id for provider-key rows. This is NOT the
   * egress proxy key (`'byo'`) — it must be the id an operator recognizes.
   */
  providerId: string;
  /** Which kind of credential served the request. Defaults to
   *  `'subscription-account'` for back-compat with older callers. */
  credentialKind?: RouteCredentialKind;
  /** Subscription pool account id (required for `subscription-account` rows). */
  accountId?: string;
  /** ApiKeyPool key id when known (provider-key rows). Metadata only — the key
   *  STRING never enters this store. */
  keyId?: string;
  endpoint: AccountRouteEndpoint;
  sessionKey?: string;
  sessionSource: AccountRouteSessionSource;
  model: string;
  status: number;
  durationMs: number;
  ts?: number;
  /**
   * Post-hoc error observed AFTER the upstream status was recorded — e.g. a
   * `200` whose SSE body carries a `response.failed` server-overload event.
   * Never known at `record()` time; set later via {@link amend}. Absent on
   * healthy responses.
   */
  streamError?: string;
}

export interface AccountRouteActivityRecord extends AccountRouteActivityInput {
  id: string;
  ts: number;
  affinity: AccountRouteAffinity;
  previousAccountId?: string;
  /** For `provider-key` rows whose session switched keys (pool rotation). */
  previousKeyId?: string;
}

export interface AccountRouteActivityQuery {
  providerId?: string;
  accountId?: string;
  sessionKey?: string;
  credentialKind?: RouteCredentialKind;
  limit?: number;
}

function boundedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(ACCOUNT_ROUTE_ACTIVITY_LIMIT, Math.trunc(value as number)));
}

export class AccountRouteActivityStore {
  private readonly records: AccountRouteActivityRecord[] = [];
  private sequence = 0;

  record(input: AccountRouteActivityInput): AccountRouteActivityRecord {
    const ts = input.ts ?? Date.now();
    const sessionKey = input.sessionKey?.trim() || undefined;
    const credentialKind = input.credentialKind ?? 'subscription-account';
    // The identity affinity compares — the account id, or the pool key id.
    // Empty when a provider-key row had no resolvable key id (non-pool BYO):
    // such a provider serves with one static key, so `sticky` remains truthful.
    const credentialId = credentialKind === 'provider-key'
      ? input.keyId ?? ''
      : input.accountId ?? '';
    const previous = sessionKey
      ? this.records.find((record) =>
          record.providerId === input.providerId &&
          record.endpoint === input.endpoint &&
          record.sessionKey === sessionKey)
      : undefined;
    const previousId = previous
      ? (previous.credentialKind ?? 'subscription-account') === 'provider-key'
        ? previous.keyId ?? ''
        : previous.accountId ?? ''
      : undefined;
    const affinity: AccountRouteAffinity = !sessionKey
      ? 'untracked'
      : !previous
        ? 'new'
        : previousId === credentialId
          ? 'sticky'
          : 'switched';
    const record: AccountRouteActivityRecord = {
      ...input,
      credentialKind,
      id: `${ts.toString(36)}-${(this.sequence++).toString(36)}`,
      ts,
      sessionKey,
      affinity,
      ...(affinity === 'switched' && previous && credentialKind === 'subscription-account' && previous.accountId
        ? { previousAccountId: previous.accountId }
        : {}),
      ...(affinity === 'switched' && previous && credentialKind === 'provider-key' && previous.keyId
        ? { previousKeyId: previous.keyId }
        : {}),
    };
    this.records.unshift(record);
    if (this.records.length > ACCOUNT_ROUTE_ACTIVITY_LIMIT) {
      this.records.length = ACCOUNT_ROUTE_ACTIVITY_LIMIT;
    }
    return { ...record };
  }

  list(query: AccountRouteActivityQuery = {}): AccountRouteActivityRecord[] {
    const providerId = query.providerId?.trim();
    const accountId = query.accountId?.trim();
    const sessionKey = query.sessionKey?.trim();
    return this.records
      .filter((record) => !providerId || record.providerId === providerId)
      .filter((record) => !accountId || record.accountId === accountId)
      .filter((record) => !sessionKey || record.sessionKey === sessionKey)
      .filter((record) => !query.credentialKind || (record.credentialKind ?? 'subscription-account') === query.credentialKind)
      .slice(0, boundedLimit(query.limit))
      .map((record) => ({ ...record }));
  }

  clear(): void {
    this.records.length = 0;
    this.sequence = 0;
  }

  /**
   * Backfill a field on an already-recorded entry. Used to annotate a record
   * AFTER the upstream body streams — e.g. a `200` whose SSE body carries a
   * `response.failed` overload event is only detectable mid-relay, long after
   * `record()` stamped the 200 status. `patch` is intentionally narrow: only
   * post-hoc-observable fields belong here, never the routing-decision fields.
   * No-op when the id has already aged out of the bounded ring.
   */
  amend(
    id: string,
    patch: Partial<Pick<AccountRouteActivityRecord, 'streamError'>>,
  ): void {
    const record = this.records.find((r) => r.id === id);
    if (record) Object.assign(record, patch);
  }
}

const sharedAccountRouteActivity = new AccountRouteActivityStore();

export function getSharedAccountRouteActivity(): AccountRouteActivityStore {
  return sharedAccountRouteActivity;
}

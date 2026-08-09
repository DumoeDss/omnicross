/**
 * Bounded, metadata-only history of subscription account routing decisions.
 *
 * Records are created at the shared upstream fetch seam, after authentication has
 * reported the account that will actually serve the request. The store is
 * intentionally process-local: it is useful for live operator diagnostics without
 * turning session/account affinity into a durable tracking database.
 */

export const ACCOUNT_ROUTE_ACTIVITY_LIMIT = 300;

export type AccountRouteEndpoint = 'responses' | 'messages';

export type AccountRouteSessionSource =
  | 'session-header'
  | 'thread-header'
  | 'body-session-id'
  | 'body-thread-id'
  | 'prompt-cache-key'
  | 'content-fingerprint'
  | 'api-key-fallback'
  | 'none';

export type AccountRouteAffinity = 'new' | 'sticky' | 'switched' | 'untracked';

export interface AccountRouteActivityInput {
  providerId: string;
  accountId: string;
  endpoint: AccountRouteEndpoint;
  sessionKey?: string;
  sessionSource: AccountRouteSessionSource;
  model: string;
  status: number;
  durationMs: number;
  ts?: number;
}

export interface AccountRouteActivityRecord extends AccountRouteActivityInput {
  id: string;
  ts: number;
  affinity: AccountRouteAffinity;
  previousAccountId?: string;
}

export interface AccountRouteActivityQuery {
  providerId?: string;
  accountId?: string;
  sessionKey?: string;
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
    const previous = sessionKey
      ? this.records.find((record) =>
          record.providerId === input.providerId &&
          record.endpoint === input.endpoint &&
          record.sessionKey === sessionKey)
      : undefined;
    const affinity: AccountRouteAffinity = !sessionKey
      ? 'untracked'
      : !previous
        ? 'new'
        : previous.accountId === input.accountId
          ? 'sticky'
          : 'switched';
    const record: AccountRouteActivityRecord = {
      ...input,
      id: `${ts.toString(36)}-${(this.sequence++).toString(36)}`,
      ts,
      sessionKey,
      affinity,
      ...(affinity === 'switched' && previous ? { previousAccountId: previous.accountId } : {}),
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
      .slice(0, boundedLimit(query.limit))
      .map((record) => ({ ...record }));
  }

  clear(): void {
    this.records.length = 0;
    this.sequence = 0;
  }
}

const sharedAccountRouteActivity = new AccountRouteActivityStore();

export function getSharedAccountRouteActivity(): AccountRouteActivityStore {
  return sharedAccountRouteActivity;
}

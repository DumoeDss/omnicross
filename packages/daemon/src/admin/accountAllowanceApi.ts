/** Minimal, auth-gated admin API for secret-free account allowance snapshots. */

import type http from 'node:http';

import type { AccountAllowanceSnapshot } from '@omnicross/contracts/account-allowance-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import type { AccountAllowanceSchedulingStatus } from '../allowance/AccountAllowanceService';

export interface AccountAllowanceAdminReader {
  list(filter?: {
    providerId?: SubscriptionProviderId;
    accountId?: string;
  }): Promise<AccountAllowanceSnapshot[]>;
  refreshClaude(accountId?: string): Promise<AccountAllowanceSnapshot[]>;
  removeAccountSnapshot?(providerId: SubscriptionProviderId, accountId: string): void;
  removeProviderSnapshots?(providerId: SubscriptionProviderId): void;
  getSchedulingStatus?(): AccountAllowanceSchedulingStatus;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function writeError(res: http.ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: { type: 'account_allowance_error', message } });
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = text ? JSON.parse(text) as unknown : {};
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function query(req: http.IncomingMessage): URLSearchParams {
  const raw = req.url ?? '';
  const index = raw.indexOf('?');
  return new URLSearchParams(index >= 0 ? raw.slice(index + 1) : '');
}

function allowanceProvider(value: string | null): 'claude' | 'codex' | undefined | null {
  if (!value) return undefined;
  return value === 'claude' || value === 'codex' ? value : null;
}

/**
 * Routes mounted below `/admin/api/accounts/allowances`:
 * - GET `/` (optional `providerId`/`accountId` query)
 * - GET `/:providerId/:accountId`
 * - GET `/scheduling` (secret-free policy + applied-decision history)
 * - POST `/refresh` with optional `{ accountId }` (Claude only)
 */
export async function handleAccountAllowanceApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  service: AccountAllowanceAdminReader | undefined,
): Promise<void> {
  if (!service) return writeError(res, 501, 'account allowance service is not available');

  if (method === 'GET' && rest.length === 1 && rest[0] === 'scheduling') {
    if (!service.getSchedulingStatus) {
      return writeError(res, 501, 'allowance scheduling diagnostics are not available');
    }
    return writeJson(res, 200, { scheduling: service.getSchedulingStatus() });
  }

  if (method === 'GET') {
    const params = query(req);
    const pathProvider = rest.length >= 2 ? rest[0] : null;
    const providerId = allowanceProvider(pathProvider ?? params.get('providerId') ?? params.get('provider'));
    if (providerId === null) return writeError(res, 400, 'providerId must be claude or codex');
    const accountId = rest.length >= 2 ? rest[1] : params.get('accountId') ?? undefined;
    const allowances = await service.list({ providerId, accountId });
    return writeJson(res, 200, { allowances });
  }

  if (method === 'POST' && rest[0] === 'refresh') {
    const body = await readJson(req);
    const requestedProvider = allowanceProvider(
      typeof body['providerId'] === 'string' ? body['providerId'] : 'claude',
    );
    if (requestedProvider !== 'claude') {
      return writeError(res, 400, 'only Claude allowances support explicit refresh');
    }
    const accountId = typeof body['accountId'] === 'string' && body['accountId'].trim()
      ? body['accountId'].trim()
      : undefined;
    const allowances = await service.refreshClaude(accountId);
    if (accountId && allowances.length === 0) {
      return writeError(res, 404, `Claude account '${accountId}' not found`);
    }
    return writeJson(res, 200, { allowances });
  }

  return writeError(res, 405, `method ${method} not allowed on account allowances`);
}

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
  /** Optional: Codex active `/wham/usage` refresh (absent on older daemons). */
  refreshCodex?(accountId?: string): Promise<AccountAllowanceSnapshot[]>;
  /** Optional: Kimi `/coding/v1/usages` refresh (absent on older daemons). */
  refreshKimi?(accountId?: string): Promise<AccountAllowanceSnapshot[]>;
  /** Optional: OpenCodeGo `/v1/usage` refresh (absent on older daemons). */
  refreshOpenCodeGo?(accountId?: string): Promise<AccountAllowanceSnapshot[]>;
  /** Optional: Grok CLI-billing refresh (absent on older daemons). */
  refreshGrok?(accountId?: string): Promise<AccountAllowanceSnapshot[]>;
  /** Optional: Copilot user-quota refresh (absent on older daemons). */
  refreshCopilot?(accountId?: string): Promise<AccountAllowanceSnapshot[]>;
  /** Optional: Gemini Code-Assist quota refresh (absent on older daemons). */
  refreshGemini?(accountId?: string): Promise<AccountAllowanceSnapshot[]>;
  /** Optional: Antigravity quotaSummary refresh (absent on older daemons). */
  refreshAntigravity?(accountId?: string): Promise<AccountAllowanceSnapshot[]>;
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

function allowanceProvider(
  value: string | null,
): 'claude' | 'codex' | 'kimi' | 'opencodego' | 'grok' | 'copilot' | 'gemini' | 'antigravity' | undefined | null {
  if (!value) return undefined;
  return value === 'claude' || value === 'codex' || value === 'kimi' || value === 'opencodego' || value === 'grok' || value === 'copilot' || value === 'gemini' || value === 'antigravity'
    ? value
    : null;
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
    if (providerId === null) {
      return writeError(res, 400, 'providerId must be claude, codex, kimi, opencodego, grok, copilot, or gemini');
    }
    const accountId = rest.length >= 2 ? rest[1] : params.get('accountId') ?? undefined;
    const allowances = await service.list({ providerId, accountId });
    return writeJson(res, 200, { allowances });
  }

  if (method === 'POST' && rest[0] === 'refresh') {
    const body = await readJson(req);
    const requestedProvider = allowanceProvider(
      typeof body['providerId'] === 'string' ? body['providerId'] : 'claude',
    );
    const accountId = typeof body['accountId'] === 'string' && body['accountId'].trim()
      ? body['accountId'].trim()
      : undefined;
    // Codex refreshes via the active `/wham/usage` poll (no quota spent) and
    // Kimi via `/coding/v1/usages`; both are optional on the reader so an
    // older service still answers Claude.
    if (requestedProvider === 'codex') {
      if (!service.refreshCodex) {
        return writeError(res, 501, 'codex allowance refresh is not available');
      }
      const allowances = await service.refreshCodex(accountId);
      if (accountId && allowances.length === 0) {
        return writeError(res, 404, `Codex account '${accountId}' not found`);
      }
      return writeJson(res, 200, { allowances });
    }
    if (requestedProvider === 'kimi') {
      if (!service.refreshKimi) {
        return writeError(res, 501, 'kimi allowance refresh is not available');
      }
      const allowances = await service.refreshKimi(accountId);
      if (accountId && allowances.length === 0) {
        return writeError(res, 404, `Kimi account '${accountId}' not found`);
      }
      return writeJson(res, 200, { allowances });
    }
    if (requestedProvider === 'opencodego') {
      if (!service.refreshOpenCodeGo) {
        return writeError(res, 501, 'opencodego allowance refresh is not available');
      }
      const allowances = await service.refreshOpenCodeGo(accountId);
      if (accountId && allowances.length === 0) {
        return writeError(res, 404, `OpenCodeGo account '${accountId}' not found`);
      }
      return writeJson(res, 200, { allowances });
    }
    if (requestedProvider === 'copilot') {
      if (!service.refreshCopilot) {
        return writeError(res, 501, 'copilot allowance refresh is not available');
      }
      const allowances = await service.refreshCopilot(accountId);
      if (accountId && allowances.length === 0) {
        return writeError(res, 404, `Copilot account '${accountId}' not found`);
      }
      return writeJson(res, 200, { allowances });
    }
    if (requestedProvider === 'grok') {
      if (!service.refreshGrok) {
        return writeError(res, 501, 'grok allowance refresh is not available');
      }
      const allowances = await service.refreshGrok(accountId);
      if (accountId && allowances.length === 0) {
        return writeError(res, 404, `Grok account '${accountId}' not found`);
      }
      return writeJson(res, 200, { allowances });
    }
    if (requestedProvider === 'antigravity') {
      if (!service.refreshAntigravity) {
        return writeError(res, 501, 'antigravity allowance refresh is not available');
      }
      const allowances = await service.refreshAntigravity(accountId);
      if (accountId && allowances.length === 0) {
        return writeError(res, 404, `Antigravity account '${accountId}' not found`);
      }
      return writeJson(res, 200, { allowances });
    }
    if (requestedProvider === 'gemini') {
      if (!service.refreshGemini) {
        return writeError(res, 501, 'gemini allowance refresh is not available');
      }
      const allowances = await service.refreshGemini(accountId);
      if (accountId && allowances.length === 0) {
        return writeError(res, 404, `Gemini account '${accountId}' not found`);
      }
      return writeJson(res, 200, { allowances });
    }
    const allowances = await service.refreshClaude(accountId);
    if (accountId && allowances.length === 0) {
      return writeError(res, 404, `Claude account '${accountId}' not found`);
    }
    return writeJson(res, 200, { allowances });
  }

  return writeError(res, 405, `method ${method} not allowed on account allowances`);
}

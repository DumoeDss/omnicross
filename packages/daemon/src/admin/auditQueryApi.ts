/**
 * auditQueryApi — the AUTHED `GET /admin/api/audit?keyId=&from=&to=&limit=`
 * handler (request-audit-log, design D6).
 *
 * Audit records carry client IP / user-agent (PII) and, when body capture is on,
 * redacted bodies — so unlike the coarse `/health` boolean they are served ONLY
 * behind the admin auth gate. This lives in its OWN helper module (the
 * #4/#8/#10 helper-module convention) so `adminApi.ts` — at its line cap — is not
 * touched: `AdminServer.dispatch` routes the path here directly, AFTER its auth
 * gate. NEVER unauthenticated, NEVER surfaced on `/health`.
 *
 * SECRET-FREE by construction: it returns exactly the stored records, which never
 * hold key material / tokens / Authorization (headers are never captured).
 *
 * @module @omnicross/daemon/admin/auditQueryApi
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuditRecord } from '@omnicross/contracts/audit-types';

import type { AuditQuery } from '../audit/auditReader';

/** The read surface the AdminServer consumes (bootstrap binds it to the store). */
export type AuditQueryReader = (query: AuditQuery) => AuditRecord[];

/** Parse a finite integer query param, or `undefined` when absent/invalid. */
function intParam(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * Serve the audit query. Reads `keyId`/`from`/`to`/`limit` from the URL, filters
 * via the injected reader, and returns `{ records }` newest-first. Empty when the
 * reader is unwired (audit never enabled).
 */
export function handleAuditQuery(
  req: IncomingMessage,
  res: ServerResponse,
  reader: AuditQueryReader | undefined,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query: AuditQuery = {};
  const keyId = url.searchParams.get('keyId');
  if (keyId && keyId.trim()) query.keyId = keyId.trim();
  const from = intParam(url.searchParams.get('from'));
  if (from !== undefined) query.from = from;
  const to = intParam(url.searchParams.get('to'));
  if (to !== undefined) query.to = to;
  const limit = intParam(url.searchParams.get('limit'));
  if (limit !== undefined) query.limit = limit;

  const records = reader ? reader(query) : [];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ records }));
}

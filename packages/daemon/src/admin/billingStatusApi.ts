/**
 * billingStatusApi — the AUTHED `GET /admin/api/billing-status` handler
 * (billing-event-stream, design D5/P2).
 *
 * Returns the SECRET-FREE aggregate delivery status of the durable billing ledger
 * (total / delivered / pending counts) so the admin UI can show a delivery
 * indicator. Lives in its OWN helper module (the #4/#8/#10/#13 convention) so
 * `adminApi.ts` — at its line cap — is not touched: `AdminServer.dispatch` routes
 * the path here directly, AFTER its auth gate. Carries no secret and no event
 * payload — only counts.
 *
 * @module @omnicross/daemon/admin/billingStatusApi
 */

import type { ServerResponse } from 'node:http';

import type { BillingDeliveryStatus } from '@omnicross/contracts/billing-types';

/** The read surface the AdminServer consumes (bootstrap binds it to the ledger dir). */
export type BillingStatusReader = () => BillingDeliveryStatus;

/** Serve the billing delivery status. Zeroed when the reader is unwired (never enabled). */
export function handleBillingStatus(res: ServerResponse, reader: BillingStatusReader | undefined): void {
  const status: BillingDeliveryStatus = reader ? reader() : { total: 0, delivered: 0, pending: 0 };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status }));
}

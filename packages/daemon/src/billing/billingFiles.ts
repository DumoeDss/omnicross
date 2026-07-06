/**
 * billingFiles — shared date-file naming for the billing ledger store
 * (billing-event-stream, design D2/D5). One SSOT for the two file conventions
 * shared by the publisher (which files to append to), the reader (which files a
 * status/reconcile query spans), and the retry sweeper (which events are still
 * undelivered):
 *
 *  - EVENT LEDGER    `billing-YYYY-MM-DD.jsonl`     — one {@link BillingEvent} per
 *                    line. The DURABLE source of truth; a financial record, so it
 *                    is NEVER auto-pruned (unlike the #13 audit TTL).
 *  - DELIVERY MARKER `delivered-YYYY-MM-DD.jsonl`   — one `{ id, deliveredAt }`
 *                    per line, appended when the built-in POST is acked. A separate
 *                    file so the ledger line itself is immutable append-only.
 *
 * The date is the LOCAL calendar date of the event's timestamp (parity with the
 * usage-events + audit LOCAL-time bucketing).
 *
 * @module @omnicross/daemon/billing/billingFiles
 */

/** Matches a valid billing EVENT ledger file, capturing Y/M/D. */
export const BILLING_FILE_RE = /^billing-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
/** Matches a valid billing DELIVERY-marker file, capturing Y/M/D. */
export const DELIVERED_FILE_RE = /^delivered-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

const pad2 = (n: number): string => String(n).padStart(2, '0');

function dateStamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The `billing-YYYY-MM-DD.jsonl` event-ledger file name for a timestamp (LOCAL date). */
export function billingFileName(ts: number): string {
  return `billing-${dateStamp(ts)}.jsonl`;
}

/** The `delivered-YYYY-MM-DD.jsonl` delivery-marker file name for a timestamp (LOCAL date). */
export function deliveredFileName(ts: number): string {
  return `delivered-${dateStamp(ts)}.jsonl`;
}

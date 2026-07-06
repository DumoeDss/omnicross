/**
 * billingReader — read + reconcile the date-rotated billing ledger
 * (billing-event-stream, design D2/D5). Backs BOTH the retry sweep (which events
 * are still UNdelivered) and the authed admin delivery-status view (secret-free
 * counts). Reads the `billing-*.jsonl` event files + the `delivered-*.jsonl`
 * marker files, parses defensively (a torn final line never poisons a read), and
 * unions the marker ids into a delivered set.
 *
 * @module @omnicross/daemon/billing/billingReader
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BillingDeliveryStatus, BillingEvent } from '@omnicross/contracts/billing-types';

import { BILLING_FILE_RE, DELIVERED_FILE_RE } from './billingFiles';

/** The reconciled ledger view: every event + the set of delivered ids. */
export interface BillingLedgerView {
  events: BillingEvent[];
  deliveredIds: Set<string>;
}

/** Read + parse every ledger event file (newest date last) and the delivery markers. */
export function readBillingLedger(billingDir: string): BillingLedgerView {
  const view: BillingLedgerView = { events: [], deliveredIds: new Set() };
  if (!existsSync(billingDir)) return view;
  let files: string[];
  try {
    files = readdirSync(billingDir);
  } catch {
    return view;
  }
  for (const file of files.sort()) {
    if (BILLING_FILE_RE.test(file)) {
      for (const rec of parseLines(billingDir, file)) {
        if (isBillingEvent(rec)) view.events.push(rec);
      }
    } else if (DELIVERED_FILE_RE.test(file)) {
      for (const rec of parseLines(billingDir, file)) {
        const id = (rec as { id?: unknown }).id;
        if (typeof id === 'string') view.deliveredIds.add(id);
      }
    }
  }
  return view;
}

/**
 * The UNdelivered events (ledger events whose id has no delivery marker), oldest
 * first. The retry sweep re-POSTs these; the request id makes a re-POST safe.
 */
export function readUndeliveredEvents(billingDir: string): BillingEvent[] {
  const { events, deliveredIds } = readBillingLedger(billingDir);
  return events.filter((e) => !deliveredIds.has(e.id)).sort((a, b) => a.ts - b.ts);
}

/** Aggregate secret-free delivery status for the admin view. */
export function readBillingStatus(billingDir: string): BillingDeliveryStatus {
  const { events, deliveredIds } = readBillingLedger(billingDir);
  let delivered = 0;
  for (const e of events) if (deliveredIds.has(e.id)) delivered += 1;
  return { total: events.length, delivered, pending: events.length - delivered };
}

/** Read a jsonl file, yielding each parseable object; torn/garbage lines skipped. */
function parseLines(dir: string, file: string): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, file), 'utf8');
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* torn/garbage line — skip */
    }
  }
  return out;
}

/** Minimal structural guard for a ledger event line. */
function isBillingEvent(value: unknown): value is BillingEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['ts'] === 'number' &&
    typeof r['model'] === 'string' &&
    typeof r['status'] === 'number'
  );
}

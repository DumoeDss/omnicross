/**
 * voucherRedeem — the key-authenticated `POST <base>/redeem` handler
 * (voucher-redemption #9, design D1/D4/D5/D6; MJ1/M2/MJ2/M3 fix).
 *
 * A key presents its own outbound secret (already verified by the caller) plus a
 * card `{ code }`; the card's value applies to THAT key. The critical section is
 * SERIALIZED PER KEY (an async `KeyedMutex`) so two redemptions for the same key
 * run one-after-another — the fix for concurrent value loss (MJ1). Each redeem:
 *   1. RECONCILE any stranded (`redeemed && grantApplied !== true`) card for this
 *      key FIRST — re-applying its recorded ABSOLUTE target and marking it — so a
 *      prior card's grant settles BEFORE this redeem computes anything (M2: the
 *      recorded absolute is therefore never stale).
 *   2. hash the code → look up → require `unredeemed`.
 *   3. compute the grant from the CURRENT policy read inside the mutex — this is
 *      the intended final ABSOLUTE key value (`min(current + credit, cap)` /
 *      `min(current + days, now + capDays)`). Because the mutex serialized step 1,
 *      "current" already includes every earlier card, so concurrent DIFFERENT
 *      cards accumulate correctly.
 *   4. ATOMIC CAS flip `unredeemed → redeemed` recording that absolute +
 *      `grantApplied = false` — the single-use guard.
 *   5. apply `setPolicy(key, <recorded absolute>)`; on success set
 *      `grantApplied = true`.
 *
 * Crash-safety WITHOUT double-credit (MJ2): the apply target is the recorded
 * ABSOLUTE, applied idempotently on BOTH the first pass AND the reconcile — so a
 * crash between the `setPolicy` and the `grantApplied` mark just re-applies the
 * SAME absolute (a no-op), never a second credit. If the apply FAILS on the first
 * pass (key revoked mid-redeem, M3) the flip is REVERTED and the holder gets an
 * error. Redeem attempts are rate-limited (D6). The response reveals ONLY this
 * key's own balance.
 *
 * @module outbound-api/voucherRedeem
 */

import type http from 'node:http';

import type { VoucherGrant, VoucherRecord, VoucherRedeemResult } from '@omnicross/contracts/voucher-types';

import { KeyedMutex } from './keyedMutex';
import { hashKey } from './outboundApiKeyAuth';
import type { OutboundRateLimiter } from './outboundRateLimiter';
import type { OutboundApiDeps, OutboundKeyDbRow } from './types';
import { computeVoucherGrant, hashVoucherCode } from './voucher';

/** True for `POST <base>/redeem` (or `/v1/redeem`) — the redeem endpoint. */
export function isRedeemRequest(method: string | undefined, url: string | undefined): boolean {
  if (method !== 'POST' || !url) return false;
  const path = url.split('?')[0]?.replace(/\/+$/, '') ?? '';
  return path.endsWith('/redeem');
}

/** The internal outcome of the mutex-guarded critical section. */
type RedeemOutcome =
  | { ok: true; result: VoucherRedeemResult }
  | { ok: false; status: number; message: string };

/** Write a JSON error (mirrors the router's shape). */
function writeErr(res: http.ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ error: { type: 'voucher_error', message } }));
}

/** Write the success body — ONLY this key's own new balance/expiry (design D2). */
function writeResult(res: http.ServerResponse, result: VoucherRedeemResult): void {
  if (res.headersSent) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ...result }));
}

/** Read the full request body as a string. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Project an absolute grant to the key-facing result DTO. */
function grantToResult(type: VoucherRecord['type'], granted: VoucherGrant): VoucherRedeemResult {
  const result: VoucherRedeemResult = { type };
  if (granted.totalCostLimitUsd != null) result.totalCostLimitUsd = granted.totalCostLimitUsd;
  if (granted.expiresAt != null) result.expiresAt = granted.expiresAt;
  return result;
}

/** Build the current balance result from a key row (for the idempotent no-op). */
function currentResult(type: VoucherRecord['type'], keyRow: OutboundKeyDbRow | null): VoucherRedeemResult {
  const result: VoucherRedeemResult = { type };
  if (type === 'credit') {
    if (keyRow?.totalCostLimitUsd != null) result.totalCostLimitUsd = keyRow.totalCostLimitUsd;
  } else if (keyRow?.expiresAt != null) {
    result.expiresAt = keyRow.expiresAt;
  }
  return result;
}

/** The ABSOLUTE grant recorded on a redeemed voucher (the apply source). */
function recordedAbsolute(v: VoucherRecord): VoucherGrant {
  const granted: VoucherGrant = {};
  if (v.grantedTotalCostLimitUsd != null) granted.totalCostLimitUsd = v.grantedTotalCostLimitUsd;
  if (v.grantedExpiresAt != null) granted.expiresAt = v.grantedExpiresAt;
  return granted;
}

/** The key-policy patch for an absolute grant. */
function policyFrom(granted: VoucherGrant): { totalCostLimitUsd?: number; expiresAt?: number } {
  const policy: { totalCostLimitUsd?: number; expiresAt?: number } = {};
  if (granted.totalCostLimitUsd != null) policy.totalCostLimitUsd = granted.totalCostLimitUsd;
  if (granted.expiresAt != null) policy.expiresAt = granted.expiresAt;
  return policy;
}

/** The rejection body for an unknown / non-redeemable code (no leak). */
const NOT_REDEEMABLE = 'Invalid or non-redeemable code';

/**
 * The process-shared redeem mutex fallback for callers (tests) that do not supply
 * one. The real server supplies its own instance so per-key serialization holds
 * across concurrent requests.
 */
let fallbackMutex: KeyedMutex | null = null;
function getFallbackMutex(): KeyedMutex {
  fallbackMutex ??= new KeyedMutex();
  return fallbackMutex;
}

/**
 * Handle a redeem request. `deps` carries the voucher store + the key DB; the key
 * is ALREADY verified by the router (`verifiedKeyId` / `presentedKey`). Gated on
 * `voucherEnabled` (disabled ⇒ inert). `redeemLimiter` throttles attempts (D6);
 * `redeemMutex` serializes a key's redemptions (MJ1 fix).
 */
export async function handleVoucherRedeem(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: OutboundApiDeps,
  voucherEnabled: boolean,
  redeemLimiter: OutboundRateLimiter,
  verifiedKeyId: string,
  presentedKey: string,
  now: number,
  redeemMutex?: KeyedMutex,
): Promise<void> {
  // Feature gate (design D8): disabled ⇒ inert, no store touched, no key mutated.
  if (!voucherEnabled || !deps.voucherDb) {
    writeErr(res, 403, 'Voucher redemption is not enabled');
    return;
  }
  const voucherDb = deps.voucherDb;

  // Redeem-attempt rate limit (design D6) — keyed by the authenticating key id.
  // EVERY attempt (incl. a bad code) counts, so brute-forcing `CC_` is throttled.
  const rl = redeemLimiter.check(verifiedKeyId, now);
  if (!rl.allowed) {
    writeErr(res, 429, 'Too many redeem attempts', { 'Retry-After': String(rl.retryAfterSeconds) });
    return;
  }

  // Parse `{ code }`. The code is a CREDENTIAL — never logged, only hashed.
  const raw = await readBody(req);
  let code: unknown;
  try {
    code = raw ? (JSON.parse(raw) as Record<string, unknown>)['code'] : undefined;
  } catch {
    writeErr(res, 400, 'Invalid JSON in request body');
    return;
  }
  if (typeof code !== 'string' || !code.trim()) {
    writeErr(res, 400, 'Missing redemption code');
    return;
  }
  const codeHash = hashVoucherCode(code.trim());
  const keyHash = hashKey(presentedKey.trim());

  // Apply an ABSOLUTE grant on the FIRST pass: idempotent setPolicy, then mark. On
  // failure (M3) revert the flip so the card is not lost — never a silent 200.
  const applyFirstPass = async (voucher: VoucherRecord, absolute: VoucherGrant): Promise<RedeemOutcome> => {
    const ok = await deps.db.outboundApiKeysSetPolicy(verifiedKeyId, policyFrom(absolute));
    if (!ok) {
      await voucherDb.voucherRevertRedeem(voucher.id, verifiedKeyId);
      return { ok: false, status: 409, message: 'Could not apply the grant — please retry' };
    }
    await voucherDb.voucherMarkGrantApplied(voucher.id);
    return { ok: true, result: grantToResult(voucher.type, absolute) };
  };

  // Best-effort reconcile of ONE stranded card: re-apply its recorded ABSOLUTE
  // (idempotent — never double-credits) and mark it. A failed setPolicy leaves the
  // card stranded for a later retry (no revert here — the flip may predate a crash).
  const reconcileOne = async (voucher: VoucherRecord): Promise<void> => {
    const ok = await deps.db.outboundApiKeysSetPolicy(verifiedKeyId, policyFrom(recordedAbsolute(voucher)));
    if (ok) await voucherDb.voucherMarkGrantApplied(voucher.id);
  };

  // Reconcile every stranded (flipped-but-unapplied) card for THIS key, oldest
  // first, BEFORE the current redeem computes anything — so "current" is fully
  // settled and no stranded card's recorded absolute is stale (M2/MJ2).
  const reconcileStranded = async (): Promise<void> => {
    const all = await voucherDb.voucherList();
    const stranded = all
      .filter((v) => v.status === 'redeemed' && v.grantApplied !== true && v.redeemedByKeyId === verifiedKeyId)
      .sort((a, b) => (a.redeemedAt ?? 0) - (b.redeemedAt ?? 0));
    for (const v of stranded) await reconcileOne(v);
  };

  const runCritical = async (): Promise<RedeemOutcome> => {
    // 1. Settle any stranded grant for this key first.
    await reconcileStranded();

    const voucher = await voucherDb.voucherGetByHash(codeHash);
    // Unknown / revoked → a single generic rejection (never reveal which cards
    // exist or their state beyond "not redeemable").
    if (!voucher || voucher.status === 'revoked') {
      return { ok: false, status: 400, message: NOT_REDEEMABLE };
    }

    if (voucher.status === 'redeemed') {
      // Single-key binding: a card redeemed by a DIFFERENT key is rejected.
      if (voucher.redeemedByKeyId !== verifiedKeyId) {
        return { ok: false, status: 400, message: NOT_REDEEMABLE };
      }
      // Already applied (the common case after `reconcileStranded`) ⇒ idempotent
      // no-op (report the current balance). Still unapplied ⇒ the reconcile could
      // not apply it (transient key error) — try once and revert+409 on failure.
      if (voucher.grantApplied === true) {
        const keyRow = await deps.db.outboundApiKeysGetByHash(keyHash);
        return { ok: true, result: currentResult(voucher.type, keyRow) };
      }
      return await applyFirstPass(voucher, recordedAbsolute(voucher));
    }

    // `unredeemed`: compute the ABSOLUTE target from the (settled) CURRENT policy,
    // record it on the CAS flip, then apply it.
    const keyRow = await deps.db.outboundApiKeysGetByHash(keyHash);
    const absolute = computeVoucherGrant(voucher, keyRow, now);
    const won = await voucherDb.voucherRedeemCas(voucher.id, verifiedKeyId, absolute, now);
    if (!won) {
      // Lost the CAS to ANOTHER key (different-key races are not serialized by our
      // per-key mutex). If somehow ours, apply the recorded absolute; else reject.
      const after = await voucherDb.voucherGetByHash(codeHash);
      if (after?.status === 'redeemed' && after.redeemedByKeyId === verifiedKeyId) {
        return after.grantApplied === true
          ? { ok: true, result: currentResult(after.type, await deps.db.outboundApiKeysGetByHash(keyHash)) }
          : await applyFirstPass(after, recordedAbsolute(after));
      }
      return { ok: false, status: 409, message: 'Code was already redeemed' };
    }
    return await applyFirstPass(voucher, absolute);
  };

  // Serialize the whole critical section per KEY so concurrent DIFFERENT-card
  // redeems by one key accumulate (each reads the prior card's settled result).
  const mutex = redeemMutex ?? getFallbackMutex();
  const outcome = await mutex.runExclusive(verifiedKeyId, runCritical);

  if (outcome.ok) writeResult(res, outcome.result);
  else writeErr(res, outcome.status, outcome.message);
}

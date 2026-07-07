/**
 * voucherAdmin — the admin API's voucher (redemption-card) surface
 * (voucher-redemption #9, design D2/D3/D6). Extracted from `adminApi.ts` (at its
 * line cap) so the card lifecycle lives in one place the router merely dispatches
 * to (`case 'voucher'`).
 *
 * Admin can GENERATE (returns the plaintext `CC_…` ONCE), LIST (safe DTOs — never
 * the code hash), and REVOKE (an UNREDEEMED card only). Generation + revocation
 * are gated on `voucher.enabled` (design D8 — the product is inert when disabled).
 * Redemption itself is NOT here — it is key-self-serve on the outbound server.
 *
 * SECRET DISCIPLINE: the plaintext code crosses the wire ONLY in the create
 * response (`plaintextOnce`); it is never persisted (only its sha256 hash is) nor
 * logged. The admin list projects through `toVoucherInfo`, which strips the hash.
 *
 * @module @omnicross/daemon/admin/voucherAdmin
 */

import http from 'node:http';

import type { VoucherType } from '@omnicross/contracts/voucher-types';
import {
  generateVoucherCode,
  hashVoucherCode,
  loadServerConfig,
  newVoucherId,
  toVoucherInfo,
  type VoucherCreateInput,
  type VoucherDb,
  voucherCodePrefix,
} from '@omnicross/core/outbound-api';

import type { ApiServerSettingsStore } from '@omnicross/core/outbound-api';

/** The subset of admin deps the voucher surface needs. */
export interface VoucherAdminDeps {
  /** The voucher store (absent ⇒ the feature is not wired in this build). */
  readonly voucherDb?: VoucherDb;
  /** Outbound server settings store — read to gate on `voucher.enabled`. */
  readonly settingsStore: ApiServerSettingsStore;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function writeErr(res: http.ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: { type: 'voucher_error', message } });
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new Error('invalid-json'));
      }
    });
    req.on('error', reject);
  });
}

/** A positive finite number (optionally an integer), or undefined when absent. */
function optPositive(
  value: unknown,
  integer: boolean,
): { ok: true; value: number | undefined } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return { ok: false };
  if (integer && !Number.isInteger(value)) return { ok: false };
  return { ok: true, value };
}

/**
 * Parse + validate a voucher create body. `type` decides which value is REQUIRED:
 * `credit` needs `creditUsd > 0`, `renewal` needs a positive integer `renewalDays`.
 * The optional per-card caps (`maxTotalCostLimitUsd` / `maxExpiryDays`) are
 * positive when present. Anything malformed → a 400-worthy message.
 */
export function parseVoucherCreateBody(
  body: Record<string, unknown>,
): { ok: true; input: Omit<VoucherCreateInput, 'id' | 'codeHash' | 'codePrefix'> } | { ok: false; message: string } {
  const type = body['type'];
  if (type !== 'credit' && type !== 'renewal') {
    return { ok: false, message: "type must be 'credit' or 'renewal'" };
  }
  const maxTotal = optPositive(body['maxTotalCostLimitUsd'], false);
  if (!maxTotal.ok) return { ok: false, message: 'maxTotalCostLimitUsd must be a positive number' };
  const maxDays = optPositive(body['maxExpiryDays'], true);
  if (!maxDays.ok) return { ok: false, message: 'maxExpiryDays must be a positive integer' };

  const input: Omit<VoucherCreateInput, 'id' | 'codeHash' | 'codePrefix'> = { type: type as VoucherType };
  if (maxTotal.value !== undefined) input.maxTotalCostLimitUsd = maxTotal.value;
  if (maxDays.value !== undefined) input.maxExpiryDays = maxDays.value;

  if (type === 'credit') {
    const credit = optPositive(body['creditUsd'], false);
    if (!credit.ok || credit.value === undefined) {
      return { ok: false, message: 'creditUsd must be a positive number for a credit card' };
    }
    input.creditUsd = credit.value;
  } else {
    const days = optPositive(body['renewalDays'], true);
    if (!days.ok || days.value === undefined) {
      return { ok: false, message: 'renewalDays must be a positive integer for a renewal card' };
    }
    input.renewalDays = days.value;
  }
  return { ok: true, input };
}

/** True while the persisted `voucher.enabled` flag is on. */
async function voucherEnabled(deps: VoucherAdminDeps): Promise<boolean> {
  const config = await loadServerConfig(deps.settingsStore);
  return config.voucher?.enabled === true;
}

/**
 * Dispatch a `/admin/api/voucher[...]` request. Routes:
 *  - `GET  /admin/api/voucher`            → list (safe DTOs; always allowed).
 *  - `POST /admin/api/voucher`            → generate (gated; returns plaintext once).
 *  - `POST /admin/api/voucher/:id/revoke` → revoke an unredeemed card (gated).
 */
export async function handleVoucher(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: VoucherAdminDeps,
): Promise<void> {
  const voucherDb = deps.voucherDb;
  if (!voucherDb) return writeErr(res, 501, 'Voucher feature is not available');

  // LIST — always allowed (safe DTOs; an operator can inspect state even after
  // toggling the feature off). NEVER exposes the code hash.
  if (method === 'GET' && rest.length === 0) {
    const rows = await voucherDb.voucherList();
    return writeJson(res, 200, { vouchers: rows.map(toVoucherInfo) });
  }

  // GENERATE — gated on `voucher.enabled` (design D8; the product is inert off).
  if (method === 'POST' && rest.length === 0) {
    if (!(await voucherEnabled(deps))) return writeErr(res, 403, 'Voucher feature is disabled');
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      return writeErr(res, 400, 'Invalid JSON in request body');
    }
    const parsed = parseVoucherCreateBody(body);
    if (!parsed.ok) return writeErr(res, 400, parsed.message);
    // Generate the CREDENTIAL: plaintext returned once, only the hash stored.
    const code = generateVoucherCode();
    const created = await voucherDb.voucherCreate({
      id: newVoucherId(),
      codeHash: hashVoucherCode(code),
      codePrefix: voucherCodePrefix(code),
      ...parsed.input,
    });
    return writeJson(res, 201, {
      id: created.id,
      codePrefix: created.codePrefix,
      type: created.type,
      createdAt: created.createdAt,
      // `plaintextOnce` is the ONLY place the full code crosses the wire (D3).
      plaintextOnce: code,
    });
  }

  // REVOKE — gated; an UNREDEEMED card only (a redeemed card can't be revoked).
  const id = rest[0];
  if (method === 'POST' && id && rest[1] === 'revoke') {
    if (!(await voucherEnabled(deps))) return writeErr(res, 403, 'Voucher feature is disabled');
    const ok = await voucherDb.voucherRevokeCas(id, Date.now());
    return writeJson(res, ok ? 200 : 409, { ok });
  }

  return writeErr(res, 405, `method ${method} not allowed on voucher`);
}

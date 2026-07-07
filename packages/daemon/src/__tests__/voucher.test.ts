/**
 * voucher.test.ts — the daemon-side voucher store + admin surface
 * (voucher-redemption #9, design D3/D4/D6/D7).
 *
 * Port (`JsonVoucherDb`):
 *  - create stores only the code HASH + display prefix — NEVER the plaintext
 *    `CC_…` (a file scan asserts it).
 *  - `voucherRedeemCas` is single-use: the second (and concurrent) flip loses.
 *  - `voucherRevokeCas` revokes an unredeemed card only — a REDEEMED card can
 *    never be revoked.
 *  - the recorded absolute grant round-trips through the file (idempotent replay).
 *
 * Admin (`handleVoucher`): generate returns the plaintext ONCE + stores the hash;
 * generate/revoke are gated on `voucher.enabled`; the list projects safe DTOs
 * (never the hash); revoke of an unredeemed card succeeds, of a redeemed card 409s.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { ApiServerSettingsStore } from '@omnicross/core/outbound-api';
import { hashVoucherCode } from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleVoucher } from '../admin/voucherAdmin';
import { JsonVoucherDb } from '../ports/JsonVoucherDb';

let dir: string;
let vouchersPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omnicross-voucher-'));
  vouchersPath = join(dir, 'vouchers.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── Port ────────────────────────────────────────────────────────────────────

describe('JsonVoucherDb', () => {
  it('stores the hash + prefix, NEVER the plaintext code', async () => {
    const db = new JsonVoucherDb(vouchersPath);
    const code = 'CC_PLAINTEXTSECRET1234';
    await db.voucherCreate({
      id: 'vch_1',
      codeHash: hashVoucherCode(code),
      codePrefix: code.slice(0, 8),
      type: 'credit',
      creditUsd: 20,
    });
    const fileText = readFileSync(vouchersPath, 'utf8');
    expect(fileText).not.toContain(code);
    expect(fileText).not.toContain('PLAINTEXTSECRET');
    expect(fileText).toContain(hashVoucherCode(code));
    // Lookup is by hash.
    const found = await db.voucherGetByHash(hashVoucherCode(code));
    expect(found?.id).toBe('vch_1');
    expect(found?.status).toBe('unredeemed');
  });

  it('redeemCas is single-use: the second flip loses', async () => {
    const db = new JsonVoucherDb(vouchersPath);
    await db.voucherCreate({ id: 'vch_1', codeHash: 'h', codePrefix: 'CC_A', type: 'credit', creditUsd: 5 });
    const first = await db.voucherRedeemCas('vch_1', 'oak_1', { totalCostLimitUsd: 25 }, 1000);
    const second = await db.voucherRedeemCas('vch_1', 'oak_2', { totalCostLimitUsd: 99 }, 2000);
    expect(first).toBe(true);
    expect(second).toBe(false);
    // The recorded absolute target round-trips (idempotent replay input).
    const row = (await new JsonVoucherDb(vouchersPath).voucherList())[0];
    expect(row.status).toBe('redeemed');
    expect(row.redeemedByKeyId).toBe('oak_1');
    expect(row.grantedTotalCostLimitUsd).toBe(25);
  });

  it('concurrent redeemCas of one card → exactly one winner (atomic CAS)', async () => {
    const db = new JsonVoucherDb(vouchersPath);
    await db.voucherCreate({ id: 'vch_1', codeHash: 'h', codePrefix: 'CC_A', type: 'credit', creditUsd: 5 });
    const results = await Promise.all([
      db.voucherRedeemCas('vch_1', 'oak_A', { totalCostLimitUsd: 10 }, 1000),
      db.voucherRedeemCas('vch_1', 'oak_B', { totalCostLimitUsd: 20 }, 1000),
      db.voucherRedeemCas('vch_1', 'oak_C', { totalCostLimitUsd: 30 }, 1000),
    ]);
    expect(results.filter((r) => r === true)).toHaveLength(1);
    expect(results.filter((r) => r === false)).toHaveLength(2);
  });

  it('revokeCas revokes an unredeemed card but NEVER a redeemed one', async () => {
    const db = new JsonVoucherDb(vouchersPath);
    await db.voucherCreate({ id: 'a', codeHash: 'ha', codePrefix: 'CC_A', type: 'credit', creditUsd: 5 });
    await db.voucherCreate({ id: 'b', codeHash: 'hb', codePrefix: 'CC_B', type: 'credit', creditUsd: 5 });

    // Unredeemed → revoke succeeds; re-revoke fails (already revoked).
    expect(await db.voucherRevokeCas('a', 1000)).toBe(true);
    expect(await db.voucherRevokeCas('a', 2000)).toBe(false);

    // Redeemed → revoke is refused.
    await db.voucherRedeemCas('b', 'oak_1', { totalCostLimitUsd: 5 }, 1000);
    expect(await db.voucherRevokeCas('b', 2000)).toBe(false);
    const rows = await new JsonVoucherDb(vouchersPath).voucherList();
    expect(rows.find((r) => r.id === 'a')?.status).toBe('revoked');
    expect(rows.find((r) => r.id === 'b')?.status).toBe('redeemed');
  });

  it('redeemCas records grantApplied=false; markGrantApplied flips it true (idempotent)', async () => {
    const db = new JsonVoucherDb(vouchersPath);
    await db.voucherCreate({ id: 'v', codeHash: 'h', codePrefix: 'CC_A', type: 'credit', creditUsd: 5 });
    await db.voucherRedeemCas('v', 'oak_1', { totalCostLimitUsd: 5 }, 1000);
    expect((await db.voucherList())[0].grantApplied).toBe(false);
    expect(await db.voucherMarkGrantApplied('v')).toBe(true);
    expect((await new JsonVoucherDb(vouchersPath).voucherList())[0].grantApplied).toBe(true);
    // Idempotent: a second mark is a no-op success.
    expect(await db.voucherMarkGrantApplied('v')).toBe(true);
  });

  it('revertRedeem: unapplied flip → back to unredeemed; applied flip → refused', async () => {
    const db = new JsonVoucherDb(vouchersPath);
    await db.voucherCreate({ id: 'a', codeHash: 'ha', codePrefix: 'CC_A', type: 'credit', creditUsd: 5 });
    await db.voucherCreate({ id: 'b', codeHash: 'hb', codePrefix: 'CC_B', type: 'credit', creditUsd: 5 });

    // Unapplied flip by oak_1 → revert succeeds, card returns to unredeemed.
    await db.voucherRedeemCas('a', 'oak_1', { totalCostLimitUsd: 5 }, 1000);
    expect(await db.voucherRevertRedeem('a', 'oak_1')).toBe(true);
    const a = (await new JsonVoucherDb(vouchersPath).voucherList()).find((r) => r.id === 'a');
    expect(a?.status).toBe('unredeemed');
    expect(a?.redeemedByKeyId).toBeUndefined();
    expect(a?.grantApplied).toBeUndefined();

    // A DIFFERENT key cannot revert; an APPLIED grant cannot be reverted.
    await db.voucherRedeemCas('b', 'oak_1', { totalCostLimitUsd: 5 }, 1000);
    expect(await db.voucherRevertRedeem('b', 'oak_OTHER')).toBe(false);
    await db.voucherMarkGrantApplied('b');
    expect(await db.voucherRevertRedeem('b', 'oak_1')).toBe(false);
    expect((await new JsonVoucherDb(vouchersPath).voucherList()).find((r) => r.id === 'b')?.status).toBe(
      'redeemed',
    );
  });
});

// ── Admin surface ─────────────────────────────────────────────────────────────

function makeReq(body: unknown): http.IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const r = Readable.from([Buffer.from(raw, 'utf8')]) as unknown as http.IncomingMessage;
  r.method = 'POST';
  r.headers = {};
  return r;
}

class MockRes {
  statusCode = 0;
  body = '';
  writeHead(status: number): this {
    this.statusCode = status;
    return this;
  }
  end(chunk?: string): this {
    if (chunk) this.body += chunk;
    return this;
  }
  json(): Record<string, unknown> {
    return this.body ? (JSON.parse(this.body) as Record<string, unknown>) : {};
  }
}

/** A settings store whose config carries the given voucher.enabled flag. */
function mkSettingsStore(enabled: boolean): ApiServerSettingsStore {
  return {
    get: async () => ({ voucher: { enabled } }) as never,
    set: async () => {},
  };
}

describe('handleVoucher (admin)', () => {
  it('generate is gated: disabled → 403, no card created', async () => {
    const voucherDb = new JsonVoucherDb(vouchersPath);
    const res = new MockRes();
    await handleVoucher(
      makeReq({ type: 'credit', creditUsd: 20 }),
      res as unknown as http.ServerResponse,
      'POST',
      [],
      { voucherDb, settingsStore: mkSettingsStore(false) },
    );
    expect(res.statusCode).toBe(403);
    expect(await voucherDb.voucherList()).toHaveLength(0);
  });

  it('generate returns the plaintext ONCE and stores only the hash', async () => {
    const voucherDb = new JsonVoucherDb(vouchersPath);
    const res = new MockRes();
    await handleVoucher(
      makeReq({ type: 'credit', creditUsd: 20, maxTotalCostLimitUsd: 100 }),
      res as unknown as http.ServerResponse,
      'POST',
      [],
      { voucherDb, settingsStore: mkSettingsStore(true) },
    );
    expect(res.statusCode).toBe(201);
    const created = res.json();
    const plaintext = created['plaintextOnce'] as string;
    expect(plaintext.startsWith('CC_')).toBe(true);

    // Stored row carries the HASH of the returned plaintext, not the plaintext.
    const fileText = readFileSync(vouchersPath, 'utf8');
    expect(fileText).not.toContain(plaintext);
    expect(fileText).toContain(hashVoucherCode(plaintext));
  });

  it('rejects a malformed create body (400)', async () => {
    const voucherDb = new JsonVoucherDb(vouchersPath);
    const res = new MockRes();
    await handleVoucher(
      makeReq({ type: 'credit' }), // missing creditUsd
      res as unknown as http.ServerResponse,
      'POST',
      [],
      { voucherDb, settingsStore: mkSettingsStore(true) },
    );
    expect(res.statusCode).toBe(400);
    expect(await voucherDb.voucherList()).toHaveLength(0);
  });

  it('list projects safe DTOs (never the code hash)', async () => {
    const voucherDb = new JsonVoucherDb(vouchersPath);
    await voucherDb.voucherCreate({
      id: 'vch_1',
      codeHash: 'SECRETHASHVALUE',
      codePrefix: 'CC_ABCD',
      type: 'credit',
      creditUsd: 20,
    });
    const res = new MockRes();
    await handleVoucher(
      makeReq(undefined),
      res as unknown as http.ServerResponse,
      'GET',
      [],
      { voucherDb, settingsStore: mkSettingsStore(true) },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('SECRETHASHVALUE');
    expect(res.body).not.toContain('codeHash');
    const vouchers = res.json()['vouchers'] as Array<Record<string, unknown>>;
    expect(vouchers[0]['codePrefix']).toBe('CC_ABCD');
  });

  it('revoke: unredeemed → 200, redeemed → 409', async () => {
    const voucherDb = new JsonVoucherDb(vouchersPath);
    await voucherDb.voucherCreate({ id: 'a', codeHash: 'ha', codePrefix: 'CC_A', type: 'credit', creditUsd: 5 });
    await voucherDb.voucherCreate({ id: 'b', codeHash: 'hb', codePrefix: 'CC_B', type: 'credit', creditUsd: 5 });
    await voucherDb.voucherRedeemCas('b', 'oak_1', { totalCostLimitUsd: 5 }, 1000);

    const resA = new MockRes();
    await handleVoucher(makeReq(undefined), resA as unknown as http.ServerResponse, 'POST', ['a', 'revoke'], {
      voucherDb,
      settingsStore: mkSettingsStore(true),
    });
    expect(resA.statusCode).toBe(200);
    expect(resA.json()['ok']).toBe(true);

    const resB = new MockRes();
    await handleVoucher(makeReq(undefined), resB as unknown as http.ServerResponse, 'POST', ['b', 'revoke'], {
      voucherDb,
      settingsStore: mkSettingsStore(true),
    });
    expect(resB.statusCode).toBe(409);
    expect(resB.json()['ok']).toBe(false);
  });
});

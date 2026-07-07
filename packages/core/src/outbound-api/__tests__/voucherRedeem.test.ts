/**
 * Tests for the key-authenticated redeem handler (voucher-redemption #9, design
 * D4/D5/D6). Covers: credit raises the limit (capped); renewal extends expiry
 * (capped); invalid/redeemed/revoked codes rejected without leaking; the CAS
 * single-use guarantee (a second/concurrent redeem never double-applies);
 * crash-safe idempotent re-apply of the recorded absolute target; the
 * redeem-attempt rate limit; disabled = inert; the response reveals only THIS
 * key's balance; and (through the full router) redeem requires a valid key.
 */
import type http from 'node:http';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { VoucherGrant, VoucherRecord } from '@omnicross/contracts/voucher-types';

import { KeyedMutex } from '../keyedMutex';
import { ProviderProxyRouteMap } from '../../provider-proxy/providerProxyRouteMap';
import { handleOutboundRequest, type OutboundRequestConfig } from '../outboundApiRouter';
import { OutboundConcurrencyGate } from '../outboundConcurrencyGate';
import { OutboundRateLimiter } from '../outboundRateLimiter';
import type { OutboundApiDeps, OutboundKeyDb, OutboundKeyDbRow, OutboundKeyPolicy } from '../types';
import { UserMessageSerialQueue } from '../userMessageSerialQueue';
import { hashVoucherCode } from '../voucher';
import { handleVoucherRedeem } from '../voucherRedeem';

const DAY = 86_400_000;

// --- fakes ------------------------------------------------------------------

function makeReq(body: string, url = '/redeem'): http.IncomingMessage {
  const r = Readable.from([Buffer.from(body, 'utf8')]) as unknown as http.IncomingMessage;
  r.method = 'POST';
  r.url = url;
  r.headers = { authorization: 'Bearer the-key' };
  (r as unknown as { socket: unknown }).socket = { remoteAddress: '127.0.0.1', destroy: () => {} };
  return r;
}

class MockRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }
  end(chunk?: string): this {
    if (chunk) this.body += chunk;
    return this;
  }
  once(): this {
    return this;
  }
  removeListener(): this {
    return this;
  }
  json(): Record<string, unknown> {
    return this.body ? (JSON.parse(this.body) as Record<string, unknown>) : {};
  }
}

/** An in-memory VoucherDb with the REAL synchronous CAS semantics. */
function mkVoucherDb(initial: VoucherRecord[] = []): {
  db: NonNullable<OutboundApiDeps['voucherDb']>;
  rows: VoucherRecord[];
} {
  const rows = [...initial];
  const db: NonNullable<OutboundApiDeps['voucherDb']> = {
    voucherCreate: async (input) => {
      const r: VoucherRecord = {
        id: input.id,
        codeHash: input.codeHash,
        codePrefix: input.codePrefix,
        type: input.type,
        status: 'unredeemed',
        createdAt: input.createdAt ?? 0,
      };
      rows.push(r);
      return r;
    },
    voucherGetByHash: async (h) => rows.find((r) => r.codeHash === h) ?? null,
    voucherRedeemCas: async (id, keyId, granted: VoucherGrant, now) => {
      const r = rows.find((x) => x.id === id);
      if (!r || r.status !== 'unredeemed') return false;
      r.status = 'redeemed';
      r.redeemedAt = now;
      r.redeemedByKeyId = keyId;
      r.grantApplied = false;
      if (granted.totalCostLimitUsd != null) r.grantedTotalCostLimitUsd = granted.totalCostLimitUsd;
      if (granted.expiresAt != null) r.grantedExpiresAt = granted.expiresAt;
      return true;
    },
    voucherMarkGrantApplied: async (id) => {
      const r = rows.find((x) => x.id === id);
      if (!r || r.status !== 'redeemed') return false;
      r.grantApplied = true;
      return true;
    },
    voucherRevertRedeem: async (id, keyId) => {
      const r = rows.find((x) => x.id === id);
      if (!r || r.status !== 'redeemed' || r.grantApplied === true) return false;
      if (r.redeemedByKeyId !== keyId) return false;
      r.status = 'unredeemed';
      delete r.redeemedAt;
      delete r.redeemedByKeyId;
      delete r.grantApplied;
      delete r.grantedTotalCostLimitUsd;
      delete r.grantedExpiresAt;
      return true;
    },
    voucherRevokeCas: async (id, now) => {
      const r = rows.find((x) => x.id === id);
      if (!r || r.status !== 'unredeemed') return false;
      r.status = 'revoked';
      r.revokedAt = now;
      return true;
    },
    voucherList: async () => rows,
  };
  return { db, rows };
}

/** A key DB whose `getByHash` returns one mutable row; records `setPolicy`. */
function mkKeyDb(
  rowOverrides: Partial<OutboundKeyDbRow> = {},
  opts: { setPolicyFails?: boolean } = {},
): {
  db: OutboundKeyDb;
  state: OutboundKeyDbRow;
  setPolicyCalls: OutboundKeyPolicy[];
} {
  const state: OutboundKeyDbRow = {
    id: 'oak_1',
    name: 'k',
    keyHash: '',
    keyPrefix: 'sk-omnicross-',
    enabled: true,
    createdAt: 0,
    lastUsedAt: null,
    revokedAt: null,
    ...rowOverrides,
  };
  const setPolicyCalls: OutboundKeyPolicy[] = [];
  const db: OutboundKeyDb = {
    outboundApiKeysList: async () => [state],
    outboundApiKeysGetByHash: async () => state,
    outboundApiKeysCreate: async () => state,
    outboundApiKeysRevoke: async () => true,
    outboundApiKeysTouchLastUsed: async () => true,
    outboundApiKeysSetEnabled: async () => true,
    outboundApiKeysSetMaxConcurrency: async () => true,
    outboundApiKeysSetPolicy: async (_id, policy) => {
      // M3: a revoked/missing key returns false — the grant apply fails.
      if (opts.setPolicyFails) return false;
      setPolicyCalls.push(policy);
      Object.assign(state, policy);
      return true;
    },
    outboundApiKeysMarkActivated: async () => true,
  };
  return { db, state, setPolicyCalls };
}

function mkDeps(
  voucherDb: OutboundApiDeps['voucherDb'],
  keyDb: OutboundKeyDb,
): OutboundApiDeps {
  return {
    db: keyDb,
    voucherDb,
    llmConfig: {} as OutboundApiDeps['llmConfig'],
    providerProxy: {} as OutboundApiDeps['providerProxy'],
    proxyDeps: {} as OutboundApiDeps['proxyDeps'],
  };
}

function creditCard(code: string, overrides: Partial<VoucherRecord> = {}): VoucherRecord {
  return {
    id: 'vch_credit',
    codeHash: hashVoucherCode(code),
    codePrefix: code.slice(0, 8),
    type: 'credit',
    creditUsd: 20,
    status: 'unredeemed',
    createdAt: 0,
    ...overrides,
  };
}

// --- tests ------------------------------------------------------------------

describe('handleVoucherRedeem — credit', () => {
  it('raises the key total cost limit and returns only this key balance', async () => {
    const code = 'CC_credit0001';
    const { db: vdb } = mkVoucherDb([creditCard(code)]);
    const { db: kdb, setPolicyCalls } = mkKeyDb({ totalCostLimitUsd: 5 });
    const res = new MockRes();
    const limiter = new OutboundRateLimiter();

    await handleVoucherRedeem(
      makeReq(JSON.stringify({ code })),
      res as unknown as http.ServerResponse,
      mkDeps(vdb, kdb),
      true,
      limiter,
      'oak_1',
      'the-key',
      1000,
    );

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ ok: true, type: 'credit', totalCostLimitUsd: 25 });
    expect(setPolicyCalls).toEqual([{ totalCostLimitUsd: 25 }]);
    // Leak-safe: the response mentions no other card/key data.
    expect(res.body).not.toContain('vch_');
    expect(res.body).not.toContain('codeHash');
  });

  it('clamps the granted limit to the per-card cap', async () => {
    const code = 'CC_creditcap01';
    const { db: vdb } = mkVoucherDb([creditCard(code, { creditUsd: 100, maxTotalCostLimitUsd: 30 })]);
    const { db: kdb } = mkKeyDb({ totalCostLimitUsd: 10 });
    const res = new MockRes();
    await handleVoucherRedeem(
      makeReq(JSON.stringify({ code })),
      res as unknown as http.ServerResponse,
      mkDeps(vdb, kdb),
      true,
      new OutboundRateLimiter(),
      'oak_1',
      'the-key',
      1000,
    );
    expect(res.json()['totalCostLimitUsd']).toBe(30);
  });
});

describe('handleVoucherRedeem — renewal', () => {
  it('extends the key expiry, capped at now + maxExpiryDays', async () => {
    const code = 'CC_renew00001';
    const now = 1_000_000;
    const { db: vdb } = mkVoucherDb([
      {
        id: 'vch_renew',
        codeHash: hashVoucherCode(code),
        codePrefix: code.slice(0, 8),
        type: 'renewal',
        renewalDays: 365,
        maxExpiryDays: 30,
        status: 'unredeemed',
        createdAt: 0,
      },
    ]);
    const { db: kdb, setPolicyCalls } = mkKeyDb({ expiresAt: now });
    const res = new MockRes();
    await handleVoucherRedeem(
      makeReq(JSON.stringify({ code })),
      res as unknown as http.ServerResponse,
      mkDeps(vdb, kdb),
      true,
      new OutboundRateLimiter(),
      'oak_1',
      'the-key',
      now,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()['expiresAt']).toBe(now + 30 * DAY);
    expect(setPolicyCalls).toEqual([{ expiresAt: now + 30 * DAY }]);
  });
});

describe('handleVoucherRedeem — rejection & leak-safety', () => {
  it('rejects an unknown code without revealing anything', async () => {
    const { db: vdb } = mkVoucherDb([creditCard('CC_realcode001')]);
    const { db: kdb, setPolicyCalls } = mkKeyDb({ totalCostLimitUsd: 5 });
    const res = new MockRes();
    await handleVoucherRedeem(
      makeReq(JSON.stringify({ code: 'CC_wrongguess' })),
      res as unknown as http.ServerResponse,
      mkDeps(vdb, kdb),
      true,
      new OutboundRateLimiter(),
      'oak_1',
      'the-key',
      1000,
    );
    expect(res.statusCode).toBe(400);
    expect(setPolicyCalls).toHaveLength(0);
    expect(res.body).not.toContain('vch_');
  });

  it('rejects a revoked card', async () => {
    const code = 'CC_revoked0001';
    const { db: vdb } = mkVoucherDb([creditCard(code, { status: 'revoked', revokedAt: 1 })]);
    const { db: kdb, setPolicyCalls } = mkKeyDb();
    const res = new MockRes();
    await handleVoucherRedeem(
      makeReq(JSON.stringify({ code })),
      res as unknown as http.ServerResponse,
      mkDeps(vdb, kdb),
      true,
      new OutboundRateLimiter(),
      'oak_1',
      'the-key',
      1000,
    );
    expect(res.statusCode).toBe(400);
    expect(setPolicyCalls).toHaveLength(0);
  });

  it('rejects a card redeemed by a DIFFERENT key (no leak)', async () => {
    const code = 'CC_otherkey001';
    const { db: vdb } = mkVoucherDb([
      creditCard(code, { status: 'redeemed', redeemedByKeyId: 'oak_OTHER', grantedTotalCostLimitUsd: 99 }),
    ]);
    const { db: kdb, setPolicyCalls } = mkKeyDb();
    const res = new MockRes();
    await handleVoucherRedeem(
      makeReq(JSON.stringify({ code })),
      res as unknown as http.ServerResponse,
      mkDeps(vdb, kdb),
      true,
      new OutboundRateLimiter(),
      'oak_1',
      'the-key',
      1000,
    );
    expect(res.statusCode).toBe(400);
    expect(setPolicyCalls).toHaveLength(0);
    expect(res.body).not.toContain('99');
    expect(res.body).not.toContain('oak_OTHER');
  });

  it('rejects a missing code with 400', async () => {
    const { db: vdb } = mkVoucherDb();
    const { db: kdb } = mkKeyDb();
    const res = new MockRes();
    await handleVoucherRedeem(
      makeReq(JSON.stringify({})),
      res as unknown as http.ServerResponse,
      mkDeps(vdb, kdb),
      true,
      new OutboundRateLimiter(),
      'oak_1',
      'the-key',
      1000,
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('handleVoucherRedeem — single-use, replay guard & crash-safety', () => {
  it('a replay of the SAME redeemed card does NOT change the limit (grantApplied guard)', async () => {
    const code = 'CC_single00001';
    const { db: vdb, rows } = mkVoucherDb([creditCard(code)]);
    const { db: kdb, setPolicyCalls, state } = mkKeyDb({ totalCostLimitUsd: 5 });
    const mutex = new KeyedMutex();

    const run = async (): Promise<MockRes> => {
      const res = new MockRes();
      await handleVoucherRedeem(
        makeReq(JSON.stringify({ code })),
        res as unknown as http.ServerResponse,
        mkDeps(vdb, kdb),
        true,
        new OutboundRateLimiter(),
        'oak_1',
        'the-key',
        1000,
        mutex,
      );
      return res;
    };

    const first = await run();
    expect(first.statusCode).toBe(200);
    expect(first.json()['totalCostLimitUsd']).toBe(25);
    expect(rows[0].grantApplied).toBe(true);

    // Replay of the same code: grantApplied guard ⇒ idempotent no-op, NO re-add.
    const second = await run();
    expect(second.statusCode).toBe(200);
    expect(second.json()['totalCostLimitUsd']).toBe(25); // unchanged
    expect(state.totalCostLimitUsd).toBe(25); // never 45
    // The apply ran exactly ONCE (the replay did not call setPolicy again).
    expect(setPolicyCalls).toHaveLength(1);
    expect(rows[0].status).toBe('redeemed');
  });

  it('crash-safety (apply never ran): reconcile applies the recorded absolute once', async () => {
    const code = 'CC_crash00001';
    // Flipped, recorded absolute = 25, but the key limit is still 5 (setPolicy
    // never ran before the crash). grantApplied=false.
    const { db: vdb, rows } = mkVoucherDb([
      creditCard(code, {
        status: 'redeemed',
        redeemedByKeyId: 'oak_1',
        grantApplied: false,
        grantedTotalCostLimitUsd: 25,
      }),
    ]);
    const { db: kdb, setPolicyCalls, state } = mkKeyDb({ totalCostLimitUsd: 5 });
    const res = new MockRes();
    await handleVoucherRedeem(
      makeReq(JSON.stringify({ code })),
      res as unknown as http.ServerResponse,
      mkDeps(vdb, kdb),
      true,
      new OutboundRateLimiter(),
      'oak_1',
      'the-key',
      1000,
    );
    // Reconciled: the recorded ABSOLUTE (25) applied once, flag set.
    expect(res.statusCode).toBe(200);
    expect(state.totalCostLimitUsd).toBe(25);
    expect(setPolicyCalls).toHaveLength(1);
    expect(rows[0].grantApplied).toBe(true);
  });

  it('MJ2 crash window (apply ran, mark did not): reconcile does NOT double-credit', async () => {
    const code = 'CC_crash00002';
    // The crash window :395 missed — setPolicy ALREADY applied (limit is at the
    // recorded absolute 25) but grantApplied is still false.
    const { db: vdb, rows } = mkVoucherDb([
      creditCard(code, {
        status: 'redeemed',
        redeemedByKeyId: 'oak_1',
        grantApplied: false,
        grantedTotalCostLimitUsd: 25,
      }),
    ]);
    const { db: kdb, state } = mkKeyDb({ totalCostLimitUsd: 25 });
    const res = new MockRes();
    await handleVoucherRedeem(
      makeReq(JSON.stringify({ code })),
      res as unknown as http.ServerResponse,
      mkDeps(vdb, kdb),
      true,
      new OutboundRateLimiter(),
      'oak_1',
      'the-key',
      1000,
    );
    // Re-applying the same ABSOLUTE (25) is a no-op — the limit is UNCHANGED (never
    // 25+25=50), and the mark is set. No second credit.
    expect(res.statusCode).toBe(200);
    expect(state.totalCostLimitUsd).toBe(25);
    expect(rows[0].grantApplied).toBe(true);
  });

  it('two concurrent redeems of TWO DIFFERENT cards by the SAME key → BOTH values land (accumulate)', async () => {
    const codeA = 'CC_accum00001';
    const codeB = 'CC_accum00002';
    const { db: vdb, rows } = mkVoucherDb([
      creditCard(codeA, { id: 'vch_a', creditUsd: 10 }),
      creditCard(codeB, { id: 'vch_b', creditUsd: 10 }),
    ]);
    // ONE key, ONE shared key DB + ONE shared mutex → the two redeems serialize.
    const { db: kdb, state } = mkKeyDb({ totalCostLimitUsd: 0 });
    const mutex = new KeyedMutex();
    const resA = new MockRes();
    const resB = new MockRes();

    await Promise.all([
      handleVoucherRedeem(
        makeReq(JSON.stringify({ code: codeA })),
        resA as unknown as http.ServerResponse,
        mkDeps(vdb, kdb),
        true,
        new OutboundRateLimiter(),
        'oak_1',
        'the-key',
        1000,
        mutex,
      ),
      handleVoucherRedeem(
        makeReq(JSON.stringify({ code: codeB })),
        resB as unknown as http.ServerResponse,
        mkDeps(vdb, kdb),
        true,
        new OutboundRateLimiter(),
        'oak_1',
        'the-key',
        1000,
        mutex,
      ),
    ]);

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
    // BOTH $10 cards landed (relative increment under the per-key mutex): 0+10+10.
    expect(state.totalCostLimitUsd).toBe(20);
    expect(rows.every((r) => r.status === 'redeemed' && r.grantApplied === true)).toBe(true);
  });

  it('accumulated value respects the per-card cap', async () => {
    const codeA = 'CC_cap000001';
    const codeB = 'CC_cap000002';
    const { db: vdb } = mkVoucherDb([
      creditCard(codeA, { id: 'vch_a', creditUsd: 10, maxTotalCostLimitUsd: 15 }),
      creditCard(codeB, { id: 'vch_b', creditUsd: 10, maxTotalCostLimitUsd: 15 }),
    ]);
    const { db: kdb, state } = mkKeyDb({ totalCostLimitUsd: 0 });
    const mutex = new KeyedMutex();
    for (const code of [codeA, codeB]) {
      const res = new MockRes();
      await handleVoucherRedeem(
        makeReq(JSON.stringify({ code })),
        res as unknown as http.ServerResponse,
        mkDeps(vdb, kdb),
        true,
        new OutboundRateLimiter(),
        'oak_1',
        'the-key',
        1000,
        mutex,
      );
    }
    // 0+10=10, then min(10+10,15)=15 — the cap clamps the accumulation.
    expect(state.totalCostLimitUsd).toBe(15);
  });

  it('two concurrent redeems of ONE card by DIFFERENT keys → exactly one grant', async () => {
    const code = 'CC_concurrent1';
    const { db: vdb, rows } = mkVoucherDb([creditCard(code)]);
    const a = mkKeyDb({ id: 'oak_A', totalCostLimitUsd: 0 });
    const b = mkKeyDb({ id: 'oak_B', totalCostLimitUsd: 0 });
    const resA = new MockRes();
    const resB = new MockRes();

    await Promise.all([
      handleVoucherRedeem(
        makeReq(JSON.stringify({ code })),
        resA as unknown as http.ServerResponse,
        mkDeps(vdb, a.db),
        true,
        new OutboundRateLimiter(),
        'oak_A',
        'key-a',
        1000,
      ),
      handleVoucherRedeem(
        makeReq(JSON.stringify({ code })),
        resB as unknown as http.ServerResponse,
        mkDeps(vdb, b.db),
        true,
        new OutboundRateLimiter(),
        'oak_B',
        'key-b',
        1000,
      ),
    ]);

    const statuses = [resA.statusCode, resB.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const grantedKeys = [a.setPolicyCalls.length, b.setPolicyCalls.length];
    expect(grantedKeys.filter((n) => n > 0)).toHaveLength(1);
    expect(rows[0].status).toBe('redeemed');
  });

  it('reverts the flip and errors when setPolicy fails (key revoked mid-redeem, M3)', async () => {
    const code = 'CC_setfail0001';
    const { db: vdb, rows } = mkVoucherDb([creditCard(code)]);
    const { db: kdb, setPolicyCalls } = mkKeyDb({ totalCostLimitUsd: 5 }, { setPolicyFails: true });
    const res = new MockRes();
    await handleVoucherRedeem(
      makeReq(JSON.stringify({ code })),
      res as unknown as http.ServerResponse,
      mkDeps(vdb, kdb),
      true,
      new OutboundRateLimiter(),
      'oak_1',
      'the-key',
      1000,
    );
    // Error to the holder; the card is REVERTED to unredeemed (not lost).
    expect(res.statusCode).toBe(409);
    expect(setPolicyCalls).toHaveLength(0);
    expect(rows[0].status).toBe('unredeemed');
    expect(rows[0].grantApplied).toBeUndefined();
  });
});

describe('handleVoucherRedeem — rate limit & disabled', () => {
  it('throttles excessive redeem attempts (429) — brute-force guard', async () => {
    const { db: vdb } = mkVoucherDb([creditCard('CC_realonly0001')]);
    const { db: kdb } = mkKeyDb();
    const limiter = new OutboundRateLimiter({ maxRequests: 3, windowMs: 60_000 });
    const codes = ['CC_g1', 'CC_g2', 'CC_g3', 'CC_g4'];
    const statuses: number[] = [];
    for (const code of codes) {
      const res = new MockRes();
      await handleVoucherRedeem(
        makeReq(JSON.stringify({ code })),
        res as unknown as http.ServerResponse,
        mkDeps(vdb, kdb),
        true,
        limiter,
        'oak_1',
        'the-key',
        1000,
      );
      statuses.push(res.statusCode);
    }
    // First three attempts run (all bad codes → 400), the 4th is throttled → 429.
    expect(statuses).toEqual([400, 400, 400, 429]);
  });

  it('is inert when the feature is disabled (403, no key mutation)', async () => {
    const code = 'CC_disabled001';
    const { db: vdb } = mkVoucherDb([creditCard(code)]);
    const { db: kdb, setPolicyCalls } = mkKeyDb({ totalCostLimitUsd: 5 });
    const res = new MockRes();
    await handleVoucherRedeem(
      makeReq(JSON.stringify({ code })),
      res as unknown as http.ServerResponse,
      mkDeps(vdb, kdb),
      false, // disabled
      new OutboundRateLimiter(),
      'oak_1',
      'the-key',
      1000,
    );
    expect(res.statusCode).toBe(403);
    expect(setPolicyCalls).toHaveLength(0);
  });
});

describe('redeem through the full router — auth required', () => {
  it('rejects an invalid key with 401 before touching the voucher store', async () => {
    // getByHash → null ⇒ verifyKey invalid ⇒ 401.
    const { db: vdb, rows } = mkVoucherDb([creditCard('CC_authcode001')]);
    const keyDb: OutboundKeyDb = {
      outboundApiKeysList: async () => [],
      outboundApiKeysGetByHash: async () => null,
      outboundApiKeysCreate: async () => {
        throw new Error('unused');
      },
      outboundApiKeysRevoke: async () => true,
      outboundApiKeysTouchLastUsed: async () => true,
      outboundApiKeysSetEnabled: async () => true,
      outboundApiKeysSetMaxConcurrency: async () => true,
      outboundApiKeysSetPolicy: async () => true,
      outboundApiKeysMarkActivated: async () => true,
    };
    const deps: OutboundApiDeps = {
      db: keyDb,
      voucherDb: vdb,
      llmConfig: {} as OutboundApiDeps['llmConfig'],
      providerProxy: { getRouteMap: () => new ProviderProxyRouteMap() } as unknown as OutboundApiDeps['providerProxy'],
      proxyDeps: {} as OutboundApiDeps['proxyDeps'],
    };
    const config: OutboundRequestConfig = { endpoints: [], voucher: { enabled: true } };
    const res = new MockRes();
    await handleOutboundRequest(
      makeReq(JSON.stringify({ code: 'CC_authcode001' })),
      res as unknown as http.ServerResponse,
      deps,
      config,
      new OutboundRateLimiter(),
      new UserMessageSerialQueue(),
      new OutboundConcurrencyGate(),
      new OutboundRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    );
    expect(res.statusCode).toBe(401);
    // The card was never touched (still unredeemed).
    expect(rows[0].status).toBe('unredeemed');
  });
});

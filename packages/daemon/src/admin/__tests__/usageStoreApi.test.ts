/**
 * usageStoreApi.test.ts — the Settings → Data usage-storage surface.
 *
 * The load-bearing rule is the STRICT save: an illegal `retentionDays` is a 400
 * and nothing is persisted (never a silent clamp) — the value is an
 * irreversible deletion window, not a UI preference.
 */

import type http from 'node:http';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  type UsageStoreAdmin,
  type UsageStoreInfo,
  handleUsageStoreGet,
  handleUsageStorePrune,
  handleUsageStorePut,
} from '../usageStoreApi';

function fakeRes(): {
  res: http.ServerResponse;
  status: () => number;
  json: () => unknown;
} {
  let code = 0;
  let body = '';
  const res = {
    writeHead: (status: number) => {
      code = status;
    },
    end: (value?: string) => {
      body = value ?? '';
    },
  } as unknown as http.ServerResponse;
  return { res, status: () => code, json: () => JSON.parse(body) as unknown };
}

function putRequest(body: unknown): http.IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as {
    method?: string;
    url?: string;
  };
  req.method = 'PUT';
  req.url = '/admin/api/usage-store';
  return req as unknown as http.IncomingMessage;
}

const INFO: UsageStoreInfo = {
  retentionDays: 7,
  stats: {
    totalBytes: 100,
    shardBytes: 10,
    rawBytes: 80,
    rollupBytes: 10,
    days: 1,
    oldestDay: '2026-06-19',
    newestDay: '2026-06-19',
  },
};

function admin(over: Partial<UsageStoreAdmin> = {}): UsageStoreAdmin {
  return {
    getInfo: vi.fn(async () => INFO),
    setRetentionDays: vi.fn(async (days: number) => ({ ...INFO, retentionDays: days })),
    pruneNow: vi.fn(async () => ({ removedDays: 2, freedBytes: 4096 })),
    ...over,
  };
}

describe('usageStoreApi', () => {
  it('GET returns the live window + footprint verbatim', async () => {
    const { res, status, json } = fakeRes();
    await handleUsageStoreGet(res, admin());
    expect(status()).toBe(200);
    expect(json()).toEqual(INFO);
  });

  it('PUT persists a valid window and echoes the refreshed info', async () => {
    const port = admin();
    const { res, status, json } = fakeRes();
    await handleUsageStorePut(putRequest({ retentionDays: 30 }), res, port);
    expect(status()).toBe(200);
    expect(port.setRetentionDays).toHaveBeenCalledWith(30);
    expect((json() as UsageStoreInfo).retentionDays).toBe(30);
  });

  it('PUT accepts 0 (keep everything) unchanged', async () => {
    const port = admin();
    const { res, status } = fakeRes();
    await handleUsageStorePut(putRequest({ retentionDays: 0 }), res, port);
    expect(status()).toBe(200);
    expect(port.setRetentionDays).toHaveBeenCalledWith(0);
  });

  it.each([
    ['a string', { retentionDays: '7' }],
    ['NaN', { retentionDays: Number.NaN }],
    ['missing', {}],
    ['negative', { retentionDays: -1 }],
    ['out of range', { retentionDays: 3651 }],
  ])('PUT rejects %s with 400 and persists nothing', async (_label, body) => {
    const port = admin();
    const { res, status } = fakeRes();
    await handleUsageStorePut(putRequest(body), res, port);
    expect(status()).toBe(400);
    expect(port.setRetentionDays).not.toHaveBeenCalled();
  });

  it('POST prune reports days retired + bytes freed', async () => {
    const { res, status, json } = fakeRes();
    await handleUsageStorePrune(res, admin());
    expect(status()).toBe(200);
    expect(json()).toEqual({ removedDays: 2, freedBytes: 4096 });
  });

  it('501s every route when the admin port is unwired', async () => {
    const get = fakeRes();
    await handleUsageStoreGet(get.res, undefined);
    expect(get.status()).toBe(501);

    const put = fakeRes();
    await handleUsageStorePut(putRequest({ retentionDays: 7 }), put.res, undefined);
    expect(put.status()).toBe(501);

    const prune = fakeRes();
    await handleUsageStorePrune(prune.res, undefined);
    expect(prune.status()).toBe(501);
  });
});

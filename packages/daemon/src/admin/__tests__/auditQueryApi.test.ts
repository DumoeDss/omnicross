import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuditRecord } from '@omnicross/contracts/audit-types';
import { describe, expect, it, vi } from 'vitest';

import type { AuditQuery } from '../../audit/auditReader';
import type { AuditStatsQuery } from '../../audit/auditStats';
import type { AuditBodyQuery } from '../../audit/auditBodyReader';
import { handleAuditBodyQuery, handleAuditQuery, handleAuditStatsQuery } from '../auditQueryApi';

function fakeReq(url: string): IncomingMessage {
  return { url, method: 'GET' } as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; body: () => unknown; status: () => number } {
  let status = 0;
  let payload = '';
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (data?: string) => {
      payload = data ?? '';
    },
  } as unknown as ServerResponse;
  return { res, body: () => JSON.parse(payload), status: () => status };
}

const rec = (id: string): AuditRecord => ({
  id,
  ts: 1,
  method: 'POST',
  path: '/v1/messages',
  status: 200,
  latencyMs: 1,
});

describe('handleAuditQuery', () => {
  it('parses keyId/from/to/limit into the reader query', () => {
    const seen: AuditQuery[] = [];
    const reader = vi.fn((q: AuditQuery) => {
      seen.push(q);
      return [rec('a')];
    });
    const { res, body, status } = fakeRes();
    handleAuditQuery(fakeReq('/admin/api/audit?keyId=k1&from=100&to=200&limit=5'), res, reader);
    expect(status()).toBe(200);
    expect(seen[0]).toEqual({ keyId: 'k1', from: 100, to: 200, limit: 5 });
    expect((body() as { records: AuditRecord[] }).records).toHaveLength(1);
  });

  it('omits absent params from the query', () => {
    const seen: AuditQuery[] = [];
    const reader = (q: AuditQuery): AuditRecord[] => {
      seen.push(q);
      return [];
    };
    const { res } = fakeRes();
    handleAuditQuery(fakeReq('/admin/api/audit'), res, reader);
    expect(seen[0]).toEqual({});
  });

  it('returns an empty list when the reader is unwired (audit never enabled)', () => {
    const { res, body } = fakeRes();
    handleAuditQuery(fakeReq('/admin/api/audit'), res, undefined);
    expect((body() as { records: AuditRecord[] }).records).toEqual([]);
  });
});

describe('handleAuditStatsQuery', () => {
  it('parses the time window and returns metadata-only counts', async () => {
    const seen: AuditStatsQuery[] = [];
    const { res, body, status } = fakeRes();
    await handleAuditStatsQuery(
      fakeReq('/admin/api/audit/stats?from=100&to=200&limit=5'),
      res,
      async (query) => {
        seen.push(query);
        return { requestCount: 10, errorCount: 2, complete: true };
      },
    );
    expect(status()).toBe(200);
    expect(seen).toEqual([{ from: 100, to: 200 }]);
    expect(body()).toEqual({ requestCount: 10, errorCount: 2, complete: true });
  });
});

describe('handleAuditBodyQuery', () => {
  const url = (qs: string): string => `/admin/api/audit/body?${qs}`;

  it('parses id/session/ts into the reader query and returns the bodies', () => {
    const seen: AuditBodyQuery[] = [];
    const reader = vi.fn((q: AuditBodyQuery) => {
      seen.push(q);
      return { requestBody: 'REQ', responseBody: 'RES' };
    });
    const { res, body, status } = fakeRes();
    handleAuditBodyQuery(fakeReq(url('id=r1&session=abcdef12&ts=1700')), res, reader);
    expect(status()).toBe(200);
    expect(body()).toEqual({ requestBody: 'REQ', responseBody: 'RES' });
    expect(seen[0]).toEqual({ id: 'r1', sessionKey: 'abcdef12', ts: 1700 });
  });

  it('omits ts when it is absent or unparseable', () => {
    const seen: AuditBodyQuery[] = [];
    const reader = vi.fn((q: AuditBodyQuery) => {
      seen.push(q);
      return {};
    });
    const { res } = fakeRes();
    handleAuditBodyQuery(fakeReq(url('id=r1&session=abcdef12&ts=nope')), res, reader);
    expect(seen[0]).toEqual({ id: 'r1', sessionKey: 'abcdef12' });
  });

  it('rejects a request missing id or session without calling the reader', () => {
    const reader = vi.fn(() => ({}));
    const a = fakeRes();
    handleAuditBodyQuery(fakeReq(url('session=abcdef12')), a.res, reader);
    expect(a.status()).toBe(400);
    const b = fakeRes();
    handleAuditBodyQuery(fakeReq(url('id=r1')), b.res, reader);
    expect(b.status()).toBe(400);
    expect(reader).not.toHaveBeenCalled();
  });

  it('returns an empty object when audit was never enabled (no reader wired)', () => {
    const { res, body, status } = fakeRes();
    handleAuditBodyQuery(fakeReq(url('id=r1&session=abcdef12')), res, undefined);
    expect(status()).toBe(200);
    expect(body()).toEqual({});
  });
});

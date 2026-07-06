import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuditRecord } from '@omnicross/contracts/audit-types';
import { describe, expect, it, vi } from 'vitest';

import type { AuditQuery } from '../../audit/auditReader';
import { handleAuditQuery } from '../auditQueryApi';

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

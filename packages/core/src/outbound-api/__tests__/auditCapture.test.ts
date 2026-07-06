import type http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import type { AuditConfig, AuditRecord } from '@omnicross/contracts/audit-types';

import {
  __resetAuditSinkForTests,
  setAuditCaptureConfig,
  setAuditSink,
} from '../../pipeline/auditSink';
import { stashAuditUsage } from '../../pipeline/auditUsageStash';
import { beginAuditCapture } from '../auditCapture';

const cfg = (over: Partial<AuditConfig> = {}): AuditConfig => ({
  enabled: true,
  captureBodies: false,
  maxBodyBytes: 8192,
  retentionDays: 7,
  trustForwardedFor: false,
  ...over,
});

/** Minimal `http.IncomingMessage` fake carrying the fields the capture reads. */
function fakeReq(over: {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  remoteAddress?: string;
} = {}): http.IncomingMessage {
  return {
    method: over.method ?? 'POST',
    url: over.url ?? '/v1/messages',
    headers: { 'user-agent': 'curl/8.0', ...(over.headers ?? {}) },
    socket: { remoteAddress: over.remoteAddress ?? '10.0.0.5' },
  } as unknown as http.IncomingMessage;
}

/** Minimal `http.ServerResponse` fake with a close-listener + header store. */
class FakeRes {
  statusCode = 200;
  private headers: Record<string, unknown> = {};
  private closeListeners: Array<() => void> = [];
  write(_chunk?: unknown): boolean {
    return true;
  }
  end(_chunk?: unknown): this {
    return this;
  }
  getHeader(name: string): unknown {
    return this.headers[name.toLowerCase()];
  }
  setHeader(name: string, value: unknown): void {
    this.headers[name.toLowerCase()] = value;
  }
  once(event: string, fn: () => void): this {
    if (event === 'close') this.closeListeners.push(fn);
    return this;
  }
  on(event: string, fn: () => void): this {
    return this.once(event, fn);
  }
  triggerClose(): void {
    for (const l of this.closeListeners) l();
  }
}

function res(): FakeRes {
  return new FakeRes();
}

afterEach(() => __resetAuditSinkForTests());

describe('beginAuditCapture — gating', () => {
  it('returns null (no assembly) when audit is disabled — zero regression', () => {
    // No capture config installed ⇒ disabled.
    const ctx = beginAuditCapture(fakeReq(), res() as unknown as http.ServerResponse, 100);
    expect(ctx).toBeNull();
  });

  it('does not emit any record when disabled even on response close', () => {
    const seen: AuditRecord[] = [];
    setAuditSink((r) => seen.push(r));
    const r = res();
    beginAuditCapture(fakeReq(), r as unknown as http.ServerResponse, 100);
    r.triggerClose();
    expect(seen).toHaveLength(0);
  });
});

describe('beginAuditCapture — metadata capture', () => {
  it('captures metadata (method/path/status/latency/ip/ua/keyId/model/provider) on close', () => {
    setAuditCaptureConfig(cfg());
    const seen: AuditRecord[] = [];
    setAuditSink((rec) => seen.push(rec));
    const r = res();
    const ctx = beginAuditCapture(
      fakeReq({ url: '/v1/messages?key=sk-should-not-be-stored' }),
      r as unknown as http.ServerResponse,
      1000,
    );
    expect(ctx).not.toBeNull();
    ctx!.keyId = 'key_abc';
    ctx!.model = 'claude-sonnet-4-5';
    ctx!.provider = 'claude';
    r.statusCode = 200;
    r.triggerClose();

    expect(seen).toHaveLength(1);
    const rec = seen[0];
    expect(rec.method).toBe('POST');
    // Query string is DROPPED so no secret query param is stored.
    expect(rec.path).toBe('/v1/messages');
    expect(rec.status).toBe(200);
    expect(rec.latencyMs).toBeGreaterThanOrEqual(0);
    expect(rec.ip).toBe('10.0.0.5');
    expect(rec.ua).toBe('curl/8.0');
    expect(rec.keyId).toBe('key_abc');
    expect(rec.model).toBe('claude-sonnet-4-5');
    expect(rec.provider).toBe('claude');
    // No bodies when captureBodies is off.
    expect(rec.requestBody).toBeUndefined();
    expect(rec.responseBody).toBeUndefined();
    // The secret in the query string never made it into the record.
    expect(JSON.stringify(rec)).not.toContain('sk-should-not-be-stored');
  });

  it('never captures request header values (no Authorization / api-key)', () => {
    setAuditCaptureConfig(cfg({ captureBodies: true }));
    const seen: AuditRecord[] = [];
    setAuditSink((rec) => seen.push(rec));
    const r = res();
    beginAuditCapture(
      fakeReq({
        headers: {
          authorization: 'Bearer sk-ant-supersecret-header-token',
          'x-api-key': 'sk-omnicross-header-secret',
          'user-agent': 'agent/1',
        },
      }),
      r as unknown as http.ServerResponse,
      1,
    );
    r.triggerClose();
    const serialized = JSON.stringify(seen[0]);
    expect(serialized).not.toContain('sk-ant-supersecret-header-token');
    expect(serialized).not.toContain('sk-omnicross-header-secret');
  });
});

describe('beginAuditCapture — body capture (opt-in)', () => {
  it('captures + redacts + bounds request and non-stream response bodies', () => {
    setAuditCaptureConfig(cfg({ captureBodies: true }));
    const seen: AuditRecord[] = [];
    setAuditSink((rec) => seen.push(rec));
    const r = res();
    const ctx = beginAuditCapture(fakeReq(), r as unknown as http.ServerResponse, 1);
    ctx!.setRequestBody('{"prompt":"here is my key sk-ant-leak12345 do not log"}');
    // Non-stream response (no event-stream content-type).
    r.setHeader('content-type', 'application/json');
    r.write('{"result":"ok, Bearer leaked-tok-abc123 inside"}');
    r.end();
    r.triggerClose();

    const rec = seen[0];
    expect(rec.requestBody).toBeDefined();
    expect(rec.responseBody).toBeDefined();
    expect(rec.requestBody).not.toContain('sk-ant-leak12345');
    expect(rec.responseBody).not.toContain('leaked-tok-abc123');
  });

  it('truncates a captured body to maxBodyBytes', () => {
    setAuditCaptureConfig(cfg({ captureBodies: true, maxBodyBytes: 10 }));
    const seen: AuditRecord[] = [];
    setAuditSink((rec) => seen.push(rec));
    const r = res();
    const ctx = beginAuditCapture(fakeReq(), r as unknown as http.ServerResponse, 1);
    ctx!.setRequestBody('x'.repeat(500));
    r.triggerClose();
    expect(seen[0].requestBody!.length).toBeLessThanOrEqual(10);
  });

  it('records METADATA ONLY for a streaming response (no unbounded stream body)', () => {
    setAuditCaptureConfig(cfg({ captureBodies: true }));
    const seen: AuditRecord[] = [];
    setAuditSink((rec) => seen.push(rec));
    const r = res();
    const ctx = beginAuditCapture(fakeReq(), r as unknown as http.ServerResponse, 1);
    ctx!.setRequestBody('{"stream":true}');
    r.setHeader('content-type', 'text/event-stream');
    r.write('data: {"delta":"a"}\n\n');
    r.write('data: {"delta":"b"}\n\n');
    r.end();
    r.triggerClose();

    const rec = seen[0];
    // Request body (bounded) is still captured; the STREAM body is not.
    expect(rec.requestBody).toBeDefined();
    expect(rec.responseBody).toBeUndefined();
  });
});

describe('beginAuditCapture — usage correlation', () => {
  it('populates inputTokens/outputTokens/costUsd from the stashed usage result', () => {
    setAuditCaptureConfig(cfg());
    const seen: AuditRecord[] = [];
    setAuditSink((rec) => seen.push(rec));
    const r = res();
    const ctx = beginAuditCapture(fakeReq(), r as unknown as http.ServerResponse, 1);
    ctx!.keyId = 'key_1';
    // The downstream usage tap stashes tokens (sync) + cost (deferred) keyed by res.
    stashAuditUsage(r, { inputTokens: 120, outputTokens: 45, model: 'claude-sonnet-4-5', provider: 'claude' });
    stashAuditUsage(r, { costUsd: 0.0033 });
    r.triggerClose();

    const rec = seen[0];
    expect(rec.inputTokens).toBe(120);
    expect(rec.outputTokens).toBe(45);
    expect(rec.costUsd).toBeCloseTo(0.0033, 6);
  });

  it('falls back to the usage-tap model/provider when the route did not set them', () => {
    setAuditCaptureConfig(cfg());
    const seen: AuditRecord[] = [];
    setAuditSink((rec) => seen.push(rec));
    const r = res();
    beginAuditCapture(fakeReq(), r as unknown as http.ServerResponse, 1);
    stashAuditUsage(r, { model: 'gpt-4o', provider: 'openai', inputTokens: 5, outputTokens: 6 });
    r.triggerClose();
    expect(seen[0].model).toBe('gpt-4o');
    expect(seen[0].provider).toBe('openai');
  });

  it('leaves tokens/cost undefined when no usage was stashed (metadata-only)', () => {
    setAuditCaptureConfig(cfg());
    const seen: AuditRecord[] = [];
    setAuditSink((rec) => seen.push(rec));
    const r = res();
    beginAuditCapture(fakeReq(), r as unknown as http.ServerResponse, 1);
    r.triggerClose();
    expect(seen[0].inputTokens).toBeUndefined();
    expect(seen[0].outputTokens).toBeUndefined();
    expect(seen[0].costUsd).toBeUndefined();
  });
});

describe('beginAuditCapture — client IP (OQ1 anti-spoof)', () => {
  it('uses the socket address by default, IGNORING a spoofed X-Forwarded-For', () => {
    setAuditCaptureConfig(cfg({ trustForwardedFor: false }));
    const seen: AuditRecord[] = [];
    setAuditSink((rec) => seen.push(rec));
    const r = res();
    beginAuditCapture(
      fakeReq({ remoteAddress: '10.0.0.5', headers: { 'x-forwarded-for': '1.2.3.4' } }),
      r as unknown as http.ServerResponse,
      1,
    );
    r.triggerClose();
    expect(seen[0].ip).toBe('10.0.0.5');
  });

  it('trusts X-Forwarded-For ONLY when the trust flag is set', () => {
    setAuditCaptureConfig(cfg({ trustForwardedFor: true }));
    const seen: AuditRecord[] = [];
    setAuditSink((rec) => seen.push(rec));
    const r = res();
    beginAuditCapture(
      fakeReq({ remoteAddress: '10.0.0.5', headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }),
      r as unknown as http.ServerResponse,
      1,
    );
    r.triggerClose();
    expect(seen[0].ip).toBe('1.2.3.4');
  });
});

describe('beginAuditCapture — secret discipline', () => {
  it('a written record (bodies on) contains NO key material / token / Authorization', () => {
    setAuditCaptureConfig(cfg({ captureBodies: true }));
    const seen: AuditRecord[] = [];
    setAuditSink((rec) => seen.push(rec));
    const r = res();
    const ctx = beginAuditCapture(
      fakeReq({
        headers: { authorization: 'Bearer sk-ant-api03-headertoken999', 'user-agent': 'x' },
      }),
      r as unknown as http.ServerResponse,
      1,
    );
    ctx!.keyId = 'key_1';
    ctx!.setRequestBody(
      'authorization: Bearer sk-ant-api03-bodytoken777 and x-api-key: sk-omnicross-bodykey888',
    );
    r.setHeader('content-type', 'application/json');
    r.write('leaked sk-proj-responsekey555 here');
    r.end();
    r.triggerClose();

    const serialized = JSON.stringify(seen[0]);
    for (const secret of [
      'sk-ant-api03-headertoken999',
      'sk-ant-api03-bodytoken777',
      'sk-omnicross-bodykey888',
      'sk-proj-responsekey555',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // The key ID (attribution) is fine — it is not key material.
    expect(seen[0].keyId).toBe('key_1');
  });
});

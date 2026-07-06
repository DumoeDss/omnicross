import { afterEach, describe, expect, it } from 'vitest';

import type { AuditConfig, AuditRecord } from '@omnicross/contracts/audit-types';

import {
  __resetAuditSinkForTests,
  getAuditCaptureConfig,
  recordAudit,
  setAuditCaptureConfig,
  setAuditSink,
} from '../auditSink';

const rec = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  id: 'r1',
  ts: 1,
  method: 'POST',
  path: '/v1/messages',
  status: 200,
  latencyMs: 5,
  ...over,
});

const cfg = (over: Partial<AuditConfig> = {}): AuditConfig => ({
  enabled: true,
  captureBodies: false,
  maxBodyBytes: 8192,
  retentionDays: 7,
  trustForwardedFor: false,
  ...over,
});

afterEach(() => __resetAuditSinkForTests());

describe('auditSink — module-slot sink port', () => {
  it('is a no-op when no sink is registered (zero regression)', () => {
    expect(() => recordAudit(rec())).not.toThrow();
  });

  it('hands the record to a registered sink', () => {
    const seen: AuditRecord[] = [];
    setAuditSink((r) => seen.push(r));
    recordAudit(rec({ id: 'x' }));
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe('x');
  });

  it('NEVER throws even when the sink throws (a relay is never disrupted)', () => {
    setAuditSink(() => {
      throw new Error('writer exploded');
    });
    expect(() => recordAudit(rec())).not.toThrow();
  });

  it('clearing the sink restores the no-op baseline', () => {
    const seen: AuditRecord[] = [];
    setAuditSink((r) => seen.push(r));
    setAuditSink(null);
    recordAudit(rec());
    expect(seen).toHaveLength(0);
  });
});

describe('auditSink — capture-config slot', () => {
  it('is null by default (audit disabled)', () => {
    expect(getAuditCaptureConfig()).toBeNull();
  });

  it('holds an enabled config', () => {
    setAuditCaptureConfig(cfg());
    expect(getAuditCaptureConfig()?.enabled).toBe(true);
  });

  it('coerces a disabled config to null (so capture never engages)', () => {
    setAuditCaptureConfig(cfg({ enabled: false }));
    expect(getAuditCaptureConfig()).toBeNull();
  });

  it('null clears the slot', () => {
    setAuditCaptureConfig(cfg());
    setAuditCaptureConfig(null);
    expect(getAuditCaptureConfig()).toBeNull();
  });
});

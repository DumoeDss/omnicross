import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuditConfig, AuditRecord } from '@omnicross/contracts/audit-types';
import type { Logger } from '@omnicross/core';
import {
  __resetAuditSinkForTests,
  getAuditCaptureConfig,
  recordAudit,
} from '@omnicross/core/pipeline/auditSink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditPruneSweeper } from '../AuditPruneSweeper';
import { applyAuditConfig, resetAuditRuntimeForTests, setAuditRuntime } from '../auditRuntime';
import { AuditWriter } from '../AuditWriter';

const noopLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const cfg = (over: Partial<AuditConfig> = {}): AuditConfig => ({
  enabled: true,
  captureBodies: false,
  maxBodyBytes: 8192,
  retentionDays: 7,
  trustForwardedFor: false,
  ...over,
});

const rec = (): AuditRecord => ({
  id: 'r1',
  ts: Date.now(),
  method: 'POST',
  path: '/v1/messages',
  status: 200,
  latencyMs: 1,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-audit-rt-'));
  // Synchronous defer so recordAudit → writer append is observable inline.
  const writer = new AuditWriter(dir, noopLogger, (fn) => fn());
  const sweeper = new AuditPruneSweeper(dir, noopLogger, cfg({ enabled: false }));
  setAuditRuntime(writer, sweeper);
});
afterEach(() => {
  resetAuditRuntimeForTests();
  __resetAuditSinkForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe('applyAuditConfig', () => {
  it('installs the capture config + sink when enabled (a record is written)', () => {
    applyAuditConfig(cfg());
    expect(getAuditCaptureConfig()?.enabled).toBe(true);
    recordAudit(rec());
    expect(readdirSync(dir).some((f) => f.startsWith('audit-'))).toBe(true);
  });

  it('clears both core slots when disabled (no sink ⇒ recordAudit no-op)', () => {
    applyAuditConfig(cfg());
    applyAuditConfig(cfg({ enabled: false }));
    expect(getAuditCaptureConfig()).toBeNull();
    recordAudit(rec());
    expect(readdirSync(dir).some((f) => f.startsWith('audit-'))).toBe(false);
  });

  it('undefined config leaves audit disabled (zero regression)', () => {
    applyAuditConfig(undefined);
    expect(getAuditCaptureConfig()).toBeNull();
    recordAudit(rec());
    expect(readdirSync(dir).some((f) => f.startsWith('audit-'))).toBe(false);
  });

  it('resetAuditRuntimeForTests clears the core sink', () => {
    applyAuditConfig(cfg());
    resetAuditRuntimeForTests();
    expect(getAuditCaptureConfig()).toBeNull();
    recordAudit(rec());
    expect(readdirSync(dir).some((f) => f.startsWith('audit-'))).toBe(false);
  });
});

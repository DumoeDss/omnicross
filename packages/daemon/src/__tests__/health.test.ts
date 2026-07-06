/**
 * health.test.ts — the pure `/health` report builder (daemon-health-endpoint).
 *
 * Proves the coarse status math (ok / degraded / error → the 200/503 mapping),
 * that a throwing probe collapses to `false` (never crashes), and the load-
 * bearing SECRET-SCAN: the serialized report contains no secret-looking string.
 */

import { healthHttpStatus } from '@omnicross/contracts/health-logging-types';
import { describe, expect, it } from 'vitest';

import { buildHealthReport, type HealthReportDeps } from '../admin/health';

/** All-healthy deps with fixed process-stat seams for a deterministic report. */
function healthyDeps(over: Partial<HealthReportDeps> = {}): HealthReportDeps {
  return {
    version: '1.2.3',
    configPresent: () => true,
    credentialStoreReadable: () => true,
    outboundServerRunning: () => true,
    adminServerRunning: () => true,
    memoryUsage: () =>
      ({ rss: 100 * 1024 * 1024, heapUsed: 50 * 1024 * 1024, heapTotal: 0, external: 0, arrayBuffers: 0 }) as NodeJS.MemoryUsage,
    uptimeSeconds: () => 42.9,
    now: () => 1_700_000_000_000,
    ...over,
  };
}

describe('buildHealthReport', () => {
  it('all checks pass → ok (200) with the expected coarse shape', () => {
    const report = buildHealthReport(healthyDeps());
    expect(report.status).toBe('ok');
    expect(healthHttpStatus(report.status)).toBe(200);
    expect(report.version).toBe('1.2.3');
    expect(report.uptimeSeconds).toBe(42); // floored
    expect(report.timestamp).toBe(new Date(1_700_000_000_000).toISOString());
    expect(report.memory.rssMb).toBe(100);
    expect(report.memory.heapUsedMb).toBe(50);
    expect(report.checks).toEqual({
      config: true,
      credentialStore: true,
      outboundServer: true,
      adminServer: true,
    });
  });

  it('a false NON-critical check → degraded (503)', () => {
    const report = buildHealthReport(healthyDeps({ outboundServerRunning: () => false }));
    expect(report.status).toBe('degraded');
    expect(healthHttpStatus(report.status)).toBe(503);
    expect(report.checks.outboundServer).toBe(false);
  });

  it('adminServer down alone stays ok (informational — a disabled dashboard must not fail the traffic probe)', () => {
    const report = buildHealthReport(healthyDeps({ adminServerRunning: () => false }));
    expect(report.status).toBe('ok');
    expect(report.checks.adminServer).toBe(false);
  });

  it('a false CRITICAL check → error (503)', () => {
    const report = buildHealthReport(healthyDeps({ credentialStoreReadable: () => false }));
    expect(report.status).toBe('error');
    expect(healthHttpStatus(report.status)).toBe(503);
    expect(report.checks.credentialStore).toBe(false);
  });

  it('a THROWING probe collapses to false (never crashes) → error', () => {
    const report = buildHealthReport(
      healthyDeps({
        configPresent: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(report.status).toBe('error');
    expect(report.checks.config).toBe(false);
  });

  it('account-probe boolean: absent thunk ⇒ key omitted (byte-identical, zero regression)', () => {
    const report = buildHealthReport(healthyDeps());
    expect(report.checks).not.toHaveProperty('subscriptionAccountsHealthy');
  });

  it('account-probe boolean: undefined (disabled) ⇒ key omitted', () => {
    const report = buildHealthReport(healthyDeps({ subscriptionAccountsHealthy: () => undefined }));
    expect(report.checks).not.toHaveProperty('subscriptionAccountsHealthy');
  });

  it('account-probe boolean: enabled ⇒ informational (added to checks; never moves status)', () => {
    const unhealthy = buildHealthReport(healthyDeps({ subscriptionAccountsHealthy: () => false }));
    expect(unhealthy.checks.subscriptionAccountsHealthy).toBe(false);
    expect(unhealthy.status).toBe('ok'); // informational — an unhealthy account does NOT fail /health

    const healthy = buildHealthReport(healthyDeps({ subscriptionAccountsHealthy: () => true }));
    expect(healthy.checks.subscriptionAccountsHealthy).toBe(true);
  });

  it('account-probe boolean: a throwing thunk collapses to false (never crashes)', () => {
    const report = buildHealthReport(
      healthyDeps({
        subscriptionAccountsHealthy: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(report.checks.subscriptionAccountsHealthy).toBe(false);
    expect(report.status).toBe('ok');
  });

  it('SECRET SCAN — the serialized report contains no secret-looking string', () => {
    // Even a hostile version string must not smuggle a token; the report carries
    // only coarse booleans + version + process stats — never a token/email/path.
    const report = buildHealthReport(healthyDeps({ version: '9.9.9' }));
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}/); // no bearer shapes
    expect(text).not.toMatch(/@/); // no emails
    expect(text).not.toMatch(/accessToken|refreshToken|apiKey|password/i);
    // The only keys present are the frozen coarse fields.
    expect(Object.keys(report).sort()).toEqual(
      ['checks', 'memory', 'status', 'timestamp', 'uptimeSeconds', 'version'].sort(),
    );
  });
});

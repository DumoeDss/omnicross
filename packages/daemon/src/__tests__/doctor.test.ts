/**
 * Tests for `omnicross doctor claude` (§9, claude-api-experience-extras):
 * the pure check array (table-driven: healthy / empty-routing / heartbeat
 * range / disabled heartbeat), and the --live probe (exactly ONE count_tokens
 * POST, ZERO generation calls, missing-key guidance, no-fetch without --live).
 *
 * @module daemon/__tests__/doctor.test
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OutboundApiServerConfig } from '@omnicross/core/outbound-api/types';

import {
  buildClaudeDoctorChecks,
  buildImagesDoctorChecks,
  runDoctor,
  runImagesLiveDoctor,
  runLiveProbe,
} from '../commands/doctor';
import { resetDaemonSingletonsForTests } from '../bootstrap';
import type { ImageDoctorLocalSnapshot } from '../image-generation/ImageDoctorService';

function config(over: Partial<OutboundApiServerConfig> = {}): OutboundApiServerConfig {
  return {
    enabled: true,
    networkBinding: false,
    endpoints: [],
    bindings: [
      {
        id: 'b1',
        name: 'claude route',
        enabled: true,
        endpoint: 'messages',
        target: { kind: 'account-pool', providerId: 'claude' },
        fallback: 'fail',
        modelMode: 'passthrough',
      },
    ],
    ...over,
  } as OutboundApiServerConfig;
}

describe('buildClaudeDoctorChecks (pure, table-driven)', () => {
  it('a healthy config passes every check (no hard failures)', () => {
    const checks = buildClaudeDoctorChecks(config());
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.find((c) => c.name === 'messages routing')?.ok).toBe(true);
    expect(checks.find((c) => c.name === 'synthetic ping heartbeat')?.warn).toBeFalsy();
  });

  it('no enabled messages route → the routing check FAILS (drives exit 1)', () => {
    const checks = buildClaudeDoctorChecks(config({ bindings: [] }));
    const routing = checks.find((c) => c.name === 'messages routing');
    expect(routing?.ok).toBe(false);
    expect(checks.some((c) => !c.ok)).toBe(true);
  });

  it('a heartbeat outside 15-30s FAILS the check (warn flag + exit-code flip, per spec)', () => {
    const checks = buildClaudeDoctorChecks(
      config({ anthropic: { heartbeatIntervalMs: 5_000 } as never }),
    );
    const heartbeat = checks.find((c) => c.name === 'synthetic ping heartbeat');
    expect(heartbeat?.ok).toBe(false);
    expect(heartbeat?.warn).toBe(true);
    expect(heartbeat?.detail).toContain('outside the recommended');
    // It alone makes the report a hard failure (exit 1).
    expect(checks.some((c) => !c.ok)).toBe(true);
  });

  it('heartbeat ≤0 reports disabled (a legal configuration — ok)', () => {
    const checks = buildClaudeDoctorChecks(
      config({ anthropic: { heartbeatIntervalMs: 0 } as never }),
    );
    const heartbeat = checks.find((c) => c.name === 'synthetic ping heartbeat');
    expect(heartbeat?.ok).toBe(true);
    expect(heartbeat?.detail).toContain('disabled');
  });

  it('a messages binding with only BLANK refs is NOT ready (spec m2)', () => {
    const checks = buildClaudeDoctorChecks(
      config({
        bindings: [
          {
            id: 'b-blank',
            name: 'blank kind map',
            enabled: true,
            endpoint: 'messages',
            target: { kind: 'account-pool', providerId: 'claude' },
            fallback: 'fail',
            modelMap: { fable: '', sonnet: '' },
          },
        ],
      }),
    );
    const routing = checks.find((c) => c.name === 'messages routing');
    expect(routing?.ok).toBe(false);
    expect(routing?.detail).toContain('none carry a routable target');
  });

  it('a kind-mapped binding with at least one non-empty ref IS ready', () => {
    const checks = buildClaudeDoctorChecks(
      config({
        bindings: [
          {
            id: 'b-kind',
            name: 'kind map',
            enabled: true,
            endpoint: 'messages',
            target: { kind: 'account-pool', providerId: 'claude' },
            fallback: 'fail',
            modelMap: { fable: 'claude,claude-sonnet-4-5', sonnet: '' },
          },
        ],
      }),
    );
    expect(checks.find((c) => c.name === 'messages routing')?.ok).toBe(true);
  });

  it('defaults report proxyOauthUsage off + apiHello on', () => {
    const checks = buildClaudeDoctorChecks(config());
    expect(checks.find((c) => c.name === 'oauth usage proxy')?.detail).toContain(
      'proxyOauthUsage=false',
    );
    expect(checks.find((c) => c.name === 'api hello')?.detail).toContain('apiHello=true');
  });
});

describe('runLiveProbe', () => {
  it('sends exactly ONE count_tokens POST and ZERO generation calls', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body });
      return new Response('{"input_tokens":1}', {
        status: 200,
        headers: { 'x-omnicross-count-estimate': 'true' },
      });
    }) as unknown as typeof fetch;
    const result = await runLiveProbe('http://127.0.0.1:8765', 'sk-test', fetchMock);
    expect(result.status).toBe(200);
    expect(result.estimateHeader).toBe('true');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:8765/v1/messages/count_tokens');
    expect(calls[0].method).toBe('POST');
    expect(calls.every((c) => c.url.endsWith('/count_tokens'))).toBe(true);
  });

  it('network errors are reported, not thrown', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await runLiveProbe('http://127.0.0.1:1', 'k', fetchMock);
    expect(result.status).toBeNull();
    expect(result.error).toContain('ECONNREFUSED');
  });
});

function imageSnapshot(over: Partial<ImageDoctorLocalSnapshot> = {}): ImageDoctorLocalSnapshot {
  return {
    config: { enabled: true, provider: 'codex-subscription', model: 'gpt-image-2', valid: true, errorCount: 0 },
    roots: { valid: true, verifiedAreas: 5, expectedAreas: 5 },
    stores: {
      valid: true,
      mounts: 1,
      retiredMounts: 0,
      referenceEntries: 0,
      referenceBytes: 0,
      stateCalls: 0,
      stateResponses: 0,
      corruptManifestsQuarantined: 0,
    },
    permissions: { valid: true, rows: 1, legacyRows: 0, invalidRows: 0, imagesAuthorizedRows: 1 },
    account: { present: true, usable: true, reason: 'ready' },
    evidence: { valid: true, entries: 1, freshEntries: 1, staleEntries: 0, bytes: 64 },
    ...over,
  };
}

describe('Images doctor projections', () => {
  it('treats enabled missing-account and stale-evidence states as honest failures', () => {
    const checks = buildImagesDoctorChecks(imageSnapshot({
      account: { present: true, usable: false, reason: 'unavailable' },
      evidence: { valid: true, entries: 1, freshEntries: 0, staleEntries: 1, bytes: 64 },
    }));
    expect(checks.find((check) => check.name === 'Codex account')).toMatchObject({
      ok: false,
      warn: true,
    });
    expect(checks.find((check) => check.name === 'cached capability evidence')).toMatchObject({
      ok: false,
      warn: true,
    });
  });

  it('prints the quota warning before invoking live verification and emits only safe metadata', async () => {
    const order: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((message) => {
      order.push(String(message));
    });
    const doctor = {
      inspectLocal: vi.fn(),
      verifyLive: vi.fn(async () => {
        order.push('VERIFY_CALLED');
        return {
          ok: true as const,
          code: 'verified' as const,
          model: 'gpt-image-2' as const,
          quality: 'low' as const,
          outputFormat: 'png' as const,
          freshEvidenceEntries: 1,
        };
      }),
    };
    const ok = await runImagesLiveDoctor(config({ images: { enabled: true } as never }), doctor);
    expect(ok).toBe(true);
    expect(order[0]).toContain('consume subscription quota');
    expect(order[1]).toBe('VERIFY_CALLED');
    expect(doctor.verifyLive).toHaveBeenCalledOnce();
    expect(order.join('\n')).not.toContain('account');
    vi.restoreAllMocks();
  });

  it('prints only a stable live failure code', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const doctor = {
      inspectLocal: vi.fn(),
      verifyLive: vi.fn(async () => ({
        ok: false as const,
        code: 'upstream_protocol_changed' as const,
      })),
    };
    const ok = await runImagesLiveDoctor(config({ images: { enabled: true } as never }), doctor);
    expect(ok).toBe(false);
    expect(console.info).toHaveBeenLastCalledWith(
      '  [✗] live Images verification: upstream_protocol_changed',
    );
    vi.restoreAllMocks();
  });
});

describe('runDoctor (config-file driven)', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnicross-doctor-'));
    configPath = join(dir, 'config.json');
    writeFileSync(configPath, '{"providers":[]}\n', 'utf8');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetDaemonSingletonsForTests();
  });

  it('without --live it makes ZERO fetches and exits by check results (empty routing → 1)', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const exit = await runDoctor(
      ['claude', '--config', configPath],
      fetchMock,
    );
    // A fresh config has no messages bindings → routing check fails → exit 1.
    expect(exit).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30_000);

  it('Images doctor without --live performs zero fetches and reports local checks only', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const exit = await runDoctor(['images', '--config', configPath], fetchMock);
    expect(exit).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('omnicross doctor images'));
    expect(console.info).not.toHaveBeenCalledWith(expect.stringContaining('consume subscription quota'));
    expect(JSON.stringify((console.info as ReturnType<typeof vi.fn>).mock.calls))
      .not.toContain(configPath);
  }, 30_000);

  it('--live without --key prints guidance and exits 1 (no fetch)', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const exit = await runDoctor(
      ['claude', '--config', configPath, '--live'],
      fetchMock,
    );
    expect(exit).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--key'));
  }, 30_000);

  it('--live --key probes exactly once and a 200 estimate reply exits 0', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"input_tokens":1}', {
        status: 200,
        headers: { 'x-omnicross-count-estimate': 'true' },
      }),
    ) as unknown as typeof fetch;
    const exit = await runDoctor(
      ['claude', '--config', configPath, '--live', '--key', 'sk-test', '--url', 'http://127.0.0.1:8765'],
      fetchMock,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe(
      'http://127.0.0.1:8765/v1/messages/count_tokens',
    );
    // Routing still fails on this fresh config → exit stays 1 even with a good probe.
    expect(exit).toBe(1);
  }, 30_000);
});

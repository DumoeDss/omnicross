/**
 * admin-logs-export.test.ts — `GET /admin/api/logs/export` (bug-report log
 * bundle) plus the pure bundler behind it.
 *
 *  - generations concatenate OLDEST-first with section headers;
 *  - obvious secret shapes (sk-…, Bearer …, api-key: …) are redacted even
 *    though logger call sites are supposed to keep secrets out in the first
 *    place (defense in depth — the export may be attached to a public issue);
 *  - the size cap drops the OLDEST whole files and notes them in the header;
 *  - the endpoint answers text/plain + Content-Disposition, admin-authed like
 *    every other /admin/api route.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildLogExportBundle, logGenerationPaths } from '../admin/logsExport';
import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

let tmpDir: string;
let adminBase: string;
let daemon: Daemon;
let logFile: string;

function writeConfig(configPath: string): void {
  const cfg = {
    providers: [
      { id: 'mock', apiFormat: 'anthropic', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-mock-zzz', models: ['mock-model'] },
    ],
    server: { enabled: false },
    admin: { port: 0 },
    logging: { file: logFile, level: 'info', format: 'json' },
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

async function adminFetch(path: string): Promise<Response> {
  return fetch(`${adminBase}${path}`, { method: 'GET' });
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-logs-'));
  mkdirSync(join(tmpDir, 'logs'), { recursive: true });
  logFile = join(tmpDir, 'logs', 'daemon.log');
});

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    daemon.providerProxy.stop();
  }
  resetDaemonSingletonsForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildLogExportBundle', () => {
  it('concatenates generations oldest-first with section headers', () => {
    writeFileSync(`${logFile}.2`, '{"msg":"oldest"}\n', 'utf8');
    writeFileSync(`${logFile}.1`, '{"msg":"older"}\n', 'utf8');
    writeFileSync(logFile, '{"msg":"live"}\n', 'utf8');

    const bundle = buildLogExportBundle(logFile, { now: new Date('2026-09-15T08:09:10Z') });
    expect(bundle.filename).toBe('omnicross-logs-2026-09-15-080910.log');
    // Order: .2 → .1 → live.
    const oldest = bundle.text.indexOf('===== daemon.log.2 =====');
    const older = bundle.text.indexOf('===== daemon.log.1 =====');
    const live = bundle.text.indexOf('===== daemon.log =====');
    expect(oldest).toBeGreaterThanOrEqual(0);
    expect(oldest).toBeLessThan(older);
    expect(older).toBeLessThan(live);
    expect(bundle.text).toContain('"msg":"oldest"');
    expect(bundle.text).toContain('"msg":"live"');
  });

  it('redacts obvious secret shapes from every line', () => {
    writeFileSync(logFile, [
      '{"msg":"auth failed","detail":"key sk-omnicross-AbCdEf123456 rejected"}',
      '{"msg":"header echo","detail":"Bearer eyJhbGciOi.abcdef123456"}',
      '{"msg":"inline","detail":"api-key: supersecretvalue123"}',
      '{"msg":"harmless","detail":"model gpt-5.3-codex"}',
    ].join('\n'), 'utf8');

    const bundle = buildLogExportBundle(logFile);
    expect(bundle.text).not.toContain('sk-omnicross-AbCdEf123456');
    expect(bundle.text).not.toContain('eyJhbGciOi.abcdef123456');
    expect(bundle.text).not.toContain('supersecretvalue123');
    expect(bundle.text).toContain('***REDACTED***');
    expect(bundle.text).toContain('model gpt-5.3-codex');
  });

  it('drops the OLDEST whole files past the size cap and notes them', () => {
    writeFileSync(`${logFile}.2`, 'x'.repeat(100), 'utf8');
    writeFileSync(`${logFile}.1`, 'y'.repeat(100), 'utf8');
    writeFileSync(logFile, 'z'.repeat(100), 'utf8');

    // 300 bytes total against a 200-byte cap: the oldest generation drops,
    // the remaining two (rotated .1 + live) fit and are kept.
    const bundle = buildLogExportBundle(logFile, { maxBytes: 200 });
    expect(bundle.text).toContain('# omitted (size cap): daemon.log.2');
    expect(bundle.text).not.toContain('===== daemon.log.2 =====');
    // The live generation is ALWAYS kept.
    expect(bundle.text).toContain('===== daemon.log =====');
    expect(bundle.text).toContain('===== daemon.log.1 =====');
  });

  it('returns an explanatory bundle when no log file exists', () => {
    expect(logGenerationPaths(logFile)).toEqual([]);
    const bundle = buildLogExportBundle(logFile);
    expect(bundle.text).toContain('no log file found');
  });
});

describe('GET /admin/api/logs/export', () => {
  it('answers a redacted text/plain attachment', async () => {
    writeFileSync(`${logFile}.1`, '{"level":"warn","msg":"rotated line"}\n', 'utf8');
    writeFileSync(logFile, '{"level":"error","msg":"boom","meta":{"key":"sk-omnicross-ZzZzZz987654"}}\n', 'utf8');

    const configPath = join(tmpDir, 'config.json');
    writeConfig(configPath);
    daemon = buildDaemon(loadConfig(configPath), {
      configPath,
      keysPath: join(tmpDir, 'keys.json'),
      tokensPath: join(tmpDir, 'tokens.json'),
      masterKeyFilePath: join(tmpDir, 'master.key'),
    });
    await daemon.llmConfig.ready();
    await daemon.providerProxy.start();
    await daemon.adminServer.start();
    adminBase = daemon.adminServer.getStatus().url as string;

    const res = await adminFetch('/admin/api/logs/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/^attachment; filename="omnicross-logs-[^"]+\.log"$/);

    const text = await res.text();
    expect(text).toContain('===== daemon.log.1 =====');
    expect(text).toContain('rotated line');
    expect(text).toContain('boom');
    // The secret from the log line never leaves the daemon unredacted.
    expect(text).not.toContain('sk-omnicross-ZzZzZz987654');
    expect(text).toContain('***REDACTED***');
  });

  it('rejects an unknown logs subpath (404)', async () => {
    const configPath = join(tmpDir, 'config.json');
    writeConfig(configPath);
    daemon = buildDaemon(loadConfig(configPath), {
      configPath,
      keysPath: join(tmpDir, 'keys.json'),
      tokensPath: join(tmpDir, 'tokens.json'),
      masterKeyFilePath: join(tmpDir, 'master.key'),
    });
    await daemon.llmConfig.ready();
    await daemon.providerProxy.start();
    await daemon.adminServer.start();
    adminBase = daemon.adminServer.getStatus().url as string;

    const res = await adminFetch('/admin/api/logs/other');
    expect(res.status).toBe(404);
  });
});

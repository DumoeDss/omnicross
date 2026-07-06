/**
 * ConfigurableLogger.test.ts — the configurable logger (configurable-logging).
 *
 * Covers: level filtering (below-threshold dropped), the JSON line shape, the
 * file sink (append + error-swallow), and the load-bearing ZERO-REGRESSION
 * assertion — `new ConfigurableLogger()` calls the SAME console method with the
 * SAME args as the legacy `ConsoleLogger`.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigurableLogger } from '../ports/ConfigurableLogger';
import { ConsoleLogger } from '../ports/ConsoleLogger';

/** Spy on every console sink method; restored in afterEach. */
function spyConsole() {
  return {
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-logger-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ConfigurableLogger — level filtering', () => {
  it('level=warn drops info + debug, keeps warn + error', () => {
    const spy = spyConsole();
    const log = new ConfigurableLogger({ level: 'warn' });
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    expect(spy.error).toHaveBeenCalledTimes(1);
    expect(spy.warn).toHaveBeenCalledTimes(1);
    expect(spy.info).not.toHaveBeenCalled();
    expect(spy.debug).not.toHaveBeenCalled();
  });

  it('level=error keeps only error', () => {
    const spy = spyConsole();
    const log = new ConfigurableLogger({ level: 'error' });
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    expect(spy.error).toHaveBeenCalledTimes(1);
    expect(spy.warn).not.toHaveBeenCalled();
    expect(spy.info).not.toHaveBeenCalled();
    expect(spy.debug).not.toHaveBeenCalled();
  });

  it('default (no config) prints ALL levels (threshold=debug)', () => {
    const spy = spyConsole();
    const log = new ConfigurableLogger();
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    expect(spy.error).toHaveBeenCalledTimes(1);
    expect(spy.warn).toHaveBeenCalledTimes(1);
    expect(spy.info).toHaveBeenCalledTimes(1);
    expect(spy.debug).toHaveBeenCalledTimes(1);
  });
});

describe('ConfigurableLogger — json format', () => {
  it('emits one JSON line { ts, level, msg, ...meta }', () => {
    const spy = spyConsole();
    const log = new ConfigurableLogger({ format: 'json' });
    log.info('hello', { requestId: 'r1', count: 2 });
    expect(spy.info).toHaveBeenCalledTimes(1);
    const line = spy.info.mock.calls[0][0] as string;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello');
    expect(parsed.requestId).toBe('r1');
    expect(parsed.count).toBe(2);
    expect(typeof parsed.ts).toBe('string');
  });

  it('a caller meta key does NOT overwrite the reserved envelope fields', () => {
    const spy = spyConsole();
    const log = new ConfigurableLogger({ format: 'json' });
    // A hostile/careless meta bag names the envelope fields — the real level/msg
    // must win (the envelope is reused by #5/#13 and must stay inviolable).
    log.info('real-msg', { level: 'HACKED', msg: 'HACKED', ts: 'HACKED', error: 'HACKED', keep: 'me' });
    const parsed = JSON.parse(spy.info.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('real-msg');
    expect(parsed.ts).not.toBe('HACKED');
    expect(parsed.error).toBeUndefined();
    // …but a non-reserved caller key is preserved.
    expect(parsed.keep).toBe('me');
  });

  it('reduces an Error arg to { message, stack }', () => {
    const spy = spyConsole();
    const log = new ConfigurableLogger({ format: 'json' });
    log.error('failed', new Error('kaboom'));
    const line = spy.error.mock.calls[0][0] as string;
    const parsed = JSON.parse(line) as { error: { message: string; stack?: string } };
    expect(parsed.error.message).toBe('kaboom');
    expect(typeof parsed.error.stack).toBe('string');
  });
});

describe('ConfigurableLogger — file sink', () => {
  it('appends lines to the configured file (text)', async () => {
    spyConsole();
    const file = join(tmpDir, 'app.log');
    const log = new ConfigurableLogger({ file });
    log.info('first line');
    log.warn('second line');
    await log.close();
    const contents = readFileSync(file, 'utf8');
    expect(contents).toContain('first line');
    expect(contents).toContain('second line');
    expect(contents).toContain('[info]');
    expect(contents).toContain('[warn]');
  });

  it('appends JSON lines when format=json', async () => {
    spyConsole();
    const file = join(tmpDir, 'app.jsonl');
    const log = new ConfigurableLogger({ file, format: 'json' });
    log.info('json line', { k: 'v' });
    await log.close();
    const line = readFileSync(file, 'utf8').trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.msg).toBe('json line');
    expect(parsed.k).toBe('v');
  });

  it('a file-open error is swallowed (never throws) and console still logs', async () => {
    const spy = spyConsole();
    // A path whose parent dir does not exist → createWriteStream emits 'error'
    // asynchronously; the write is swallowed. The logger must not throw.
    const log = new ConfigurableLogger({ file: join(tmpDir, 'no', 'such', 'dir', 'x.log') });
    expect(() => log.info('still fine')).not.toThrow();
    expect(spy.info).toHaveBeenCalledWith('still fine');
    await log.close();
  });
});

describe('ConfigurableLogger — zero-regression vs ConsoleLogger', () => {
  it('default logger calls the SAME console method + args as ConsoleLogger', () => {
    // Drive both loggers through identical calls and compare the recorded
    // console invocations argument-for-argument.
    const record = (run: (l: ConsoleLogger | ConfigurableLogger) => void, logger: ConsoleLogger | ConfigurableLogger) => {
      const spy = spyConsole();
      run(logger);
      const snapshot = {
        error: spy.error.mock.calls,
        warn: spy.warn.mock.calls,
        info: spy.info.mock.calls,
        debug: spy.debug.mock.calls,
      };
      vi.restoreAllMocks();
      return snapshot;
    };

    // Reuse the SAME Error instances across both runs so the recorded console
    // args compare by identity (not by two distinct errors with differing stacks).
    const err1 = new Error('x');
    const err2 = new Error('y');
    const drive = (l: ConsoleLogger | ConfigurableLogger): void => {
      l.info('i-plain');
      l.info('i-meta', { a: 1 });
      l.warn('w-plain');
      l.warn('w-meta', { b: 2 });
      l.debug('d-plain');
      l.error('e-plain');
      l.error('e-err', err1);
      l.error('e-err-meta', err2, { c: 3 });
    };

    const legacy = record(drive, new ConsoleLogger());
    const configurable = record(drive, new ConfigurableLogger());
    expect(configurable).toEqual(legacy);
  });
});

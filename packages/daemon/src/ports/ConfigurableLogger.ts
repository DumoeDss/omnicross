/**
 * ConfigurableLogger — a `Logger` port impl with level / format / file sink
 * (configurable-logging, design D3). Supersedes `ConsoleLogger` as the injected
 * daemon logger.
 *
 *  - LEVEL: numeric severity `error(0) < warn(1) < info(2) < debug(3)`; a message
 *    whose level is BELOW the configured threshold (higher ordinal) is dropped.
 *    Default threshold = `debug` (prints everything).
 *  - FORMAT: `text` (the legacy `console.*(message, meta)` shape) | `json` (one
 *    structured line `{ ts, level, msg, ...meta }`). Default `text`.
 *  - SINK: always the console; PLUS an optional append-only file stream when
 *    `file` is set (lazy-open; a write/open error is swallowed → the daemon never
 *    crashes on a logging failure, it just falls back to the console).
 *
 * ZERO-REGRESSION DEFAULT: `new ConfigurableLogger()` (no config) = console +
 * all levels + text = behaviorally byte-identical to the legacy `ConsoleLogger`
 * (same `console` method per level, same `(message[, meta])` / error arg shape).
 *
 * CAUTION (per the #3 host:port-only-logging precedent): the JSON serializer
 * reduces an `Error` to `{ message, stack }` and spreads a plain `meta` object,
 * but it is NOT a secret redactor — call sites remain responsible for not passing
 * secret-bearing objects.
 *
 * @module @omnicross/daemon/ports/ConfigurableLogger
 */

import { createWriteStream, type WriteStream } from 'node:fs';

import type { LoggingConfig, LogLevel } from '@omnicross/contracts/health-logging-types';
import type { Logger } from '@omnicross/core';

/** Severity ordinals — lower = more severe; the threshold keeps `<=`. */
const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Envelope keys a caller's `meta` bag may NOT overwrite in the JSON line. The
 *  envelope is a frozen contract reused by sibling changes (#5 webhooks / #13
 *  audit-log), so it stays inviolable. */
const RESERVED_JSON_KEYS = new Set(['ts', 'level', 'msg', 'error']);

export class ConfigurableLogger implements Logger {
  private readonly threshold: number;
  private readonly format: 'text' | 'json';
  private readonly filePath: string | undefined;
  private fileStream: WriteStream | null = null;
  private fileDisabled = false;

  constructor(cfg?: LoggingConfig) {
    this.threshold = LEVEL_ORDER[cfg?.level ?? 'debug'];
    this.format = cfg?.format ?? 'text';
    this.filePath = cfg?.file && cfg.file.length > 0 ? cfg.file : undefined;
  }

  info(message: string, meta?: Record<string, unknown> | Error | object): void {
    this.emit('info', message, undefined, meta);
  }

  warn(message: string, meta?: Record<string, unknown> | Error | object): void {
    this.emit('warn', message, undefined, meta);
  }

  error(message: string, error?: unknown, meta?: Record<string, unknown> | object): void {
    this.emit('error', message, error, meta);
  }

  debug(message: string, meta?: Record<string, unknown> | Error | object): void {
    this.emit('debug', message, undefined, meta);
  }

  /**
   * Flush + close the file sink (tests / graceful shutdown). Resolves once the
   * append stream has finished flushing to disk. No-op when no file sink is open.
   */
  close(): Promise<void> {
    const stream = this.fileStream;
    this.fileStream = null;
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => stream.end(() => resolve()));
  }

  private emit(level: LogLevel, message: string, error: unknown, meta: unknown): void {
    if (LEVEL_ORDER[level] > this.threshold) return;
    this.writeConsole(level, message, error, meta);
    if (this.filePath) this.writeFile(level, message, error, meta);
  }

  /**
   * Console sink. In `text` format this reproduces the legacy `ConsoleLogger`
   * EXACTLY (same method + arg shape) so the unconfigured default is a byte-for-
   * byte drop-in; in `json` format it prints the structured line.
   */
  private writeConsole(level: LogLevel, message: string, error: unknown, meta: unknown): void {
    if (this.format === 'json') {
      this.consoleFn(level)(this.jsonLine(level, message, error, meta));
      return;
    }
    if (level === 'error') {
      if (error === undefined && meta === undefined) console.error(message);
      else if (meta === undefined) console.error(message, error);
      else console.error(message, error, meta);
      return;
    }
    const fn = this.consoleFn(level);
    if (meta === undefined) fn(message);
    else fn(message, meta);
  }

  /** Append one line to the file sink; a failure disables the sink (swallowed). */
  private writeFile(level: LogLevel, message: string, error: unknown, meta: unknown): void {
    const stream = this.getFileStream();
    if (!stream) return;
    try {
      const line =
        this.format === 'json'
          ? this.jsonLine(level, message, error, meta)
          : this.textLine(level, message, error, meta);
      stream.write(line + '\n');
    } catch {
      // A logging failure must never crash the daemon — drop it.
    }
  }

  /** Lazily open the append-only file stream; disable the sink on any error. */
  private getFileStream(): WriteStream | null {
    if (this.fileDisabled || !this.filePath) return null;
    if (this.fileStream) return this.fileStream;
    try {
      const stream = createWriteStream(this.filePath, { flags: 'a' });
      stream.on('error', () => {
        this.fileDisabled = true;
        this.fileStream = null;
      });
      this.fileStream = stream;
      return stream;
    } catch {
      this.fileDisabled = true;
      return null;
    }
  }

  private consoleFn(level: LogLevel): (...args: unknown[]) => void {
    switch (level) {
      case 'error':
        return console.error;
      case 'warn':
        return console.warn;
      case 'info':
        return console.info;
      case 'debug':
        return console.debug;
    }
  }

  /** `{ ts, level, msg, ...meta }` (+ `error` when present) as a single line. */
  private jsonLine(level: LogLevel, message: string, error: unknown, meta: unknown): string {
    const obj: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: message,
    };
    if (error !== undefined) obj['error'] = reduceError(error);
    if (meta !== undefined) {
      if (meta instanceof Error) obj['meta'] = reduceError(meta);
      else if (meta && typeof meta === 'object') {
        // Spread caller meta but NEVER let it clobber a reserved envelope field
        // (a colliding key is dropped — the envelope wins). Non-reserved keys are
        // preserved verbatim, keeping the frozen `{ ts, level, msg, ...meta }` shape.
        for (const [k, v] of Object.entries(meta)) {
          if (!RESERVED_JSON_KEYS.has(k)) obj[k] = v;
        }
      } else obj['meta'] = meta;
    }
    try {
      return JSON.stringify(obj);
    } catch {
      // Circular/unserializable meta → fall back to a minimal safe line.
      return JSON.stringify({ ts: obj['ts'], level, msg: message });
    }
  }

  /** Human-readable file line: `ISO [level] message {metaJson}`. */
  private textLine(level: LogLevel, message: string, error: unknown, meta: unknown): string {
    const parts = [`${new Date().toISOString()} [${level}] ${message}`];
    if (error !== undefined) parts.push(safeStringify(reduceError(error)));
    if (meta !== undefined) parts.push(safeStringify(meta instanceof Error ? reduceError(meta) : meta));
    return parts.join(' ');
  }
}

/** Reduce an Error (or any thrown value) to a compact, secret-agnostic shape. */
function reduceError(error: unknown): { message: string; stack?: string } | { value: string } {
  if (error instanceof Error) {
    return error.stack ? { message: error.message, stack: error.stack } : { message: error.message };
  }
  return { value: String(error) };
}

/** JSON.stringify that never throws (circular → `[unserializable]`). */
function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

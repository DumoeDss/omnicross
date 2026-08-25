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
 *  - ROTATION: the file sink is size-capped (`maxFileBytes`, default 8 MB) and
 *    keeps `maxFiles` generations (default 5) as `<file>.1` … `<file>.N`. An
 *    UNBOUNDED append-only log is how a long-lived daemon quietly fills a disk,
 *    so the cap is on by default rather than opt-in. Lines emitted mid-rotation
 *    are queued (bounded) and flushed into the fresh generation, never dropped
 *    silently unless the queue itself overflows.
 *
 * ZERO-REGRESSION DEFAULT: `new ConfigurableLogger()` (no config) = console +
 * all levels + text = behaviorally byte-identical to the legacy `ConsoleLogger`
 * (same `console` method per level, same `(message[, meta])` / error arg shape).
 *
 * NOTE — the daemon no longer CONSTRUCTS it that way. `bootstrap.ts` defaults the
 * file sink on (`<configDir>/logs/daemon.log`, level `info`, format `json`)
 * whenever the config omits it: the desktop app discards the daemon's stdout, so
 * a console-only logger meant a crash left no evidence at all. The unconfigured
 * CONSTRUCTOR default above is still console-only — only the daemon's wiring
 * changed.
 *
 * CAUTION (per the #3 host:port-only-logging precedent): the JSON serializer
 * reduces an `Error` to `{ message, stack }` and spreads a plain `meta` object,
 * but it is NOT a secret redactor — call sites remain responsible for not passing
 * secret-bearing objects.
 *
 * @module @omnicross/daemon/ports/ConfigurableLogger
 */

import {
  createWriteStream,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs';

import type { LoggingConfig, LogLevel } from '@omnicross/contracts/health-logging-types';
import type { Logger } from '@omnicross/core';

/** Severity ordinals — lower = more severe; the threshold keeps `<=`. */
const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Default file-sink size cap before a rotation (8 MB). */
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Default number of rotated generations kept beside the live file. */
const DEFAULT_MAX_FILES = 5;

/**
 * Hard ceiling on lines held while a rotation flushes. Rotation is a sub-second
 * `end()` + rename, so this is only ever reached by a pathological error storm —
 * past it lines ARE dropped, but a bounded queue is the only shape that cannot
 * itself become the memory leak it was added to prevent.
 */
const ROTATE_QUEUE_LIMIT = 1_000;

/** Envelope keys a caller's `meta` bag may NOT overwrite in the JSON line. The
 *  envelope is a frozen contract reused by sibling changes (#5 webhooks / #13
 *  audit-log), so it stays inviolable. */
const RESERVED_JSON_KEYS = new Set(['ts', 'level', 'msg', 'error']);

export class ConfigurableLogger implements Logger {
  private readonly threshold: number;
  private readonly format: 'text' | 'json';
  private readonly filePath: string | undefined;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private fileStream: WriteStream | null = null;
  private fileDisabled = false;
  /** Bytes in the CURRENT generation — seeded from the file on open. */
  private fileBytes = 0;
  /** True from the moment a rotation starts until the fresh stream is live. */
  private rotating = false;
  /** Lines emitted while `rotating`; flushed into the new generation. */
  private rotateQueue: string[] = [];

  constructor(cfg?: LoggingConfig) {
    this.threshold = LEVEL_ORDER[cfg?.level ?? 'debug'];
    this.format = cfg?.format ?? 'text';
    this.filePath = cfg?.file && cfg.file.length > 0 ? cfg.file : undefined;
    this.maxFileBytes =
      typeof cfg?.maxFileBytes === 'number' && cfg.maxFileBytes > 0
        ? cfg.maxFileBytes
        : DEFAULT_MAX_FILE_BYTES;
    this.maxFiles =
      typeof cfg?.maxFiles === 'number' && cfg.maxFiles > 0 ? cfg.maxFiles : DEFAULT_MAX_FILES;
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
    this.rotateQueue = [];
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
    if (this.fileDisabled || !this.filePath) return;
    let line: string;
    try {
      line =
        this.format === 'json'
          ? this.jsonLine(level, message, error, meta)
          : this.textLine(level, message, error, meta);
    } catch {
      // A logging failure must never crash the daemon — drop it.
      return;
    }
    // Mid-rotation the old stream is closing and the new one is not open yet;
    // park the line rather than write it into a file about to be renamed.
    if (this.rotating) {
      if (this.rotateQueue.length < ROTATE_QUEUE_LIMIT) this.rotateQueue.push(line);
      return;
    }
    this.emitLine(line);
  }

  /** Write ONE prepared line to the live generation, rotating once it is full. */
  private emitLine(line: string): void {
    const stream = this.getFileStream();
    if (!stream) return;
    try {
      stream.write(line + '\n');
      this.fileBytes += Buffer.byteLength(line, 'utf8') + 1;
    } catch {
      // A logging failure must never crash the daemon — drop it.
      return;
    }
    if (this.fileBytes >= this.maxFileBytes) this.rotate();
  }

  /**
   * Close the full generation, shift `<file>.N-1` → `<file>.N` (oldest dropped),
   * then reopen. Renames run in the `end()` callback so nothing still buffered in
   * the stream lands in the wrong generation. Any failure disables the sink
   * rather than throwing — the console sink is unaffected either way.
   */
  private rotate(): void {
    const stream = this.fileStream;
    const path = this.filePath;
    if (!stream || !path || this.rotating) return;
    this.rotating = true;
    this.fileStream = null;
    stream.end(() => {
      try {
        this.shiftGenerations(path);
        this.fileBytes = 0;
      } catch {
        this.fileDisabled = true;
      }
      this.rotating = false;
      const queued = this.rotateQueue;
      this.rotateQueue = [];
      for (const line of queued) this.emitLine(line);
    });
  }

  /** `<file>.N` unlinked, `<file>.k` → `<file>.k+1`, `<file>` → `<file>.1`. */
  private shiftGenerations(path: string): void {
    const oldest = `${path}.${this.maxFiles}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      if (existsSync(from)) renameSync(from, `${path}.${i + 1}`);
    }
    if (existsSync(path)) renameSync(path, `${path}.1`);
  }

  /**
   * Lazily open the append-only file stream; disable the sink on any error. The
   * byte counter is seeded from the file already on disk so a restart cannot
   * reset an almost-full generation back to zero and blow past the cap.
   */
  private getFileStream(): WriteStream | null {
    if (this.fileDisabled || !this.filePath) return null;
    if (this.fileStream) return this.fileStream;
    try {
      this.fileBytes = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
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

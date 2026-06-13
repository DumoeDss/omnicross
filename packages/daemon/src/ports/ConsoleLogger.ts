/**
 * ConsoleLogger — the daemon's file-less default `Logger` port impl (design D5).
 *
 * A thin `console.*` wrapper. The serving core depends on the `Logger` port
 * (never a host class), so this trivial implementation is the only logger the
 * standalone daemon needs. `error` uses the WIDEST `(message, error?, meta?)`
 * signature so every core call site stays assignable.
 *
 * @module @omnicross/daemon/ports/ConsoleLogger
 */

import type { Logger } from '@omnicross/core';

export class ConsoleLogger implements Logger {
  info(message: string, meta?: Record<string, unknown> | Error | object): void {
    if (meta === undefined) console.info(message);
    else console.info(message, meta);
  }

  warn(message: string, meta?: Record<string, unknown> | Error | object): void {
    if (meta === undefined) console.warn(message);
    else console.warn(message, meta);
  }

  error(
    message: string,
    error?: unknown,
    meta?: Record<string, unknown> | object,
  ): void {
    if (error === undefined && meta === undefined) console.error(message);
    else if (meta === undefined) console.error(message, error);
    else console.error(message, error, meta);
  }

  debug(message: string, meta?: Record<string, unknown> | Error | object): void {
    if (meta === undefined) console.debug(message);
    else console.debug(message, meta);
  }
}

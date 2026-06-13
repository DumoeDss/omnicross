/**
 * `Logger` — core-owned port for the structured logger the serving core uses.
 *
 * The serving core MUST depend on THIS interface, never on the concrete host
 * `LoggerService` class as a type. The host (`LoggerService`) already exposes a
 * superset of this surface, so it is passed directly with NO adapter.
 *
 * `error` uses the WIDEST signature `(message, error?, meta?)` so every core
 * call site — `error(msg)`, `error(msg, errInstance)`, `error(msg, err, meta)` —
 * stays assignable (design Q2). `info`/`warn`/`debug` take an optional `meta`
 * bag matching the host's `Record<string, unknown> | Error | object`.
 *
 * @module ports/logger
 */

export interface Logger {
  info(message: string, meta?: Record<string, unknown> | Error | object): void;
  warn(message: string, meta?: Record<string, unknown> | Error | object): void;
  error(
    message: string,
    error?: unknown,
    meta?: Record<string, unknown> | object,
  ): void;
  debug(message: string, meta?: Record<string, unknown> | Error | object): void;
}

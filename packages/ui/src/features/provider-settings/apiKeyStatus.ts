import type { ApiKeyEntry, KeyHealth } from '@shared/llm-config';

/**
 * Resolved per-key display status, in priority order:
 * - `cooling`   : key is currently in rate-limit cooldown (live, in-memory)
 * - `authFailed`: key was auto-disabled on a 401/403 (persisted)
 * - `disabled`  : key manually disabled (no auth_failure reason)
 * - `healthy`   : enabled and not cooling down
 */
export type KeyStatus = 'cooling' | 'authFailed' | 'disabled' | 'healthy';

/**
 * Derive the display status for a key.
 *
 * `health` is the live cooldown entry for this key (or undefined when the key
 * is not in the cooldown map). `now` is the current epoch-ms (passed in so the
 * caller's 1s tick drives re-evaluation as a cooldown expires).
 */
export function resolveKeyStatus(
  entry: ApiKeyEntry,
  health: KeyHealth | undefined,
  now: number
): KeyStatus {
  if (health && health.until > now) {
    return 'cooling';
  }
  if (!entry.enabled && entry.disabledReason === 'auth_failure') {
    return 'authFailed';
  }
  if (!entry.enabled) {
    return 'disabled';
  }
  return 'healthy';
}

/** Format remaining ms as `m:ss` (or `mm:ss`). Clamps negatives to `0:00`. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** i18n key (under providerSettings.apiKeyPool) for a relative-time unit. */
export type RelativeUnitKey = 'agoSeconds' | 'agoMinutes' | 'agoHours' | 'agoDays';

export interface RelativeParts {
  unitKey: RelativeUnitKey;
  value: number;
}

/** Decompose an elapsed duration into a coarse relative-time unit + value. */
export function resolveRelativeParts(fromMs: number, now: number): RelativeParts {
  const elapsed = Math.max(0, now - fromMs);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) {
    return { unitKey: 'agoSeconds', value: seconds };
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return { unitKey: 'agoMinutes', value: minutes };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return { unitKey: 'agoHours', value: hours };
  }
  return { unitKey: 'agoDays', value: Math.floor(hours / 24) };
}

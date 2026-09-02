/**
 * Round-robin selection across a provider's comma-separated API keys.
 *
 * Ported from Elftia's `ApiKeyRotator`
 * (`capabilities/search/ApiKeyRotator.ts`, sha256 `9c649cba…`, re-verified
 * byte-identical against the 阶段0 manifest before porting). Behavior is
 * unchanged:
 *
 * - a single key is returned as-is, with no rotation;
 * - empty or whitespace-only input returns `''`, and the ADAPTER raises the
 *   `config_missing` failure — the rotator never decides whether a provider is
 *   configured;
 * - multiple keys advance one step per call, wrapping defensively in case the
 *   configured list shrank between calls.
 *
 * One instance per provider instance, as in Elftia. The index is in-memory and
 * resets with the process, which matches how the keys themselves are re-read
 * from configuration at startup.
 *
 * @module search/api/rotator
 */

export class ApiKeyRotator {
  private index = 0;

  /**
   * Pick the next key from a comma-separated list, advancing the counter.
   *
   * Returns `''` when nothing is configured — never `undefined`, so callers
   * have one falsy case to test rather than two.
   */
  pick(rawKeyString: string | undefined): string {
    const keys = splitKeys(rawKeyString);
    if (keys.length === 0) return '';
    if (keys.length === 1) return keys[0];

    if (this.index >= keys.length) this.index = 0;
    const selected = keys[this.index];
    this.index = (this.index + 1) % keys.length;
    return selected;
  }

  /** Reset the rotation counter, e.g. after a configuration update. */
  reset(): void {
    this.index = 0;
  }

  /** How many usable keys the string holds. */
  countKeys(rawKeyString: string | undefined): number {
    return splitKeys(rawKeyString).length;
  }

  /**
   * Every configured key.
   *
   * Not in the Elftia original: redaction has to strip EVERY key a provider
   * could have sent, not just the one this request rotated onto, or a key
   * echoed by an upstream error survives whenever the counter has moved on.
   */
  allKeys(rawKeyString: string | undefined): string[] {
    return splitKeys(rawKeyString);
  }
}

function splitKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

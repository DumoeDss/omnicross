/**
 * ApiKeyPoolService - Multi-API-key load balancing with session affinity
 *
 * Manages a pool of API keys per provider, selecting keys via weighted
 * round-robin and maintaining provider+session key affinity to preserve
 * prompt cache when a conversation switches providers and returns.
 */

import type { ApiKeyEntry } from '@omnicross/contracts/llm-config';

import type { Logger } from '../ports/logger';

/** Cooldown state for a key */
interface KeyCooldown {
  /** Timestamp when cooldown expires */
  until: number;
  /** Number of consecutive errors */
  errors: number;
  /** HTTP status that triggered the most recent cooldown (429/529) */
  lastStatus: number;
}

/** Live health snapshot for a single key currently in cooldown. */
export interface KeyHealthEntry {
  /** Epoch-ms when the cooldown expires */
  until: number;
  /** Number of consecutive errors */
  errors: number;
  /** HTTP status that triggered the most recent cooldown */
  lastStatus: number | null;
}

/** Provider-scoped map of keyId → live cooldown health (cooling keys only). */
export type KeyHealthMap = Record<string, KeyHealthEntry>;

export type ProviderKeyPoolAvailability =
  | { readonly outcome: 'usable' }
  | { readonly outcome: 'empty' | 'unavailable' }
  | { readonly outcome: 'exhausted'; readonly retryAfterSeconds: number };

/** Function type for loading API keys from the database */
export type ApiKeysLoader = (providerId: string) => Promise<ApiKeyEntry[]>;

/** Function type for disabling a key in the database (on auth failure) */
export type ApiKeyDisabler = (keyId: string) => Promise<boolean>;

/**
 * Function type for auto-disabling a key in the database on auth failure,
 * persisting the offending status + timestamp so the client UI can surface
 * a per-key health indicator. Preferred over {@link ApiKeyDisabler} when set.
 */
export type ApiKeyAutoDisabler = (
  keyId: string,
  status: number,
  at: number,
) => Promise<void>;

/** Function type for resolving environment variable references in API keys */
export type ApiKeyResolver = (rawKey: string) => string;

/** HTTP status codes that indicate a permanently invalid key */
const AUTH_FAILURE_CODES = new Set([401, 403]);

/** HTTP status codes that indicate transient rate limiting */
const RATE_LIMIT_CODES = new Set([429, 529]);

export class ApiKeyPoolService {
  /** Session -> provider -> key ID; switching providers preserves prior bindings. */
  private sessionBindings = new Map<string, Map<string, string>>();

  /** Provider 鈫?round-robin index */
  private rrIndex = new Map<string, number>();

  /** Provider 鈫?cached key list */
  private keyCache = new Map<string, ApiKeyEntry[]>();

  /** Provider -> key ID -> cooldown state. */
  private cooldowns = new Map<string, Map<string, KeyCooldown>>();

  /** Cleanup interval handle */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Cooldown configuration
  private readonly DEFAULT_COOLDOWN_MS = 60_000; // 60 seconds
  private readonly MAX_COOLDOWN_MS = 15 * 60_000; // 15 minutes
  private readonly COOLDOWN_MULTIPLIER = 2;

  constructor(
    private loadKeys: ApiKeysLoader,
    private resolveKey: ApiKeyResolver,
    private logger: Logger,
    private disableKey?: ApiKeyDisabler,
    private markAutoDisabled?: ApiKeyAutoDisabler,
  ) {
    // Start periodic cleanup of expired cooldowns (every 30s)
    this.cleanupTimer = setInterval(() => this.cleanupExpiredCooldowns(), 30_000);
  }

  /**
   * Read which key id is currently bound to this provider+session pair.
   * Returns null when this pair has not yet been bound.
   *
   * Used by the usage-recorder attribution path: after `getKeyForSession`
   * completes the caller looks up the keyId so the recorded usage
   * row can attribute spend to a specific pool key.
   */
  getKeyIdForSession(providerId: string, sessionId: string): string | null {
    return this.sessionBindings.get(sessionId)?.get(providerId) ?? null;
  }

  /**
   * Bind each provider+session pair on first use via weighted round-robin.
   * Later requests reuse its key, even after calls to other providers.
   * Returns an empty string if no keys are available.
   */
  async getKeyForSession(providerId: string, sessionId: string): Promise<string> {
    const keys = await this.getAvailableKeys(providerId);
    // Read after loading keys so concurrent first requests reuse the first binding.
    const keyId = this.getKeyIdForSession(providerId, sessionId);
    if (keyId) {
      const boundKey = keys.find(k => k.id === keyId);
      if (boundKey) {
        return this.resolveKey(boundKey.apiKey);
      }
      // Key was disabled/deleted/in cooldown — re-bind below
      this.logger.info('Session key no longer available, re-binding', {
        sessionId,
        keyId,
        providerId,
      });
    }

    // Select key via weighted round-robin
    if (keys.length === 0) return '';

    const selected = this.selectWeightedRoundRobin(providerId, keys);
    this.bindSession(providerId, sessionId, selected.id);

    this.logger.debug('Session bound to API key', {
      sessionId,
      keyId: selected.id,
      label: selected.label,
      providerId,
    });

    return this.resolveKey(selected.apiKey);
  }

  /**
   * Bind a session to one explicit provider key. Returns an empty string when
   * the key is unknown, disabled, or cooling so the caller can apply its strict
   * versus pool fallback policy without exposing key material.
   */
  async getKeyById(providerId: string, keyId: string, sessionId?: string | null): Promise<string> {
    const keys = await this.getAvailableKeys(providerId);
    const selected = keys.find((key) => key.id === keyId);
    if (!selected) return '';
    if (sessionId != null) this.bindSession(providerId, sessionId, selected.id);
    return this.resolveKey(selected.apiKey);
  }

  /**
   * Get a key without session affinity (for one-shot calls like testConnection).
   *
   * @returns Resolved API key string, or empty string if no keys available
   */
  async getKey(providerId: string): Promise<string> {
    const keys = await this.getAvailableKeys(providerId);
    if (keys.length === 0) return '';
    const selected = this.selectWeightedRoundRobin(providerId, keys);
    return this.resolveKey(selected.apiKey);
  }

  /**
   * Report an error for the current session's key.
   *
   * - 429/529 (rate limit / overload): puts key in cooldown with exponential backoff
   * - 401/403 (auth failure): permanently disables the key in the database
   *
   * In both cases, re-binds the session to a different key if available.
   *
   * @param statusCode HTTP status code
   * @returns New resolved API key if re-binding succeeded, null if no keys available
   */
  async reportError(
    providerId: string,
    sessionId: string,
    statusCode: number,
  ): Promise<string | null> {
    const isRateLimit = RATE_LIMIT_CODES.has(statusCode);
    const isAuthFailure = AUTH_FAILURE_CODES.has(statusCode);

    if (!isRateLimit && !isAuthFailure) return null;

    const keyId = this.getKeyIdForSession(providerId, sessionId);
    if (!keyId) return null;

    if (isAuthFailure) {
      // Permanent failure — disable the key in DB so it won't be used again
      await this.handleAuthFailure(keyId, providerId, statusCode);
    } else {
      // Transient failure — cooldown with exponential backoff
      this.applyCooldown(keyId, providerId, statusCode);
    }

    // Try to find another key
    const keys = await this.getAvailableKeys(providerId);
    if (keys.length === 0) {
      this.logger.warn('No available API keys after error', { providerId, statusCode });
      return null;
    }

    const newKey = this.selectWeightedRoundRobin(providerId, keys);
    this.bindSession(providerId, sessionId, newKey.id);

    this.logger.info('Session re-bound to new API key', {
      sessionId,
      newKeyId: newKey.id,
      label: newKey.label,
    });

    return this.resolveKey(newKey.apiKey);
  }

  /**
   * Report success for this provider+session pair, resetting only its key's cooldown.
   */
  reportSuccess(providerId: string, sessionId: string): void {
    const keyId = this.getKeyIdForSession(providerId, sessionId);
    if (!keyId) return;
    const cooldowns = this.cooldowns.get(providerId);
    cooldowns?.delete(keyId);
    if (cooldowns?.size === 0) this.cooldowns.delete(providerId);
  }

  /**
   * Release all provider bindings for a session (call when it ends or is deleted).
   */
  releaseSession(sessionId: string): void {
    this.sessionBindings.delete(sessionId);
  }

  /**
   * Invalidate the key cache. Call after CRUD operations on API keys.
   */
  invalidateCache(providerId?: string): void {
    if (providerId) {
      this.keyCache.delete(providerId);
    } else {
      this.keyCache.clear();
    }
  }

  /**
   * Check if a provider has any keys in the pool.
   */
  async hasKeys(providerId: string): Promise<boolean> {
    const keys = await this.getAllKeys(providerId);
    return keys.length > 0;
  }

  /** Secret-free strict preflight for a named provider key. */
  async hasUsableKey(providerId: string, keyId: string): Promise<boolean> {
    const keys = await this.getAvailableKeys(providerId);
    return keys.some((key) => key.id === keyId);
  }

  /** Secret-free existence/availability split for strict Route Lease targets. */
  async getKeyAvailability(
    providerId: string,
    keyId: string,
  ): Promise<'usable' | 'unavailable' | 'not-found'> {
    const all = await this.getAllKeys(providerId);
    if (!all.some((key) => key.id === keyId)) return 'not-found';
    return (await this.getAvailableKeys(providerId)).some((key) => key.id === keyId)
      ? 'usable'
      : 'unavailable';
  }

  /** Secret-free preflight for at least one enabled, non-cooling pool key. */
  async hasUsableKeys(providerId: string): Promise<boolean> {
    return (await this.getAvailableKeys(providerId)).length > 0;
  }

  /** Preserve pool exhaustion and its earliest safe retry horizon for Route Lease. */
  async getPoolAvailability(providerId: string): Promise<ProviderKeyPoolAvailability> {
    const all = await this.getAllKeys(providerId);
    if (all.length === 0) return { outcome: 'empty' };
    if ((await this.getAvailableKeys(providerId)).length > 0) return { outcome: 'usable' };

    const now = Date.now();
    const coolingUntil = all
      .filter((key) => key.enabled)
      .map((key) => this.cooldowns.get(providerId)?.get(key.id)?.until ?? 0)
      .filter((until) => until > now);
    if (coolingUntil.length > 0) {
      const earliest = Math.min(...coolingUntil);
      return {
        outcome: 'exhausted',
        retryAfterSeconds: Math.max(1, Math.min(3600, Math.ceil((earliest - now) / 1000))),
      };
    }
    return { outcome: 'unavailable' };
  }

  /**
   * Get the live (in-memory) rate-limit cooldown health for a provider's keys.
   *
   * Returns ONLY keys that are currently cooling down (cooldown `until` is in
   * the future). A key absent from the returned map is not cooling. This is a
   * pure read of the in-memory cooldown map — auth-failure auto-disable state
   * is persisted on the key row itself (getApiKeys) and is NOT included here.
   */
  async getKeyHealth(providerId: string): Promise<KeyHealthMap> {
    const keys = await this.getAllKeys(providerId);
    const now = Date.now();
    const health: KeyHealthMap = {};
    for (const key of keys) {
      const cd = this.cooldowns.get(providerId)?.get(key.id);
      if (cd && cd.until > now) {
        health[key.id] = {
          until: cd.until,
          errors: cd.errors,
          lastStatus: cd.lastStatus ?? null,
        };
      }
    }
    return health;
  }

  /**
   * Dispose of the service (stop cleanup timer).
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessionBindings.clear();
    this.keyCache.clear();
    this.rrIndex.clear();
    this.cooldowns.clear();
  }

  // ==========================================================================
  // Private methods
  // ==========================================================================

  private bindSession(providerId: string, sessionId: string, keyId: string): void {
    let bindings = this.sessionBindings.get(sessionId);
    if (!bindings) {
      bindings = new Map();
      this.sessionBindings.set(sessionId, bindings);
    }
    bindings.set(providerId, keyId);
  }

  /**
   * Handle auth failure (401/403): disable the key in DB permanently.
   */
  private async handleAuthFailure(keyId: string, providerId: string, statusCode: number): Promise<void> {
    this.logger.warn('API key auth failure — disabling permanently', {
      keyId,
      providerId,
      statusCode,
    });

    // Prefer the health-aware auto-disabler (persists disabledReason +
    // status + timestamp). Fall back to the plain disabler when not wired.
    if (this.markAutoDisabled) {
      try {
        await this.markAutoDisabled(keyId, statusCode, Date.now());
      } catch (err) {
        this.logger.error('Failed to auto-disable API key in database', err instanceof Error ? err : undefined, { keyId });
      }
    } else if (this.disableKey) {
      try {
        await this.disableKey(keyId);
      } catch (err) {
        this.logger.error('Failed to disable API key in database', err instanceof Error ? err : undefined, { keyId });
      }
    }

    // Invalidate cache so the disabled key won't be returned
    this.keyCache.delete(providerId);
  }

  /**
   * Apply cooldown with exponential backoff for rate-limit errors (429/529).
   */
  private applyCooldown(keyId: string, providerId: string, statusCode: number): void {
    let cooldowns = this.cooldowns.get(providerId);
    if (!cooldowns) {
      cooldowns = new Map();
      this.cooldowns.set(providerId, cooldowns);
    }
    const current = cooldowns.get(keyId);
    const errors = (current?.errors ?? 0) + 1;
    const cooldownMs = Math.min(
      this.DEFAULT_COOLDOWN_MS * Math.pow(this.COOLDOWN_MULTIPLIER, errors - 1),
      this.MAX_COOLDOWN_MS,
    );
    cooldowns.set(keyId, {
      until: Date.now() + cooldownMs,
      errors,
      lastStatus: statusCode,
    });

    this.logger.info('API key put in cooldown', {
      keyId,
      providerId,
      statusCode,
      cooldownMs,
      errors,
    });
  }

  /**
   * Get all keys for a provider (with caching).
   */
  private async getAllKeys(providerId: string): Promise<ApiKeyEntry[]> {
    if (!this.keyCache.has(providerId)) {
      const keys = await this.loadKeys(providerId);
      this.keyCache.set(providerId, keys);
    }
    return this.keyCache.get(providerId)!;
  }

  /**
   * Get available keys: enabled AND not in cooldown.
   */
  private async getAvailableKeys(providerId: string): Promise<ApiKeyEntry[]> {
    const all = await this.getAllKeys(providerId);
    const now = Date.now();
    return all.filter(k => {
      if (!k.enabled) return false;
      const cd = this.cooldowns.get(providerId)?.get(k.id);
      if (cd && cd.until > now) return false;
      return true;
    });
  }

  /**
   * Weighted round-robin selection.
   *
   * Each key's weight determines how many "slots" it occupies in the rotation.
   * The round-robin index advances by 1 on each call per provider.
   */
  private selectWeightedRoundRobin(
    providerId: string,
    keys: ApiKeyEntry[],
  ): ApiKeyEntry {
    if (keys.length === 1) return keys[0];

    const totalWeight = keys.reduce((sum, k) => sum + k.weight, 0);
    const idx = ((this.rrIndex.get(providerId) ?? -1) + 1) % totalWeight;
    this.rrIndex.set(providerId, idx);

    let accum = 0;
    for (const key of keys) {
      accum += key.weight;
      if (idx < accum) {
        return key;
      }
    }

    // Fallback (should not reach here)
    return keys[0];
  }

  /**
   * Clean up expired cooldowns.
   */
  private cleanupExpiredCooldowns(): void {
    const now = Date.now();
    for (const [providerId, cooldowns] of this.cooldowns) {
      for (const [keyId, cd] of cooldowns) {
        if (cd.until <= now) cooldowns.delete(keyId);
      }
      if (cooldowns.size === 0) this.cooldowns.delete(providerId);
    }
  }
}

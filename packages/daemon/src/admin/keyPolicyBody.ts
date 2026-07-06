/**
 * keyPolicyBody — parse + validate the admin key-policy write body
 * (outbound-key-policy). Extracted from `adminApi.ts` (which is at its line cap)
 * so the #4 expiry/activation/cost/rate envelope AND the #6 per-key model
 * restriction share ONE validation site the router merely delegates to.
 *
 * Each field is three-way: OMITTED keeps the stored value, `null` clears, a value
 * sets — mirroring `outboundApiKeysSetMaxConcurrency`. `activatedAt` is NOT
 * accepted here (it is server-stamped on first use only). Anything malformed →
 * a 400-worthy `{ ok:false, message }`.
 *
 * @module @omnicross/daemon/admin/keyPolicyBody
 */

import type { OutboundKeyPolicy } from '@omnicross/core/outbound-api';

/**
 * Parse + validate the key-policy write body. Numeric fields carry per-field
 * bounds (cost/window ≥ 0; rate max ≥ 0 with `0` = unlimited; `activationDays` a
 * positive integer). `activationMode` must be one of the two modes. The #6 model
 * restriction adds `enableModelRestriction` (boolean), `restrictionMode`
 * (blacklist|allowlist), and `restrictedModels` (a string list; entries trimmed,
 * blanks dropped).
 */
export function parseKeyPolicyBody(
  body: Record<string, unknown>,
): { ok: true; policy: OutboundKeyPolicy } | { ok: false; message: string } {
  const policy: OutboundKeyPolicy = {};

  // activationMode enum (three-way).
  if ('activationMode' in body) {
    const m = body['activationMode'];
    if (m === null) policy.activationMode = null;
    else if (m === 'fixed' || m === 'activation') policy.activationMode = m;
    else return { ok: false, message: "activationMode must be 'fixed', 'activation', or null" };
  }

  // Numeric-nullable fields with per-field bounds.
  const numericFields: Array<{
    key: keyof OutboundKeyPolicy & string;
    min: number;
    integer?: boolean;
  }> = [
    { key: 'expiresAt', min: 0 },
    { key: 'activationDays', min: 1, integer: true },
    { key: 'dailyCostLimitUsd', min: 0 },
    { key: 'totalCostLimitUsd', min: 0 },
    { key: 'weeklyCostLimitUsd', min: 0 },
    { key: 'rateLimitMaxRequests', min: 0, integer: true },
    { key: 'rateLimitWindowMs', min: 1 },
  ];
  for (const { key, min, integer } of numericFields) {
    if (!(key in body)) continue;
    const v = body[key];
    if (v === null) {
      (policy as Record<string, number | null>)[key] = null;
      continue;
    }
    if (
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      v < min ||
      (integer && !Number.isInteger(v))
    ) {
      return {
        ok: false,
        message: `${key} must be ${integer ? 'an integer' : 'a number'} >= ${min} or null`,
      };
    }
    (policy as Record<string, number | null>)[key] = v;
  }

  // Per-key model restriction (#6) — three-way each.
  if ('enableModelRestriction' in body) {
    const v = body['enableModelRestriction'];
    if (v === null) policy.enableModelRestriction = null;
    else if (typeof v === 'boolean') policy.enableModelRestriction = v;
    else return { ok: false, message: 'enableModelRestriction must be a boolean or null' };
  }
  if ('restrictionMode' in body) {
    const v = body['restrictionMode'];
    if (v === null) policy.restrictionMode = null;
    else if (v === 'blacklist' || v === 'allowlist') policy.restrictionMode = v;
    else return { ok: false, message: "restrictionMode must be 'blacklist', 'allowlist', or null" };
  }
  if ('restrictedModels' in body) {
    const v = body['restrictedModels'];
    if (v === null) {
      policy.restrictedModels = null;
    } else if (Array.isArray(v) && v.every((e) => typeof e === 'string')) {
      // Normalize: trim entries and drop blanks (an empty allowlist is a valid,
      // deliberate "deny all" state, so an empty array is accepted).
      policy.restrictedModels = (v as string[]).map((e) => e.trim()).filter((e) => e !== '');
    } else {
      return { ok: false, message: 'restrictedModels must be an array of strings or null' };
    }
  }

  return { ok: true, policy };
}

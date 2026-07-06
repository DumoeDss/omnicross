/**
 * billingConfigBody — pure admin-side helpers for the `billing` server-config
 * segment (billing-event-stream, design D6/D7). Kept OUT of `adminApi.ts` (at its
 * line cap) — the #4/#5/#8/#10/#13 helper-module convention: `handleServer` calls
 * these with a couple of lines each.
 *
 * Three concerns, all secret-safe:
 *  - {@link validateBillingSegment} — strict validation of a PUT's `billing`
 *    segment (reject a malformed value with a 400 rather than silently clamping
 *    it in core's lenient normalize).
 *  - {@link redactBillingConfig} — mask the HMAC `secret` for the GET view (a
 *    masked sentinel signals presence; the plaintext never leaves).
 *  - {@link preserveBillingSecret} — write-only secret preservation: a PUT that
 *    edits OTHER fields (sending back the masked/blank secret) keeps the stored
 *    secret instead of wiping it.
 *
 * @module @omnicross/daemon/admin/billingConfigBody
 */

import type { BillingConfig } from '@omnicross/contracts/billing-types';
import type { OutboundApiServerConfig } from '@omnicross/core';

/** The masked value the GET view returns for a present secret (presence signal). */
export const BILLING_SECRET_MASK = '••••••';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate a PUT's `billing` segment (present-only). Returns an array of error
 * strings (empty ⇒ valid). Mirrors `validateAuditSegment`: a malformed PRESENT
 * segment is a 400; absent is not validated (partial PUT).
 */
export function validateBillingSegment(patch: Partial<OutboundApiServerConfig>): string[] {
  const errors: string[] = [];
  const billing: unknown = patch.billing;
  if (billing === undefined) return errors;
  if (!isPlainObject(billing)) {
    errors.push('billing must be an object');
    return errors;
  }
  if (billing['enabled'] !== undefined && typeof billing['enabled'] !== 'boolean') {
    errors.push('billing.enabled must be a boolean');
  }
  if (billing['endpoint'] !== undefined && typeof billing['endpoint'] !== 'string') {
    errors.push('billing.endpoint must be a string');
  }
  if (billing['secret'] !== undefined && typeof billing['secret'] !== 'string') {
    errors.push('billing.secret must be a string');
  }
  const maxRetryAgeMs = billing['maxRetryAgeMs'];
  if (
    maxRetryAgeMs !== undefined &&
    (typeof maxRetryAgeMs !== 'number' || !Number.isFinite(maxRetryAgeMs) || maxRetryAgeMs < 0)
  ) {
    errors.push('billing.maxRetryAgeMs must be a non-negative number');
  }
  return errors;
}

/**
 * Redact the billing HMAC secret for the GET view: a present secret becomes the
 * masked sentinel (presence signal), an absent one stays absent. The plaintext
 * secret NEVER leaves the daemon.
 */
export function redactBillingConfig(billing: BillingConfig): BillingConfig {
  if (typeof billing.secret === 'string' && billing.secret.length > 0) {
    return { ...billing, secret: BILLING_SECRET_MASK };
  }
  return billing;
}

/**
 * Write-only secret preservation: the GET masks the secret, so a PUT that edits
 * OTHER fields sends it back with the MASK (or a blank/absent secret). When the
 * incoming secret is the mask/blank AND the current config had a secret, carry the
 * stored secret forward — so editing endpoint/enabled never wipes it. A genuinely
 * new secret (anything other than the mask/blank) replaces it.
 */
export function preserveBillingSecret(
  incoming: BillingConfig,
  current: BillingConfig | undefined,
): BillingConfig {
  const isMaskedOrBlank =
    incoming.secret === undefined || incoming.secret === '' || incoming.secret === BILLING_SECRET_MASK;
  if (isMaskedOrBlank) {
    if (current?.secret) return { ...incoming, secret: current.secret };
    // No stored secret → drop the mask sentinel so it isn't persisted as a real value.
    const { secret: _secret, ...rest } = incoming;
    return rest;
  }
  return incoming;
}

/**
 * auditConfigBody — pure admin-side validation for the `audit` server-config
 * segment (request-audit-log, design D2). Kept OUT of `adminApi.ts` (at its line
 * cap) — the #4/#8/#10 helper-module convention: `handleServer` calls this with
 * one line.
 *
 * The audit segment carries NO secret (unlike webhook), so there is no
 * redact/preserve concern — only strict validation so a malformed PUT is a 400
 * rather than silently clamped by core's lenient normalize.
 *
 * @module @omnicross/daemon/admin/auditConfigBody
 */

import type { OutboundApiServerConfig } from '@omnicross/core';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate a PUT's `audit` segment (present-only). Returns an array of error
 * strings (empty ⇒ valid). Mirrors `validateWebhookSegment`: a malformed PRESENT
 * segment is a 400; absent is not validated (partial PUT).
 */
export function validateAuditSegment(patch: Partial<OutboundApiServerConfig>): string[] {
  const errors: string[] = [];
  const audit: unknown = patch.audit;
  if (audit === undefined) return errors;
  if (!isPlainObject(audit)) {
    errors.push('audit must be an object');
    return errors;
  }
  for (const flag of ['enabled', 'captureBodies', 'trustForwardedFor'] as const) {
    if (audit[flag] !== undefined && typeof audit[flag] !== 'boolean') {
      errors.push(`audit.${flag} must be a boolean`);
    }
  }
  const maxBodyBytes = audit['maxBodyBytes'];
  if (
    maxBodyBytes !== undefined &&
    (typeof maxBodyBytes !== 'number' || !Number.isFinite(maxBodyBytes) || maxBodyBytes < 0)
  ) {
    errors.push('audit.maxBodyBytes must be a non-negative number');
  }
  const retentionDays = audit['retentionDays'];
  if (
    retentionDays !== undefined &&
    (typeof retentionDays !== 'number' || !Number.isFinite(retentionDays) || retentionDays < 0)
  ) {
    errors.push('audit.retentionDays must be a non-negative number');
  }
  return errors;
}

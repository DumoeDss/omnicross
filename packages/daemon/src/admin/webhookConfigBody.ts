/**
 * webhookConfigBody — pure admin-side helpers for the `webhook` server-config
 * segment (webhook-notifications, design D5/D7). Kept OUT of `adminApi.ts` (at
 * its line cap) — the #4/#8/#10 helper-module convention: `handleServer` calls
 * these with a couple of lines each.
 *
 * Three concerns, all secret-safe:
 *  - {@link validateWebhookSegment} — strict validation of a PUT's `webhook`
 *    segment (reject a malformed value with a 400 rather than silently dropping
 *    it in core's lenient normalize).
 *  - {@link redactWebhookConfig} — mask each destination's `secret` for the GET
 *    view (a masked sentinel signals presence; the plaintext never leaves).
 *  - {@link preserveWebhookSecrets} — write-only secret preservation: a PUT that
 *    edits a destination's OTHER fields (sending back the masked/blank secret)
 *    keeps the stored secret instead of wiping it.
 *
 * @module @omnicross/daemon/admin/webhookConfigBody
 */

import {
  WEBHOOK_DESTINATION_TYPES,
  WEBHOOK_EVENT_KINDS,
  type WebhookConfig,
  type WebhookDestination,
} from '@omnicross/contracts/webhook-types';
import type { OutboundApiServerConfig } from '@omnicross/core';

/** The masked value the GET view returns for a present secret (presence signal). */
export const WEBHOOK_SECRET_MASK = '••••••';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate a PUT's `webhook` segment (present-only). Returns an array of error
 * strings (empty ⇒ valid). Mirrors `validateQueueSegments`: a malformed PRESENT
 * segment is a 400, absent is not validated (partial PUT).
 */
export function validateWebhookSegment(patch: Partial<OutboundApiServerConfig>): string[] {
  const errors: string[] = [];
  const webhook: unknown = patch.webhook;
  if (webhook === undefined) return errors;
  if (!isPlainObject(webhook)) {
    errors.push('webhook must be an object');
    return errors;
  }
  if (typeof webhook['enabled'] !== 'boolean') {
    errors.push('webhook.enabled must be a boolean');
  }
  const destinations = webhook['destinations'];
  if (destinations !== undefined && !Array.isArray(destinations)) {
    errors.push('webhook.destinations must be an array');
    return errors;
  }
  const seenIds = new Set<string>();
  for (const [i, raw] of (Array.isArray(destinations) ? destinations : []).entries()) {
    if (!isPlainObject(raw)) {
      errors.push(`webhook.destinations[${i}] must be an object`);
      continue;
    }
    const id = raw['id'];
    if (typeof id !== 'string' || !id.trim()) {
      errors.push(`webhook.destinations[${i}].id must be a non-empty string`);
    } else if (seenIds.has(id.trim())) {
      errors.push(`webhook.destinations[${i}].id '${id.trim()}' is duplicated`);
    } else {
      seenIds.add(id.trim());
    }
    if (typeof raw['type'] !== 'string' || !WEBHOOK_DESTINATION_TYPES.includes(raw['type'] as never)) {
      errors.push(`webhook.destinations[${i}].type must be one of ${WEBHOOK_DESTINATION_TYPES.join(', ')}`);
    }
    if (typeof raw['url'] !== 'string' || !raw['url'].trim()) {
      errors.push(`webhook.destinations[${i}].url must be a non-empty string`);
    }
    if (raw['secret'] !== undefined && typeof raw['secret'] !== 'string') {
      errors.push(`webhook.destinations[${i}].secret must be a string`);
    }
    if (raw['enabled'] !== undefined && typeof raw['enabled'] !== 'boolean') {
      errors.push(`webhook.destinations[${i}].enabled must be a boolean`);
    }
    const events = raw['events'];
    if (events !== undefined) {
      if (!Array.isArray(events)) {
        errors.push(`webhook.destinations[${i}].events must be an array`);
      } else {
        for (const e of events) {
          if (typeof e !== 'string' || !WEBHOOK_EVENT_KINDS.includes(e as never)) {
            errors.push(`webhook.destinations[${i}].events contains an unknown kind '${String(e)}'`);
          }
        }
      }
    }
  }
  return errors;
}

/**
 * Redact webhook destination secrets for the GET view: a present secret becomes
 * the masked sentinel (presence signal), an absent one stays absent. The
 * plaintext secret NEVER leaves the daemon.
 */
export function redactWebhookConfig(webhook: WebhookConfig): WebhookConfig {
  return {
    ...webhook,
    destinations: webhook.destinations.map((d) =>
      typeof d.secret === 'string' && d.secret.length > 0
        ? { ...d, secret: WEBHOOK_SECRET_MASK }
        : d,
    ),
  };
}

/**
 * Write-only secret preservation: the GET masks each destination's secret, so a
 * PUT that edits OTHER fields sends the destination back with the MASK (or a
 * blank/absent secret). When the incoming secret is the mask/blank AND the
 * current config had a secret for the SAME destination id, carry the stored
 * secret forward — so editing url/events never wipes it. A genuinely new secret
 * (anything other than the mask/blank) replaces it.
 */
export function preserveWebhookSecrets(
  incoming: WebhookConfig,
  current: WebhookConfig | undefined,
): WebhookConfig {
  const currentById = new Map<string, WebhookDestination>();
  for (const d of current?.destinations ?? []) currentById.set(d.id, d);
  return {
    ...incoming,
    destinations: incoming.destinations.map((d) => {
      const isMaskedOrBlank = d.secret === undefined || d.secret === '' || d.secret === WEBHOOK_SECRET_MASK;
      if (isMaskedOrBlank) {
        const prev = currentById.get(d.id);
        if (prev?.secret) return { ...d, secret: prev.secret };
        // No stored secret → drop the mask sentinel so it isn't persisted as a real value.
        const { secret: _secret, ...rest } = d;
        return rest;
      }
      return d;
    }),
  };
}

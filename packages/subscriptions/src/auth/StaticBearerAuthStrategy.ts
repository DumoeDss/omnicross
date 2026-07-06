/**
 * StaticBearerAuthStrategy — OpenCodeGo subscription path.
 *
 * Reads the static API key from the credential store's `getValidOpenCodeGoApiKey`,
 * applies `Authorization: Bearer <key>` (plus `x-api-key` fallback when the
 * upstream is the Anthropic-shape `/v1/messages` endpoint), and never
 * triggers a refresh — OpenCodeGo issues opaque keys and rotation is a
 * user-driven re-entry of the key.
 */

import type { SubscriptionStatusEntry } from '@omnicross/contracts/subscription-types';

import type { SubscriptionCredentialStore } from '../ports/credential-store';
import { resolveSelectedToken } from '../scheduler/accountSelection';
import type { SubscriptionAccountSelector } from '../scheduler/SubscriptionAccountSelector';

import type { AuthApplyHints, AuthStrategy } from './AuthStrategy';

/** URL fragment that identifies an Anthropic-shape OpenCodeGo upstream. */
const ANTHROPIC_SHAPE_PATH = '/v1/messages';

export class StaticBearerAuthStrategy implements AuthStrategy {
  readonly kind = 'static-bearer' as const;
  readonly providerId = 'opencodego' as const;

  constructor(
    private readonly tokens: SubscriptionCredentialStore,
    /** Shared account-pool scheduler (subscription-account-scheduling). Absent ⇒
     *  the pre-change single-account active-mirror behavior. */
    private readonly selector?: SubscriptionAccountSelector,
  ) {}

  async applyHeaders(headers: Record<string, string>, hints?: AuthApplyHints): Promise<void> {
    // Account pool: a non-active pick uses that account's static key by id;
    // otherwise the active `getValidOpenCodeGoApiKey()` path runs verbatim.
    const key = await resolveSelectedToken(this.selector, this.tokens, 'opencodego', hints?.sessionKey, () =>
      this.tokens.getValidOpenCodeGoApiKey(),
    );
    if (!key) {
      // Let the upstream surface the 401 with its own body — clearer than
      // synthesizing an error here.
      return;
    }
    headers['Authorization'] = `Bearer ${key}`;

    // Anthropic-shape upstreams (MiniMax) historically accept x-api-key too
    // — mirrors `_others/oc-go-cc/internal/client/opencode.go`.
    if (hints?.upstreamUrl?.includes(ANTHROPIC_SHAPE_PATH)) {
      headers['x-api-key'] = key;
    }
  }

  async onUnauthorized(_sessionKey?: string): Promise<boolean> {
    // Static keys have no refresh affordance; the user must re-enter the key —
    // whichever pooled account served it, the 401 surfaces unchanged.
    return false;
  }

  async describeStatus(): Promise<SubscriptionStatusEntry> {
    const config = await this.tokens.getFullConfig();
    const oc = config.opencodego;
    if (!oc?.apiKey) {
      return { providerId: 'opencodego', ok: false, reason: 'missing-credential' };
    }
    if (oc.status === 'error') {
      return { providerId: 'opencodego', ok: false, reason: 'unknown' };
    }
    return { providerId: 'opencodego', ok: true };
  }
}

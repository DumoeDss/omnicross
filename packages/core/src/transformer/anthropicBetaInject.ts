/**
 * Anthropic 1M-context (`context-1m-2025-08-07`) beta-flag injector.
 *
 * The Claude Agent SDK source has 0 occurrences of `context-1m` — it does
 * NOT auto-inject the beta header. The host must inject it itself on every
 * outbound Anthropic-bound request when the active session opted into the
 * 1M-context tier. This single helper is wired at three exits:
 *
 *  - the `isOfficialProvider` direct branch
 *    (native + 3rd-party anthropic-format API-key paths)
 *  - the claude-code OAuth pass-through path
 *  - `TransformerChainExecutor.executeRequestChain` exit (transformer pipeline
 *    targeting an Anthropic-shaped upstream)
 *
 * **Layer note:** this is generic Anthropic header logic, so it lives in the
 * serving core (`transformer/`). Consumers import it DOWN from here.
 *
 * **Header path, not body**: the `/v1/messages` endpoint rejects an
 * `anthropic_beta` body field with `"Extra inputs are not permitted"`. The
 * canonical mechanism is the `anthropic-beta` HTTP header carrying a
 * comma-separated list of beta flags. The SDK may already attach its own
 * `anthropic-beta` header (e.g. for prompt caching betas it uses), so this
 * helper appends-or-merges instead of replacing.
 *
 * @module transformer/anthropicBetaInject
 */
import { isExtendedContextCapable } from '@omnicross/contracts/extended-context';

export const EXTENDED_CONTEXT_BETA = 'context-1m-2025-08-07';

const ANTHROPIC_BETA_HEADER = 'anthropic-beta';

/**
 * Idempotently merge the 1M-context beta flag into an Anthropic request's
 * `anthropic-beta` HTTP header (comma-separated list).
 *
 * Mutates `headers` in place. No-op when:
 *  - `useExtendedContext` is false (user has not opted in), OR
 *  - `model` is not in the 1M-capable allowlist (defensive — guards against
 *    stale flag set on a model whose 1M variant isn't supported), OR
 *  - the flag already appears in the existing header value (re-entry safe).
 *
 * Header-name lookup is case-insensitive: HTTP headers are conventionally
 * stored in different casings by different code paths (Node IncomingMessage
 * lowercases; some libraries preserve `Anthropic-Beta`). The helper deletes
 * any case-variant key it finds and re-emits the canonical lowercase
 * `anthropic-beta`.
 */
export function injectExtendedContextBeta(
  headers: Record<string, string>,
  model: string,
  useExtendedContext: boolean,
): void {
  if (!useExtendedContext) return;
  if (!isExtendedContextCapable(model)) return;

  // Find the existing header (any case) and absorb its value before
  // re-emitting under the canonical lowercase key.
  let existingValue = '';
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === ANTHROPIC_BETA_HEADER) {
      const v = headers[key];
      if (typeof v === 'string') existingValue = v;
      // Intentional: drop the case-variant key so only the canonical lowercase
      // `anthropic-beta` remains. Header keys are plain strings, not sensitive
      // computed accessors.
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      if (key !== ANTHROPIC_BETA_HEADER) delete headers[key];
    }
  }

  const parts = existingValue
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!parts.includes(EXTENDED_CONTEXT_BETA)) {
    parts.push(EXTENDED_CONTEXT_BETA);
  }
  headers[ANTHROPIC_BETA_HEADER] = parts.join(',');
}

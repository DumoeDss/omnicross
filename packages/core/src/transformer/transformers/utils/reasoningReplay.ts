/**
 * Reasoning replay for chat wires that demand `reasoning_content` passback.
 *
 * DeepSeek v4 (deepseek-flash / v4-flash / v4-pro, observed 2026-10-19..22)
 * rejects a request that engages thinking mode with
 *
 *   400 "The `reasoning_content` in the thinking mode must be passed back
 *        to the API."
 *
 * unless every thinking-turn assistant message in the input carries its
 * `reasoning_content`. Codex records the reasoning we stream as the `summary`
 * of a `reasoning` input item and replays that item on the next turn, so the
 * text IS available at the client — the reduced decode used to skip `reasoning`
 * input items entirely, so the replay never reached the upstream and every
 * follow-up turn of a thinking conversation died (85 rejections over three
 * days of parallel-agent traffic while first turns kept succeeding).
 *
 * Three pieces share this module:
 *  - {@link isReasoningReplayProvider} — static classification (DeepSeek
 *    identity + a v4-era model), used by the chat encoder so KNOWN providers
 *    replay proactively and never pay the failed round trip.
 *  - {@link isReasoningReplayRejection} + the learned-key registry — the
 *    Responses driver marks a provider after one observed rejection so
 *    unclassified upstreams self-heal on the NEXT request. (The reasoning text
 *    lives on the ingress transformer context and is out of fetchFn's reach,
 *    so an immediate retry is not possible the way the json_schema fallback
 *    retries; the next turn injects.)
 *  - {@link isReasoningContentForbidden} — the mirror image: an upstream that
 *    rejects `reasoning_content` in INPUT (classic deepseek-reasoner "not
 *    allowed in input messages"). The driver strips the field and retries
 *    once, so a mis-classified provider still completes its turn.
 *
 * @module transformer/transformers/utils/reasoningReplay
 */

import {
  resolveTargetModelCapabilities,
  type ReasoningProvider,
} from '../../reasoning-effort';

type JsonRecord = Record<string, unknown>;

export interface ReasoningReplayEntry {
  /** Index of the assistant message in the unified `messages` array. */
  messageIndex: number;
  /** Concatenated `summary_text` parts of the client's `reasoning` item. */
  text: string;
}

/** Provider shape both the encoder and the driver can supply. */
export interface ReasoningReplayProvider extends ReasoningProvider {
  name?: string;
  baseUrl?: string;
}

function readsDeepSeek(provider: ReasoningReplayProvider | undefined): boolean {
  if (!provider) return false;
  return /deepseek/i.test(provider.name ?? '') || /deepseek/i.test(provider.baseUrl ?? '');
}

/**
 * Providers whose chat wire requires thinking-turn assistant messages back
 * WITH `reasoning_content`.
 *
 * Identity is provider-level (name/base URL reads DeepSeek), but the model
 * must ALSO be v4-era: the same endpoint still serves deepseek-reasoner
 * (R1), which is the opposite regime — it FORBIDS `reasoning_content` in
 * input. The catalog draws that line for us: the v4 family declares discrete
 * `thinkingLevels` while R1/v3 do not, so the capability check keeps legacy
 * models out of the replay.
 */
export function isReasoningReplayProvider(
  provider: ReasoningReplayProvider | undefined,
  model: string,
): boolean {
  if (!readsDeepSeek(provider)) return false;
  const levels = resolveTargetModelCapabilities(model, provider).thinkingLevels;
  return Array.isArray(levels) && levels.length > 0;
}

/**
 * Whether an upstream status+body is the thinking-mode replay demand
 * specifically. Deliberately narrow: it must name `reasoning_content` AND ask
 * for it back, so unrelated invalid_request_errors never arm the replay.
 */
export function isReasoningReplayRejection(status: number, errorText: string): boolean {
  if (status !== 400 || typeof errorText !== 'string' || !errorText) return false;
  if (!/reasoning[_ ]?content/i.test(errorText)) return false;
  return /pass(ed)?\s*back|pass\s+it\s+back|must\s+be\s+(passed\s+back|required)/i.test(errorText);
}

/**
 * The mirror rejection: `reasoning_content` present in INPUT is refused
 * (classic deepseek-reasoner behavior). Names the field and refuses it.
 * Deliberately excludes bare "invalid" — the passback DEMAND above rides an
 * `invalid_request_error` envelope, and a demand must never trigger a strip.
 */
export function isReasoningContentForbidden(status: number, errorText: string): boolean {
  if (status !== 400 || typeof errorText !== 'string' || !errorText) return false;
  if (!/reasoning[_ ]?content/i.test(errorText)) return false;
  return /not\s+(be\s+)?(allowed|supported|accepted)|forbidden|unsupported/i.test(errorText);
}

/**
 * Registry key shared by the encoder (LLMProvider in hand) and the driver
 * (plan.transformerProvider in hand — the same object the chain sees).
 */
export function reasoningReplayKey(
  provider: ReasoningReplayProvider | undefined,
): string {
  return `${(provider?.name ?? '').toLowerCase()}|${provider?.baseUrl ?? ''}`;
}

/**
 * Provider identities already observed demanding the replay. Process-local on
 * purpose: it is a routing optimization, not persistence — a daemon restart
 * pays one failed round trip again (known providers are covered statically).
 */
const learnedKeys = new Set<string>();

export function markReasoningReplayRequired(key: string): void {
  if (key) learnedKeys.add(key);
}

export function isReasoningReplayLearned(key: string): boolean {
  return learnedKeys.has(key);
}

/** TEST SEAM — clear the learned registry between suites. */
export function resetReasoningReplayStateForTests(): void {
  learnedKeys.clear();
}

/**
 * Whether the egress should replay reasoning for this provider+model right
 * now: statically classified, or learned from a prior rejection.
 */
export function shouldReplayReasoning(
  provider: ReasoningReplayProvider | undefined,
  model: string,
): boolean {
  const key = reasoningReplayKey(provider);
  return isReasoningReplayProvider(provider, model) || isReasoningReplayLearned(key);
}

/** Attach the replayed reasoning to a finished chat wire body. */
export function applyReasoningReplay(
  wireBody: JsonRecord,
  replay: readonly ReasoningReplayEntry[],
): void {
  const messages = wireBody.messages;
  if (!Array.isArray(messages) || replay.length === 0) return;
  for (const entry of replay) {
    const target = messages[entry.messageIndex] as JsonRecord | undefined;
    if (
      target &&
      target.role === 'assistant' &&
      typeof entry.text === 'string' &&
      entry.text.length > 0
    ) {
      target.reasoning_content = entry.text;
    }
  }
}

/** Remove every replayed `reasoning_content` from a chat wire body. */
export function stripReasoningReplay(wireBody: JsonRecord): boolean {
  const messages = wireBody.messages;
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const message of messages) {
    if (message && typeof message === 'object' && 'reasoning_content' in message) {
      delete (message as JsonRecord).reasoning_content;
      changed = true;
    }
  }
  return changed;
}

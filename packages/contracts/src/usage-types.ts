/**
 * Usage statistics types — LLM request token/cost accounting contracts.
 *
 * Provider-neutral; no host/storage coupling. The serving core attributes each
 * captured request with an engine origin + token counts; hosts own their own
 * persistence rows and aggregation views on top of these shapes.
 *
 * @module usage-types
 */

/**
 * Which engine path produced the request. Used for filtering and to
 * disambiguate duplicate captures from cooperating layers.
 */
export type UsageEngineOrigin =
  /** CompletionService transformer / direct API path. */
  | 'completion'
  /** Claude Agent SDK engine when the host's agent proxy ran the request through the transformer chain. */
  | 'claude-sdk'
  /** Claude Agent SDK engine + official Anthropic provider — proxy bypassed the transformer chain. */
  | 'claude-sdk-direct'
  /** Codex CLI run as a model client through the Responses-API ingress. */
  | 'codex-ingress'
  /** Additional engine origins defined by the embedding host's own engines. */
  | (string & {});

/**
 * Token counts captured from a single LLM response. Names match the union of
 * Anthropic and OpenAI/Gemini terminology — fields default to 0 when the
 * provider does not report them.
 */
export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic prompt-cache hit (charged at the cache_read rate). */
  cacheReadTokens: number;
  /** Anthropic prompt-cache write (charged at the cache_write rate). */
  cacheCreationTokens: number;
  /** OpenAI o1 / Anthropic extended-thinking — already counted into outputTokens by some providers. */
  reasoningTokens: number;
}

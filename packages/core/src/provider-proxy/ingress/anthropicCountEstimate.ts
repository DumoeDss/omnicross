/**
 * anthropicCountEstimate — the core-local, zero-dependency input-token
 * estimator behind the count_tokens `estimate` strategy
 * (`claude-api-protocol-fidelity`, R2 / design D1).
 *
 * Deliberately does NOT import `@omnicross/subscriptions` or any tokenizer:
 * core/subscriptions stays a hard boundary (the same precedent as
 * `buildSubscriptionRequestSummary`'s chars/4 fallback), and the estimate is
 * explicitly coarse — the response carries
 * `x-omnicross-count-estimate: true` so clients can tell it apart, and it is
 * never recorded as usage.
 *
 * Counted surfaces: `system` (string or block array), message content text
 * blocks / `thinking` text / `tool_result` text, `tools` (serialized schema
 * characters), and a fixed constant per image block. Conversion ≈ 4
 * chars/token. `cache_control` markers do NOT change the count (the whole
 * text is estimated).
 *
 * Budget guard: the walk tracks a character budget derived from
 * `estimateBudgetMs`. A pathological input that exhausts it degrades to
 * prefix sampling + proportional extrapolation instead of failing — the
 * estimator NEVER throws and NEVER calls upstream.
 *
 * @module provider-proxy/ingress/anthropicCountEstimate
 */

/** Default wall-clock budget for one estimate (ms). */
export const DEFAULT_COUNT_ESTIMATE_BUDGET_MS = 2000;

/**
 * Conservative chars-walked-per-ms rate used to convert the time budget into
 * a deterministic CHARACTER budget. Deliberately pessimistic (a real JS tree
 * walk is far faster) so the guard trips on genuinely huge inputs.
 */
const CHARS_WALKED_PER_MS = 100_000;

/** ≈4 characters per token (same convention as the subscription summary). */
const CHARS_PER_TOKEN = 4;

/** Fixed token weight per image content block (no bytes inspection). */
export const ESTIMATED_TOKENS_PER_IMAGE_BLOCK = 1500;

/**
 * Character-count + image-tally accumulator with a hard budget. `add*` return
 * false once the budget is exhausted — callers stop walking and extrapolate.
 */
class CharBudget {
  private used = 0;
  private imageBlocks = 0;
  exhausted = false;
  constructor(private readonly budget: number) {}
  addChars(n: number): boolean {
    if (this.exhausted) return false;
    this.used += n;
    if (this.used > this.budget) {
      this.exhausted = true;
      return false;
    }
    return true;
  }
  addImage(): boolean {
    this.imageBlocks += 1;
    return !this.exhausted;
  }
  get chars(): number {
    return this.used;
  }
  get images(): number {
    return this.imageBlocks;
  }
}

/**
 * Count the text-bearing characters of one content value (a string, a block
 * array, or a nested structure). Text blocks contribute `.text`, thinking
 * blocks `.thinking`, `tool_result` blocks their `.content` text; image blocks
 * tally the fixed constant instead of characters. Unknown shapes contribute
 * whatever string fields they expose at the known keys only — never a blind
 * JSON serialization of user content (keep the walk cheap and predictable).
 */
function countContentValue(value: unknown, budget: CharBudget): void {
  if (typeof value === 'string') {
    budget.addChars(value.length);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (budget.exhausted) return;
      countContentValue(item, budget);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  const block = value as Record<string, unknown>;
  if (block['type'] === 'image') {
    budget.addImage();
    return;
  }
  if (typeof block['text'] === 'string') budget.addChars(block['text'].length);
  if (typeof block['thinking'] === 'string') budget.addChars(block['thinking'].length);
  if (block['type'] === 'tool_result') countContentValue(block['content'], budget);
}

/** Count the `system` field (string or block array). */
function countSystem(body: Record<string, unknown>, budget: CharBudget): void {
  countContentValue(body['system'], budget);
}

/**
 * Walk `messages` under the budget. Returns how many messages were fully
 * sampled before the budget ran out (`messages.length` when it never did).
 */
function countMessages(
  messages: unknown[],
  budget: CharBudget,
): { sampled: number } {
  for (let i = 0; i < messages.length; i++) {
    if (budget.exhausted) return { sampled: i };
    const message = messages[i];
    if (!message || typeof message !== 'object') continue;
    countContentValue((message as Record<string, unknown>)['content'], budget);
    if (budget.exhausted) return { sampled: i };
  }
  return { sampled: messages.length };
}

/** Count `tools` as serialized-schema characters (prefix-sampled on budget). */
function countTools(tools: unknown[], budget: CharBudget): void {
  for (const tool of tools) {
    if (budget.exhausted) return;
    let serialized: string;
    try {
      serialized = JSON.stringify(tool) ?? '';
    } catch {
      serialized = '';
    }
    if (!budget.addChars(serialized.length)) return;
  }
}

/**
 * Estimate the Anthropic `input_tokens` of a `/v1/messages/count_tokens`
 * request body. Pure and synchronous; never throws; never touches the
 * network. On budget exhaustion the walk stops and the tally is extrapolated
 * from the sampled prefix (per-message average × remaining messages).
 */
export function estimateAnthropicInputTokens(
  body: Record<string, unknown>,
  budgetMs: number = DEFAULT_COUNT_ESTIMATE_BUDGET_MS,
): number {
  const budget = new CharBudget(
    Math.max(1, Math.floor((Number.isFinite(budgetMs) ? budgetMs : DEFAULT_COUNT_ESTIMATE_BUDGET_MS) * CHARS_WALKED_PER_MS)),
  );

  countSystem(body, budget);
  const systemChars = budget.chars;

  const messages = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : [];
  const { sampled } = countMessages(messages, budget);

  const tools = Array.isArray(body['tools']) ? (body['tools'] as unknown[]) : [];
  // Tools walk LAST so message-text extrapolation (below) can lean on the
  // fully-sampled message prefix; tools themselves prefix-sample on budget.
  countTools(tools, budget);

  let chars = budget.chars;
  // Budget exhausted mid-messages → extrapolate the unsampled tail from the
  // per-message average of the SAMPLED MESSAGE prefix (system chars excluded
  // from the average so they do not inflate it; a zero-sample prefix still
  // extrapolates from one message's worth rather than zero).
  if (sampled < messages.length) {
    const effectiveSampled = Math.max(1, sampled);
    const messageChars = budget.chars - systemChars;
    const avgPerMessage = messageChars / effectiveSampled;
    chars += avgPerMessage * (messages.length - effectiveSampled);
  }

  const textTokens = Math.ceil(chars / CHARS_PER_TOKEN);
  return textTokens + budget.images * ESTIMATED_TOKENS_PER_IMAGE_BLOCK;
}

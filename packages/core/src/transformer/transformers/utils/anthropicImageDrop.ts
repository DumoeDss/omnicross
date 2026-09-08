/**
 * anthropicImageDrop — the Anthropic Messages face's honest image boundary
 * (multi-provider-image-generation design D6④ / chat-inline-images spec).
 *
 * The Anthropic Messages wire has NO protocol-level image output block, so a
 * session response that carries generated images (OpenAI-compatible
 * `message.images` / `delta.images` data URLs) must DROP them at the
 * OpenAI→Anthropic encoders — never fabricate an out-of-protocol block and
 * never stuff base64 into the text content. The drop MUST be recorded, but
 * only as a BOUNDED count: the log line carries a running total and no image
 * data, and it fires at most once per stream/response so a chatty image stream
 * cannot spam the console.
 *
 * Observable seam (same shape as `stopReasonContentFilterCount` in
 * `AnthropicOpenAIToAnthropicStream`): the repo has no metrics registry, so an
 * exported counter + one console.warn line. Reset only via the test helper.
 *
 * @module transformer/transformers/utils/anthropicImageDrop
 */

/** Total session images dropped at the Anthropic face (process lifetime). */
export let anthropicDroppedImageCount = 0;

/** Whether the one-line warn already fired for the CURRENT stream/response. */
let warnedForCurrentStream = false;

/** Start a fresh stream/response: the next drop may warn again (bounded to once). */
export function beginAnthropicImageDropScope(): void {
  warnedForCurrentStream = false;
}

/** Test-only counter reset (keeps the exported binding read-only by convention). */
export function __resetAnthropicDroppedImageCountForTests(): void {
  anthropicDroppedImageCount = 0;
  warnedForCurrentStream = false;
}

/**
 * Record `count` dropped images. Increments the counter unconditionally (it is
 * the authoritative record); the console.warn fires at most once per
 * stream/response and contains counts only — never image bytes or data URLs.
 */
export function noteDroppedInlineImages(count: number): void {
  anthropicDroppedImageCount += count;
  if (warnedForCurrentStream) return;
  warnedForCurrentStream = true;
  console.warn(
    `[Anthropic face] dropped ${count} session image(s); the Anthropic Messages wire has no image block (total dropped: ${anthropicDroppedImageCount})`,
  );
}

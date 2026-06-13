/**
 * VisionFallbackProvider — serving-core port for image-to-text fallback.
 *
 * When the active completion model lacks vision capability but a message
 * carries images, `CompletionService.applyVisionFallback` delegates to this
 * port to turn the images into a text description (which is then appended to
 * the message content) before stripping the image attachments.
 *
 * The concrete implementation is built ON TOP OF CompletionService, so it
 * lives in the embedding host and is injected DOWN into the serving core via
 * `setVisionFallbackProvider` at bootstrap (instead of the core importing
 * upward).
 *
 * @module completion/VisionFallbackProvider
 */

/**
 * Describe a batch of images as text using an auxiliary vision-capable model.
 *
 * @param images  Image data URLs to describe (`{ data: 'data:<mime>;base64,…' }`).
 * @param context Free-form context (the surrounding user message content).
 * @param model   The resolved vision aux ModelRef (`"providerId,modelId"`).
 * @returns A textual description, or an empty / sentinel string when
 *          unavailable. Callers MUST tolerate `''` and
 *          `'[Image description unavailable]'`.
 */
export interface VisionFallbackProvider {
  describeImages(
    images: { data: string }[],
    context: string,
    model: string,
  ): Promise<string>;
}

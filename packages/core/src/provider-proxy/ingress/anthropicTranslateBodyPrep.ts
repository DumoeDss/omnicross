/**
 * anthropicTranslateBodyPrep — the async content-block pre-pass for the
 * TRANSLATE path (`claude-api-transform-fidelity`, R7 / design D3).
 *
 * Runs ONLY on the `!plan.sameFormat` branch of the built-in messages handler,
 * BEFORE the pipeline: the decoder is a synchronous pure function with no
 * budget/HTTP semantics, so the heavy or error-shaped work happens here where
 * async extraction + a `res` to answer are available.
 *
 *  - `document` blocks (base64 PDF): text extracted → the block is REPLACED IN
 *    PLACE by a `{type:'text'}` block carrying the text (plus a provenance
 *    note). Extraction failure (no text layer / over budget / low quality /
 *    non-base64 or non-PDF source) throws {@link DocumentNotSupportedError} →
 *    the caller answers an explicit 400 with the stable code in the message.
 *  - `search_result` / `container_upload` blocks: no cross-wire
 *    representation → {@link UnsupportedContentBlockError} → explicit 400.
 *
 * The same-format path NEVER runs this (byte-verbatim moat); documents there
 * relay untouched. In-place mutation is safe: the verbatim `rawBody` is a
 * separate string, and on translate paths the mutated object is exactly what
 * the decoder consumes.
 *
 * @module provider-proxy/ingress/anthropicTranslateBodyPrep
 */

import { extractPdfText } from './anthropicPdfText';

/** A `document` block the route cannot carry across the wire (explicit 400). */
export class DocumentNotSupportedError extends Error {
  readonly code = 'document_not_supported_on_route' as const;
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(
      `document block not supported on this route (${reason}${detail ? `: ${detail}` : ''})`,
    );
    this.name = 'DocumentNotSupportedError';
    this.reason = reason;
  }
}

/** A content block type with no cross-wire representation (explicit 400). */
export class UnsupportedContentBlockError extends Error {
  readonly code = 'unsupported_content_block' as const;
  readonly blockType: string;
  constructor(blockType: string) {
    super(
      `content block type '${blockType}' is not supported on translated routes; it cannot be forwarded and was not silently dropped`,
    );
    this.name = 'UnsupportedContentBlockError';
    this.blockType = blockType;
  }
}

/**
 * Prepare a parsed Anthropic request body for the translate pipeline (see the
 * module doc). Returns the same object (mutated in place). Throws the typed
 * errors above on unsupported content — the caller maps them to a 400.
 */
export async function prepareAnthropicTranslateBody(
  body: Record<string, unknown>,
  pdfBudgetMs?: number,
): Promise<Record<string, unknown>> {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return body;

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const content = (message as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) continue;

    for (let i = 0; i < content.length; i += 1) {
      const block = content[i];
      if (!block || typeof block !== 'object') continue;
      const typed = block as Record<string, unknown>;

      if (typed['type'] === 'document') {
        content[i] = await prepareDocumentBlock(typed, pdfBudgetMs);
        continue;
      }
      if (typed['type'] === 'search_result' || typed['type'] === 'container_upload') {
        throw new UnsupportedContentBlockError(String(typed['type']));
      }
    }
  }
  return body;
}

async function prepareDocumentBlock(
  block: Record<string, unknown>,
  pdfBudgetMs: number | undefined,
): Promise<Record<string, unknown>> {
  const source = block['source'] as Record<string, unknown> | undefined;
  const mediaType = source?.['media_type'];
  const data = source?.['data'];
  if (
    !source ||
    source['type'] !== 'base64' ||
    mediaType !== 'application/pdf' ||
    typeof data !== 'string'
  ) {
    throw new DocumentNotSupportedError(
      'no-text-layer',
      typeof mediaType === 'string' && mediaType !== 'application/pdf'
        ? `media type ${mediaType}`
        : 'source must be a base64 application/pdf',
    );
  }

  const extraction = extractPdfText(data, pdfBudgetMs);
  if ('reason' in extraction) {
    throw new DocumentNotSupportedError(extraction.reason);
  }

  // A text block replacing the document: the extracted text plus a provenance
  // note so the model knows what this blob is.
  const title = typeof block['title'] === 'string' ? block['title'] : 'untitled document';
  return {
    type: 'text',
    text: `[document: ${title}]\n${extraction.text}`,
  };
}

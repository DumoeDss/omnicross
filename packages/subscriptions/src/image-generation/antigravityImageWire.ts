/**
 * antigravityImageWire — the antigravity image-generation CCA wire
 * (multi-provider-image-generation design D4): NanoBanana models are native
 * image generators on the SAME `daily-cloudcode-pa` `v1internal:generateContent`
 * endpoint the text transformer rides — no image tool, no carrier model. The
 * request is a NON-STREAM standard generateContent body carrying
 * `responseModalities: ['TEXT','IMAGE']`; the response's first `inlineData`
 * part is the image.
 *
 * Never exported from the subscriptions package's public barrel.
 */

import { randomUUID } from 'node:crypto';

import {
  ImageGenerationError,
  InMemoryImageAsset,
  type ImageAsset,
} from '@omnicross/core/image-generation';
import {
  buildAntigravityUrl,
  deriveAntigravitySessionId,
} from '@omnicross/core/transformer/transformers/AntigravityTransformer';
import sharp from 'sharp';

import { readCandidateCodexImageResponseBody } from './privateWireResponse';

/** The upstream aspect-ratio vocabulary (Google imageConfig.aspectRatio). */
const ACCEPTED_ASPECT_RATIOS = new Set([
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '9:21',
]);

/** The antigravity image upstream endpoint (non-stream generateContent). */
export const ANTIGRAVITY_IMAGE_URL = buildAntigravityUrl(false);

/**
 * Map a normalized pixel size to the upstream aspect-ratio vocabulary by exact
 * reduced fraction; sizes without an exact accepted ratio (or `auto`) omit
 * `imageConfig` entirely — the upstream default applies. Exported for tests.
 */
export function antigravityAspectRatioFor(size: { kind: string; width?: number; height?: number }): string | undefined {
  if (size.kind !== 'pixels' || !size.width || !size.height) return undefined;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(size.width, size.height);
  const ratio = `${size.width / divisor}:${size.height / divisor}`;
  return ACCEPTED_ASPECT_RATIOS.has(ratio) ? ratio : undefined;
}

interface AntigravityImageWireInput {
  readonly model: string;
  readonly prompt: string;
  /** The resolved Code Assist project id (omitted for free-tier semantics). */
  readonly project?: string;
  /** The single edit reference image as raw Base64 (absent on generate). */
  readonly editImage?: { readonly base64: string; readonly mimeType: string };
  readonly aspectRatio?: string;
}

/** Build the antigravity image generateContent envelope. Exported for tests. */
export function buildAntigravityImageRequest(input: AntigravityImageWireInput): string {
  const parts: Array<Record<string, unknown>> = [];
  if (input.editImage) {
    parts.push({
      inlineData: { mime_type: input.editImage.mimeType, data: input.editImage.base64 },
    });
  }
  parts.push({ text: input.prompt });
  const generationConfig: Record<string, unknown> = {
    responseModalities: ['TEXT', 'IMAGE'],
    ...(input.aspectRatio ? { imageConfig: { aspectRatio: input.aspectRatio } } : {}),
  };
  const envelope = {
    project: input.project ?? undefined,
    requestId: `agent/${randomUUID()}/${Date.now()}/${randomUUID()}/1`,
    model: input.model,
    userAgent: 'antigravity',
    requestType: 'agent',
    request: {
      contents: [{ role: 'user', parts }],
      sessionId: deriveAntigravitySessionId(input.prompt),
      generationConfig,
    },
  };
  return JSON.stringify(envelope);
}


const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_PIXELS = 8_294_400;

function protocolChanged(cause?: unknown): ImageGenerationError {
  return new ImageGenerationError('upstream_protocol_changed', {
    cause,
    retrySafety: 'unknown',
  });
}

/**
 * Parse a non-stream antigravity image response: the FIRST `inlineData` part
 * whose mime is a declared-capable image format, fully pixel-validated via the
 * same bounded sharp decode the codex adapter uses. Text parts are surfaced as
 * a bounded summary (the "no image" failure detail) — never raw body dumps.
 * Exported for tests.
 */
export async function parseAntigravityImageResponse(body: string): Promise<ImageAsset> {
  if (!body.trim() || /^\s*</.test(body)) throw protocolChanged();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw protocolChanged(cause);
  }
  const envelope = parsed as Record<string, unknown>;
  const inner = (envelope['response'] ?? envelope) as Record<string, unknown>;
  const candidates = inner['candidates'];
  const candidate = Array.isArray(candidates) ? candidates[0] as Record<string, unknown> | undefined : undefined;
  const content = candidate?.['content'] as Record<string, unknown> | undefined;
  const parts = content?.['parts'];
  if (!Array.isArray(parts)) throw protocolChanged();

  let textSummary = '';
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (typeof record['text'] === 'string') textSummary += record['text'];
    const inline = (record['inlineData'] ?? record['inline_data']) as
      | { mimeType?: string; mime_type?: string; data?: unknown }
      | undefined;
    const mime = inline?.mimeType ?? inline?.mime_type;
    const data = inline?.data;
    if (typeof mime !== 'string' || typeof data !== 'string' || !data) continue;
    // v1 capability declares PNG-only (design D4); a different actual format is
    // an honest protocol mismatch rather than a silent substitution.
    if (mime !== 'image/png') throw protocolChanged();
    const bytes = Buffer.from(data, 'base64');
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw protocolChanged();
    if (bytes.toString('base64') !== data) throw protocolChanged();
    try {
      const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_PIXELS, sequentialRead: true });
      const metadata = await decoder.metadata();
      if (
        metadata.format !== 'png' ||
        !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) ||
        metadata.width! <= 0 || metadata.height! <= 0 ||
        metadata.width! * metadata.height! > MAX_PIXELS
      ) throw undefined;
      const decoded = await decoder.raw().toBuffer({ resolveWithObject: true });
      if (
        decoded.info.width !== metadata.width ||
        decoded.info.height !== metadata.height ||
        !Number.isSafeInteger(decoded.info.channels) ||
        decoded.info.channels <= 0 || decoded.info.channels > 4 ||
        decoded.data.byteLength !== decoded.info.width * decoded.info.height * decoded.info.channels
      ) throw undefined;
      return new InMemoryImageAsset(bytes, {
        mimeType: 'image/png',
        width: decoded.info.width,
        height: decoded.info.height,
        ...(metadata.hasAlpha !== undefined ? { hasAlpha: metadata.hasAlpha } : {}),
      });
    } catch (cause) {
      throw protocolChanged(cause);
    }
  }
  const bounded = textSummary.trim().slice(0, 200);
  throw new ImageGenerationError('image_generation_failed', {
    retrySafety: 'unknown',
    ...(bounded ? { cause: new Error(`upstream returned no image: ${bounded}`) } : {}),
  });
}

/** Bounded response-body read (shared with the codex adapter's limits). */
export const readAntigravityImageResponseBody = readCandidateCodexImageResponseBody;

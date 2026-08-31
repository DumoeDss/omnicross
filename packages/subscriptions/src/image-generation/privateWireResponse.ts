import type {
  ImageOutputFormat,
  ImageUsage,
} from '@omnicross/contracts/image-generation-types';
import {
  ImageGenerationError,
  InMemoryImageAsset,
  type ImageAsset,
} from '@omnicross/core/image-generation';
import sharp from 'sharp';

export interface ParsedCandidateCodexImageResponse {
  readonly images: readonly ImageAsset[];
  readonly revisedPrompt?: string;
  readonly usage?: ImageUsage;
}

/** Private lifecycle helper used by consuming verification probes. */
export function disposeCandidateCodexImageResponse(
  parsed: ParsedCandidateCodexImageResponse | undefined,
): void {
  if (!parsed) return;
  for (const image of parsed.images) {
    if (image instanceof InMemoryImageAsset) image.dispose();
  }
}

/** 50 MiB decoded image plus Base64/JSON overhead, with no unbounded body read. */
const MAX_CANDIDATE_RESPONSE_BYTES = 70_000_000;
const MAX_DECODED_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_DECODED_IMAGE_PIXELS = 8_294_400;
const MAX_DECODED_RAW_BYTES = MAX_DECODED_IMAGE_PIXELS * 4;

export async function readCandidateCodexImageResponseBody(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_CANDIDATE_RESPONSE_BYTES)) {
    return protocolChanged();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let body = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_CANDIDATE_RESPONSE_BYTES) {
        await reader.cancel();
        return protocolChanged();
      }
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } catch (cause) {
    return protocolChanged(cause);
  } finally {
    reader.releaseLock();
  }
}

export function selectVerifiedCandidateResponseMetadata(
  parsed: ParsedCandidateCodexImageResponse,
  verified: { readonly usage?: boolean; readonly revisedPrompt?: boolean } | undefined,
): Pick<ParsedCandidateCodexImageResponse, 'usage' | 'revisedPrompt'> {
  return {
    ...(verified?.usage && parsed.usage ? { usage: parsed.usage } : {}),
    ...(verified?.revisedPrompt && parsed.revisedPrompt
      ? { revisedPrompt: parsed.revisedPrompt }
      : {}),
  };
}

function protocolChanged(cause?: unknown): never {
  throw new ImageGenerationError('upstream_protocol_changed', { cause });
}

/** Private-module test seam; not exported from the subscriptions package barrel. */
export function decodeCandidateBase64ForTests(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    return protocolChanged();
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength <= 0 || decodedLength > MAX_DECODED_IMAGE_BYTES) return protocolChanged();

  const alphabetEnd = value.length - padding;
  for (let index = 0; index < alphabetEnd; index += 1) {
    const code = value.charCodeAt(index);
    const allowed =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!allowed) return protocolChanged();
  }
  for (let index = alphabetEnd; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return protocolChanged();
  }
  if (padding === 1 && value.charCodeAt(value.length - 2) === 0x3d) return protocolChanged();

  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.byteLength !== decodedLength ||
    decoded.toString('base64') !== value
  ) return protocolChanged();
  return new Uint8Array(decoded);
}

function readU32Be(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! << 24) |
    (bytes[offset + 1]! << 16) |
    (bytes[offset + 2]! << 8) |
    bytes[offset + 3]!
  ) >>> 0;
}

function readU32Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

/** Require a complete container in addition to libvips' complete pixel decode. */
function assertCompleteContainer(bytes: Uint8Array, format: ImageOutputFormat): void {
  if (format === 'jpeg') {
    if (bytes.byteLength < 4 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) protocolChanged();
    return;
  }
  if (format === 'webp') {
    if (
      bytes.byteLength < 20 ||
      Buffer.from(bytes.subarray(0, 4)).toString('ascii') !== 'RIFF' ||
      Buffer.from(bytes.subarray(8, 12)).toString('ascii') !== 'WEBP' ||
      readU32Le(bytes, 4) + 8 !== bytes.byteLength
    ) protocolChanged();
    let offset = 12;
    while (offset < bytes.byteLength) {
      if (offset + 8 > bytes.byteLength) protocolChanged();
      const length = readU32Le(bytes, offset + 4);
      const next = offset + 8 + length + (length % 2);
      if (next > bytes.byteLength) protocolChanged();
      offset = next;
    }
    if (offset !== bytes.byteLength) protocolChanged();
    return;
  }

  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < 20 || !signature.every((value, index) => bytes[index] === value)) {
    protocolChanged();
  }
  let offset = 8;
  let sawEnd = false;
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) protocolChanged();
    const length = readU32Be(bytes, offset);
    const next = offset + 12 + length;
    if (next > bytes.byteLength) protocolChanged();
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString('ascii');
    if (type === 'IEND') {
      if (length !== 0 || next !== bytes.byteLength) protocolChanged();
      sawEnd = true;
    }
    offset = next;
  }
  if (!sawEnd || offset !== bytes.byteLength) protocolChanged();
}

async function createAsset(value: unknown, format: ImageOutputFormat): Promise<ImageAsset> {
  const bytes = decodeCandidateBase64ForTests(value);
  assertCompleteContainer(bytes, format);
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    const decoder = sharp(input, {
      failOn: 'warning',
      limitInputPixels: MAX_DECODED_IMAGE_PIXELS,
      sequentialRead: true,
    });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== format ||
      !Number.isSafeInteger(metadata.width) ||
      !Number.isSafeInteger(metadata.height) ||
      metadata.width! <= 0 ||
      metadata.height! <= 0 ||
      metadata.width! * metadata.height! > MAX_DECODED_IMAGE_PIXELS
    ) return protocolChanged();

    // Metadata parsing alone is insufficient: force a complete, bounded pixel
    // decode so truncated IDAT, JPEG scan, VP8 and VP8L payloads fail before the
    // provider can emit `completed` / `independentlyDecodable: true`.
    const decoded = await decoder.raw().toBuffer({ resolveWithObject: true });
    if (
      decoded.info.width !== metadata.width ||
      decoded.info.height !== metadata.height ||
      !Number.isSafeInteger(decoded.info.channels) ||
      decoded.info.channels <= 0 ||
      decoded.info.channels > 4 ||
      decoded.data.byteLength !== decoded.info.width * decoded.info.height * decoded.info.channels ||
      decoded.data.byteLength > MAX_DECODED_RAW_BYTES
    ) return protocolChanged();

    return new InMemoryImageAsset(bytes, {
      mimeType: `image/${format}`,
      width: decoded.info.width,
      height: decoded.info.height,
      ...(metadata.hasAlpha !== undefined ? { hasAlpha: metadata.hasAlpha } : {}),
    });
  } catch (cause) {
    return protocolChanged(cause);
  }
}

function parseUsage(value: unknown): ImageUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const read = (key: string): number | undefined => {
    const item = record[key];
    return Number.isSafeInteger(item) && (item as number) >= 0 ? (item as number) : undefined;
  };
  const usage: ImageUsage = {
    totalTokens: read('total_tokens'),
    inputTokens: read('input_tokens'),
    outputTokens: read('output_tokens'),
    generatedImages: read('generated_images'),
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined;
}

export async function parseCandidateCodexImageResponse(
  body: string,
  expectedCount: number,
  expectedFormat: ImageOutputFormat,
): Promise<ParsedCandidateCodexImageResponse> {
  if (!body.trim() || /^s*</.test(body)) return protocolChanged();
  if (/^\s*(?:data|event):/u.test(body)) {
    return parseCandidateCodexImageSse(body, expectedCount, expectedFormat);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    return protocolChanged(cause);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return protocolChanged();
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.data)) {
    if (record.data.length !== expectedCount) return protocolChanged();
    const rows = record.data.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return protocolChanged();
      return item as Record<string, unknown>;
    });
    const images = await Promise.all(rows.map((item) => createAsset(item.b64_json, expectedFormat)));
    const revised = rows.length === 1 && typeof rows[0]?.revised_prompt === 'string'
      ? rows[0].revised_prompt
      : undefined;
    return {
      images,
      revisedPrompt: revised,
      usage: parseUsage(record.usage),
    };
  }
  if (!Array.isArray(record.output)) return protocolChanged();
  const calls = record.output.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === 'object' && !Array.isArray(item) &&
      (item as Record<string, unknown>).type === 'image_generation_call',
  );
  if (calls.length !== expectedCount) return protocolChanged();
  const images = await Promise.all(calls.map(async (call) => {
    if (call.status !== 'completed' || typeof call.result !== 'string') return protocolChanged();
    return createAsset(call.result, expectedFormat);
  }));
  const revised = calls.length === 1 && typeof calls[0]?.revised_prompt === 'string'
    ? calls[0].revised_prompt
    : undefined;
  return {
    images,
    revisedPrompt: revised,
    usage: parseUsage(record.usage),
  };
}

async function parseCandidateCodexImageSse(
  body: string,
  expectedCount: number,
  expectedFormat: ImageOutputFormat,
): Promise<ParsedCandidateCodexImageResponse> {
  const best = new Map<number, string>();
  const completedEventResults: string[] = [];
  let completedResponse: Record<string, unknown> | undefined;

  for (const line of body.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (typeof record.partial_image_b64 === 'string') {
      const index = record.partial_image_index === undefined ? 0 : record.partial_image_index;
      if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= expectedCount) continue;
      const previous = best.get(index as number);
      if (!previous || record.partial_image_b64.length >= previous.length) {
        best.set(index as number, record.partial_image_b64);
      }
    }
    if (record.type === 'response.completed') {
      if (!record.response || typeof record.response !== 'object' || Array.isArray(record.response)) {
        return protocolChanged();
      }
      completedResponse = record.response as Record<string, unknown>;
    }
    if (record.type === 'response.output_item.done' &&
      record.item && typeof record.item === 'object' && !Array.isArray(record.item)) {
      const item = record.item as Record<string, unknown>;
      if (item.type === 'image_generation_call' &&
        item.status === 'completed' && typeof item.result === 'string') {
        completedEventResults.push(item.result);
      }
    }
  }

  const output = completedResponse?.output;
  const calls = Array.isArray(output)
    ? output.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && !Array.isArray(item) &&
          (item as Record<string, unknown>).type === 'image_generation_call',
      )
    : [];
  const finalResults = calls.filter(
    (call): call is Record<string, unknown> & { readonly result: string } =>
      call.status === 'completed' && typeof call.result === 'string',
  );
  if (best.size !== expectedCount &&
    completedEventResults.length !== expectedCount &&
    finalResults.length !== expectedCount) {
    return protocolChanged();
  }
  const images = await Promise.all(Array.from({ length: expectedCount }, async (_unused, index) => {
    const encoded = best.get(index) ?? completedEventResults[index] ?? finalResults[index]?.result;
    if (!encoded) return protocolChanged();
    return createAsset(encoded, expectedFormat);
  }));
  const revised = calls.length === 1 && typeof calls[0]?.revised_prompt === 'string'
    ? calls[0].revised_prompt
    : undefined;
  return {
    images,
    revisedPrompt: revised,
    usage: parseUsage(completedResponse?.usage),
  };
}

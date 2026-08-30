import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

import { Agent, request } from 'undici';

import { ImageGenerationError } from '../errors';
import type { RemoteImageAssetResolver } from './types';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface SafeRemoteImageResolverDeps {
  readonly resolveAll?: (hostname: string, signal: AbortSignal) => Promise<readonly ResolvedAddress[]>;
  readonly requestPinned?: (input: SafeRemotePinnedRequest) => Promise<SafeRemotePinnedResponse>;
}

export interface SafeRemotePinnedRequest {
  readonly url: URL;
  readonly address: ResolvedAddress;
  readonly signal: AbortSignal;
  readonly connectTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxHeaderBytes: number;
}

export interface SafeRemotePinnedResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: AsyncIterable<Uint8Array> & { dump(): Promise<unknown> };
  close(): Promise<void>;
}

function ipv4Number(value: string): number | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  let output = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255 || String(octet) !== part) return undefined;
    output = (output * 256) + octet;
  }
  return output >>> 0;
}

function blockedIpv4(value: string): boolean {
  const address = ipv4Number(value);
  if (address === undefined) return true;
  const first = address >>> 24;
  const second = (address >>> 16) & 0xff;
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 192 && second === 0) return true;
  if (first === 192 && second === 2) return true;
  if (first === 198 && (second === 18 || second === 19 || second === 51)) return true;
  if (first === 203 && second === 0) return true;
  if (first >= 224) return true;
  return false;
}

function ipv6Bytes(input: string): Uint8Array | undefined {
  const zone = input.indexOf('%');
  const value = (zone >= 0 ? input.slice(0, zone) : input).toLowerCase();
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] | undefined => {
    if (!half) return [];
    const words: number[] = [];
    for (const item of half.split(':')) {
      if (item.includes('.')) {
        const ipv4 = ipv4Number(item);
        if (ipv4 === undefined) return undefined;
        words.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(item)) return undefined;
        words.push(Number.parseInt(item, 16));
      }
    }
    return words;
  };
  const left = parseHalf(halves[0]!);
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return undefined;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const words = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (words.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  words.forEach((word, index) => {
    bytes[index * 2] = word >>> 8;
    bytes[(index * 2) + 1] = word & 0xff;
  });
  return bytes;
}

function blockedIpv6(value: string): boolean {
  const bytes = ipv6Bytes(value);
  if (!bytes) return true;
  if (bytes.every((item) => item === 0)) return true;
  if (bytes.slice(0, 15).every((item) => item === 0) && bytes[15] === 1) return true;
  if ((bytes[0]! & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xff) return true;
  const mapped = bytes.slice(0, 10).every((item) => item === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return blockedIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  const compatible = bytes.slice(0, 12).every((item) => item === 0);
  if (compatible) return blockedIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  return false;
}

export function isBlockedRemoteAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? blockedIpv4(address) : family === 6 ? blockedIpv6(address) : true;
}

function safeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ImageGenerationError('invalid_image_request', { param: 'image_url' });
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new ImageGenerationError('invalid_image_request', { param: 'image_url' });
  }
  return url;
}

function combinedSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
}

function pinnedLookup(address: ResolvedAddress): LookupFunction {
  return ((_hostname, options, callback) => {
    if (typeof options === 'object' && options.all) {
      callback(null, [{ address: address.address, family: address.family }]);
      return;
    }
    callback(null, address.address, address.family);
  }) as LookupFunction;
}

async function defaultResolveAll(hostname: string, signal: AbortSignal): Promise<readonly ResolvedAddress[]> {
  const lookup = dnsLookup(hostname, { all: true, verbatim: true });
  let abort: (() => void) | undefined;
  try {
    const results = await Promise.race([
      lookup,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
    return results.filter((item): item is ResolvedAddress => item.family === 4 || item.family === 6);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

function headerBytes(headers: Record<string, string | string[] | undefined>): number {
  let total = 0;
  for (const [name, value] of Object.entries(headers)) {
    total += Buffer.byteLength(name);
    for (const item of Array.isArray(value) ? value : [value ?? '']) total += Buffer.byteLength(item);
  }
  return total;
}

function contentLength(value: string | string[] | undefined, maxBytes: number): number | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new ImageGenerationError('image_generation_failed');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ImageGenerationError('image_generation_failed');
  if (parsed > maxBytes) throw new ImageGenerationError('image_too_large');
  return parsed;
}

async function defaultRequestPinned(input: SafeRemotePinnedRequest): Promise<SafeRemotePinnedResponse> {
  const dispatcher = new Agent({
    maxHeaderSize: input.maxHeaderBytes,
    connect: {
      lookup: pinnedLookup(input.address),
      timeout: input.connectTimeoutMs,
    },
  });
  try {
    const response = await request(input.url, {
      method: 'GET',
      dispatcher,
      signal: input.signal,
      maxRedirections: 0,
      headersTimeout: input.connectTimeoutMs,
      bodyTimeout: input.totalTimeoutMs,
      headers: { accept: 'image/png,image/jpeg,image/webp' },
    });
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
      close: () => dispatcher.close(),
    };
  } catch (error) {
    await dispatcher.close().catch(() => undefined);
    throw error;
  }
}

export function createSafeRemoteImageResolver(
  deps: SafeRemoteImageResolverDeps = {},
): RemoteImageAssetResolver {
  const resolveAll = deps.resolveAll ?? defaultResolveAll;
  const requestPinned = deps.requestPinned ?? defaultRequestPinned;
  return {
    async resolve(input) {
      const totalSignal = combinedSignal(input.signal, input.limits.remoteTotalTimeoutMs);
      let current = safeUrl(input.url);
      try {
        for (let redirects = 0; redirects <= input.limits.maxRedirects; redirects += 1) {
          if (totalSignal.aborted) throw totalSignal.reason;
          const literal = current.hostname.startsWith('[') && current.hostname.endsWith(']')
            ? current.hostname.slice(1, -1)
            : current.hostname;
          const family = isIP(literal);
          const answers = family
            ? [{ address: literal, family: family as 4 | 6 }]
            : await resolveAll(literal, totalSignal);
          if (answers.length === 0 || answers.some((answer) => isBlockedRemoteAddress(answer.address))) {
            throw new ImageGenerationError('invalid_image_request', { param: 'image_url' });
          }
          const selected = answers[0]!;
          const response = await requestPinned({
            url: current,
            address: selected,
            signal: totalSignal,
            connectTimeoutMs: input.limits.remoteConnectTimeoutMs,
            totalTimeoutMs: input.limits.remoteTotalTimeoutMs,
            maxHeaderBytes: input.limits.maxRemoteHeaderBytes,
          });
          try {
            if (headerBytes(response.headers) > input.limits.maxRemoteHeaderBytes) {
              await response.body.dump();
              throw new ImageGenerationError('image_too_large');
            }
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
              const location = response.headers.location;
              await response.body.dump();
              if (redirects >= input.limits.maxRedirects || typeof location !== 'string') {
                throw new ImageGenerationError('invalid_image_request', { param: 'image_url' });
              }
              current = safeUrl(new URL(location, current).toString());
              continue;
            }
            if (response.statusCode < 200 || response.statusCode >= 300) {
              await response.body.dump();
              throw new ImageGenerationError('image_generation_failed');
            }
            const declared = contentLength(response.headers['content-length'], input.limits.maxFileBytes);
            return await input.materializer.materialize(response.body, declared, totalSignal);
          } finally {
            await response.close().catch(() => undefined);
          }
        }
        throw new ImageGenerationError('invalid_image_request', { param: 'image_url' });
      } catch (error) {
        if (error instanceof ImageGenerationError) throw error;
        if (input.signal.aborted) {
          throw new ImageGenerationError('request_cancelled', { cause: input.signal.reason });
        }
        if (totalSignal.aborted) throw new ImageGenerationError('image_generation_timeout');
        throw new ImageGenerationError('image_generation_failed');
      }
    },
  };
}

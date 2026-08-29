import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ImageGenerationError, serializeImageGenerationError } from '../../errors';
import { InMemoryImageAsset } from '../../ports';
import { createImageRequestResourceScope } from '../TemporaryImageAsset';
import { serializeImageApiError } from '../imageApiErrors';
import { writeImageApiResponse } from '../imageApiResponse';
import { writeImageApiSse } from '../imageApiSse';
import { DEFAULT_IMAGE_API_LIMITS } from '../types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class ResponseDouble extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  writes = 0;
  slowWrite = -1;
  onSlow?: () => void;

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  flushHeaders(): void {
    this.headersSent = true;
  }

  write(chunk: string | Uint8Array): boolean {
    this.writes += 1;
    this.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (this.writes === this.slowWrite) {
      this.onSlow?.();
      setTimeout(() => this.emit('drain'), 20);
      return false;
    }
    return true;
  }

  end(chunk?: string | Uint8Array): void {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
  }
}

function asset(bytes: readonly number[]) {
  return new InMemoryImageAsset(Uint8Array.from(bytes), {
    mimeType: 'image/png',
    width: 1,
    height: 1,
    hasAlpha: true,
  });
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'omnicross-output-test-'));
  roots.push(root);
  const controller = new AbortController();
  return {
    root,
    controller,
    scope: await createImageRequestResourceScope(DEFAULT_IMAGE_API_LIMITS, controller.signal, root),
  };
}

const metadata = {
  background: 'auto' as const,
  outputFormat: 'png' as const,
  quality: 'auto' as const,
  size: 'auto',
};

describe('Images output bounds and SSE lifecycle', () => {
  it('does not commit HTTP 200 before every non-stream output stages', async () => {
    const resources = await setup();
    const response = new ResponseDouble();
    async function* events() {
      yield { type: 'accepted' as const, acceptedAt: 1 };
      yield { type: 'completed' as const, images: [{ artifact: asset([1, 2, 3, 4, 5]) }] };
    }
    try {
      await expect(writeImageApiResponse({
        response: response as unknown as http.ServerResponse,
        events: events(),
        requestedCount: 1,
        requestId: 'safe',
        createdAt: 1,
        scope: resources.scope,
        limits: { ...DEFAULT_IMAGE_API_LIMITS, maxOutputBytes: 4 },
        signal: resources.controller.signal,
      })).rejects.toMatchObject({ code: 'image_too_large' });
      expect(response.headersSent).toBe(false);
      expect(response.body).toBe('');
    } finally {
      await resources.scope.cleanup();
    }
  });

  it('waits for drain before pulling the next provider event', async () => {
    const resources = await setup();
    const response = new ResponseDouble();
    response.slowWrite = 1;
    let pulls = 0;
    let pullsWhenBlocked = -1;
    response.onSlow = () => { pullsWhenBlocked = pulls; };
    async function* events() {
      pulls += 1;
      yield { type: 'accepted' as const, acceptedAt: 1 };
      pulls += 1;
      yield {
        type: 'partial_image' as const,
        outputIndex: 0,
        partialImageIndex: 0,
        image: { artifact: asset([1, 2, 3]) },
      };
      pulls += 1;
      yield { type: 'completed' as const, images: [{ artifact: asset([4, 5, 6]) }] };
    }
    try {
      await writeImageApiSse({
        action: 'generation',
        response: response as unknown as http.ServerResponse,
        events: events(),
        requestedCount: 1,
        requestId: 'safe',
        createdAt: 1,
        metadata,
        scope: resources.scope,
        limits: DEFAULT_IMAGE_API_LIMITS,
        signal: resources.controller.signal,
      });
      expect(pullsWhenBlocked).toBe(2);
      expect(pulls).toBe(3);
      expect(response.body).toContain('image_generation.partial_image');
      expect(response.body).toContain('image_generation.completed');
    } finally {
      await resources.scope.cleanup();
    }
  });

  it('keeps pre-accept failure uncommitted and emits one safe post-accept error frame', async () => {
    const before = await setup();
    const beforeResponse = new ResponseDouble();
    async function* failedBefore() {
      yield {
        type: 'failed' as const,
        error: serializeImageGenerationError(new ImageGenerationError('upstream_rate_limited', {
          retryAfterSeconds: 3,
        })),
      };
    }
    try {
      await expect(writeImageApiSse({
        action: 'edit',
        response: beforeResponse as unknown as http.ServerResponse,
        events: failedBefore(),
        requestedCount: 1,
        requestId: 'safe',
        createdAt: 1,
        metadata,
        scope: before.scope,
        limits: DEFAULT_IMAGE_API_LIMITS,
        signal: before.controller.signal,
      })).rejects.toMatchObject({ code: 'upstream_rate_limited' });
      expect(beforeResponse.headersSent).toBe(false);
    } finally {
      await before.scope.cleanup();
    }

    const after = await setup();
    const afterResponse = new ResponseDouble();
    async function* failedAfter() {
      yield { type: 'accepted' as const, acceptedAt: 1 };
      yield {
        type: 'failed' as const,
        error: serializeImageGenerationError(new ImageGenerationError('upstream_protocol_changed')),
      };
    }
    try {
      await expect(writeImageApiSse({
        action: 'generation',
        response: afterResponse as unknown as http.ServerResponse,
        events: failedAfter(),
        requestedCount: 1,
        requestId: 'safe',
        createdAt: 1,
        metadata,
        scope: after.scope,
        limits: DEFAULT_IMAGE_API_LIMITS,
        signal: after.controller.signal,
      })).rejects.toMatchObject({ code: 'upstream_protocol_changed' });
      expect(afterResponse.statusCode).toBe(200);
      expect(afterResponse.body.match(/event: error/g)).toHaveLength(1);
      expect(afterResponse.writableEnded).toBe(true);
    } finally {
      await after.scope.cleanup();
    }
  });
});

describe('Images wire error redaction', () => {
  it('retains only allow-listed retry/moderation details and drops cause sentinels', () => {
    const sentinels = [
      'Bearer TOKEN_SECRET',
      'Cookie=COOKIE_SECRET',
      'PROMPT_SECRET',
      'C:\\private\\secret.png',
      'https://user:pass@example.test/a?token=URL_SECRET',
      'BASE64_SECRET',
    ];
    const mapped = serializeImageApiError(new ImageGenerationError('moderation_blocked', {
      retryAfterSeconds: 7,
      moderationDetails: { stage: 'input', categories: ['violence', 'bad category secret'] },
      cause: new Error(sentinels.join(' ')),
    }));
    const wire = JSON.stringify(mapped);
    expect(mapped.headers).toEqual({ 'Retry-After': '7' });
    expect(mapped.body.error).toMatchObject({
      code: 'moderation_blocked',
      moderation_details: { stage: 'input', categories: ['violence'] },
    });
    for (const sentinel of sentinels) expect(wire).not.toContain(sentinel);
  });
});

/**
 * Object-key layout: `<prefix>/<purpose>/<yyyy/mm/dd>/<uuid>-<stem><ext>`.
 * Ported verbatim from Elftia's desktop `public-assets/objectKey.ts`.
 *
 * @module core/object-storage/objectKey
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { ObjectStoragePublishHints } from './types';

function safeSegment(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
}

export function normalizeObjectPrefix(value: string | undefined): string {
  const raw = value?.trim().replace(/^\/+|\/+$/gu, '') ?? '';
  if (!raw) return '';
  const segments = raw.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Object storage prefix contains an unsafe path segment');
  }
  return segments.map(safeSegment).filter(Boolean).join('/');
}

export function buildObjectKey(
  prefix: string | undefined,
  fileName: string,
  hints: ObjectStoragePublishHints,
  now = new Date()
): string {
  const normalizedPrefix = normalizeObjectPrefix(prefix);
  const purpose = safeSegment(hints.purpose ?? 'assets') || 'assets';
  const extension = safeSegment(path.extname(fileName).toLowerCase());
  const stem = safeSegment(path.basename(fileName, path.extname(fileName))) || 'asset';
  const date = now.toISOString().slice(0, 10).replace(/-/gu, '/');
  const objectName = `${randomUUID()}-${stem}${extension}`;
  return [normalizedPrefix, purpose, date, objectName].filter(Boolean).join('/');
}

/**
 * Metadata-only audit aggregation. The overview needs request/error counts, not
 * multi-gigabyte request/response bodies. A compact per-day sidecar is updated
 * with each new record; legacy files are scanned once with a bounded prefix per
 * JSONL row and then cached in the same sidecar.
 */

import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { AuditRecord, AuditStats } from '@omnicross/contracts/audit-types';

import { AUDIT_FILE_RE, auditFileDateMs } from './auditFiles';

const SIDECAR_VERSION = 1;
const META_PREFIX_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

export interface AuditStatsQuery {
  from?: number;
  to?: number;
}

interface PersistedAuditStats extends AuditStats {
  version: typeof SIDECAR_VERSION;
  auditBytes: number;
  minTs: number | null;
  maxTs: number | null;
}

interface ScannedAuditStats {
  all: PersistedAuditStats;
  filtered: AuditStats;
}

/** Sidecar name paired with one `audit-YYYY-MM-DD.jsonl` file. */
export function auditStatsFileName(auditFile: string): string {
  return auditFile.replace(/\.jsonl$/, '.stats.json');
}

function readPersisted(path: string): PersistedAuditStats | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersistedAuditStats>;
    if (
      value.version !== SIDECAR_VERSION ||
      !Number.isSafeInteger(value.auditBytes) ||
      (value.auditBytes ?? -1) < 0 ||
      !Number.isSafeInteger(value.requestCount) ||
      (value.requestCount ?? -1) < 0 ||
      !Number.isSafeInteger(value.errorCount) ||
      (value.errorCount ?? -1) < 0 ||
      (value.errorCount ?? 0) > (value.requestCount ?? -1) ||
      typeof value.complete !== 'boolean' ||
      (value.minTs !== null && !Number.isFinite(value.minTs)) ||
      (value.maxTs !== null && !Number.isFinite(value.maxTs))
    ) {
      return null;
    }
    return value as PersistedAuditStats;
  } catch {
    return null;
  }
}

/** Update an exact sidecar after the corresponding audit line was appended. */
export function updateAuditStatsAfterAppend(
  auditPath: string,
  auditBytesBefore: number,
  auditBytesAfter: number,
  record: AuditRecord,
): void {
  const statsPath = join(dirname(auditPath), auditStatsFileName(basename(auditPath)));
  const previous = auditBytesBefore === 0
    ? {
        version: SIDECAR_VERSION,
        auditBytes: 0,
        requestCount: 0,
        errorCount: 0,
        complete: true,
        minTs: null,
        maxTs: null,
      } satisfies PersistedAuditStats
    : readPersisted(statsPath);
  // A missing/stale legacy sidecar must be rebuilt by the async reader. Starting
  // at zero here would silently present a partial day as complete.
  if (!previous || !previous.complete || previous.auditBytes !== auditBytesBefore) return;

  const next: PersistedAuditStats = {
    version: SIDECAR_VERSION,
    auditBytes: auditBytesAfter,
    requestCount: previous.requestCount + 1,
    errorCount: previous.errorCount + (record.status >= 400 || Boolean(record.error) ? 1 : 0),
    complete: true,
    minTs: previous.minTs === null ? record.ts : Math.min(previous.minTs, record.ts),
    maxTs: previous.maxTs === null ? record.ts : Math.max(previous.maxTs, record.ts),
  };
  writeFileSync(statsPath, JSON.stringify(next), 'utf8');
}

function queryCovers(stats: PersistedAuditStats, from: number, to: number): boolean {
  return stats.requestCount === 0 || (
    stats.minTs !== null &&
    stats.maxTs !== null &&
    from <= stats.minTs &&
    to >= stats.maxTs
  );
}

function fileOverlaps(file: string, from: number, to: number): boolean {
  const start = auditFileDateMs(file);
  if (start === null) return false;
  const date = new Date(start);
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  return end > from && start <= to;
}

function parseMetadataPrefix(prefix: Buffer, prefixTruncated: boolean): {
  ts?: number;
  status?: number;
  hasError: boolean;
  complete: boolean;
} {
  const text = prefix.toString('utf8');
  const tsMatch = /(?:^|,)"ts":(-?\d+)/.exec(text);
  const statusMatch = /(?:^|,)"status":(-?\d+)/.exec(text);
  const errorMatch = /(?:^|,)"error":"((?:\\.|[^"\\])*)"/.exec(text);
  const bodyStarted = /,(?:"requestBody"|"responseBody"):/.test(text);
  return {
    ts: tsMatch ? Number(tsMatch[1]) : undefined,
    status: statusMatch ? Number(statusMatch[1]) : undefined,
    hasError: Boolean(errorMatch?.[1]),
    complete: Boolean(tsMatch && statusMatch && (!prefixTruncated || bodyStarted)),
  };
}

async function scanAuditFile(
  auditPath: string,
  startByte: number,
  auditBytes: number,
  from: number,
  to: number,
): Promise<ScannedAuditStats> {
  let requestCount = 0;
  let errorCount = 0;
  let filteredRequestCount = 0;
  let filteredErrorCount = 0;
  let minTs: number | null = null;
  let maxTs: number | null = null;
  let complete = true;
  let prefixParts: Buffer[] = [];
  let prefixBytes = 0;
  let prefixTruncated = false;

  const consumeLine = (): void => {
    if (prefixBytes === 0 && !prefixTruncated) return;
    const prefix = Buffer.concat(prefixParts, prefixBytes);
    const metadata = parseMetadataPrefix(prefix, prefixTruncated);
    if (!metadata.complete || metadata.ts === undefined || metadata.status === undefined) {
      complete = false;
    } else {
      requestCount += 1;
      const isError = metadata.status >= 400 || metadata.hasError;
      if (isError) errorCount += 1;
      minTs = minTs === null ? metadata.ts : Math.min(minTs, metadata.ts);
      maxTs = maxTs === null ? metadata.ts : Math.max(maxTs, metadata.ts);
      if (metadata.ts >= from && metadata.ts <= to) {
        filteredRequestCount += 1;
        if (isError) filteredErrorCount += 1;
      }
    }
    prefixParts = [];
    prefixBytes = 0;
    prefixTruncated = false;
  };

  if (auditBytes > startByte) {
    const stream = createReadStream(auditPath, {
      start: startByte,
      end: auditBytes - 1,
      highWaterMark: READ_CHUNK_BYTES,
    });
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline;
        if (prefixBytes < META_PREFIX_BYTES) {
          const retained = Math.min(META_PREFIX_BYTES - prefixBytes, end - offset);
          if (retained > 0) {
            prefixParts.push(Buffer.from(chunk.subarray(offset, offset + retained)));
            prefixBytes += retained;
          }
          if (retained < end - offset) prefixTruncated = true;
        } else if (end > offset) {
          prefixTruncated = true;
        }
        if (newline === -1) break;
        consumeLine();
        offset = newline + 1;
      }
    }
  }
  // A non-empty trailing fragment is a torn JSONL record; exclude it but mark
  // the aggregate as inexact instead of inventing a successful request.
  if (prefixBytes > 0 || prefixTruncated) complete = false;

  return {
    all: {
      version: SIDECAR_VERSION,
      auditBytes,
      requestCount,
      errorCount,
      complete,
      minTs,
      maxTs,
    },
    filtered: { requestCount: filteredRequestCount, errorCount: filteredErrorCount, complete },
  };
}

function mergePersistedStats(
  previous: PersistedAuditStats,
  appended: PersistedAuditStats,
): PersistedAuditStats {
  return {
    version: SIDECAR_VERSION,
    auditBytes: appended.auditBytes,
    requestCount: previous.requestCount + appended.requestCount,
    errorCount: previous.errorCount + appended.errorCount,
    complete: previous.complete && appended.complete,
    minTs: previous.minTs === null
      ? appended.minTs
      : appended.minTs === null ? previous.minTs : Math.min(previous.minTs, appended.minTs),
    maxTs: previous.maxTs === null
      ? appended.maxTs
      : appended.maxTs === null ? previous.maxTs : Math.max(previous.maxTs, appended.maxTs),
  };
}

/** Read exact request/error counts without ever materializing captured bodies. */
export async function readAuditStats(
  auditDir: string,
  query: AuditStatsQuery = {},
): Promise<AuditStats> {
  if (!existsSync(auditDir)) return { requestCount: 0, errorCount: 0, complete: true };
  const from = typeof query.from === 'number' ? query.from : -Infinity;
  const to = typeof query.to === 'number' ? query.to : Infinity;
  let files: string[];
  try {
    files = readdirSync(auditDir)
      .filter((file) => AUDIT_FILE_RE.test(file) && fileOverlaps(file, from, to))
      .sort();
  } catch {
    return { requestCount: 0, errorCount: 0, complete: false };
  }

  const total: AuditStats = { requestCount: 0, errorCount: 0, complete: true };
  for (const file of files) {
    const auditPath = join(auditDir, file);
    try {
      const auditBytes = statSync(auditPath).size;
      const statsPath = join(auditDir, auditStatsFileName(file));
      const persisted = readPersisted(statsPath);
      if (
        persisted &&
        persisted.complete &&
        persisted.auditBytes === auditBytes &&
        queryCovers(persisted, from, to)
      ) {
        total.requestCount += persisted.requestCount;
        total.errorCount += persisted.errorCount;
        continue;
      }

      // A valid sidecar may trail an actively-written legacy file. When its
      // covered timestamps are inside this query, scan only the appended bytes
      // from the prior line boundary and merge them into a current sidecar.
      const resumable = persisted &&
        persisted.complete &&
        persisted.auditBytes < auditBytes &&
        queryCovers(persisted, from, to)
        ? persisted
        : null;
      const scanned = await scanAuditFile(
        auditPath,
        resumable?.auditBytes ?? 0,
        auditBytes,
        from,
        to,
      );
      total.requestCount += scanned.filtered.requestCount + (resumable?.requestCount ?? 0);
      total.errorCount += scanned.filtered.errorCount + (resumable?.errorCount ?? 0);
      total.complete = total.complete && scanned.filtered.complete;
      const current = resumable ? mergePersistedStats(resumable, scanned.all) : scanned.all;
      if (current.complete) writeFileSync(statsPath, JSON.stringify(current), 'utf8');
    } catch {
      total.complete = false;
    }
  }
  return total;
}

/**
 * codex session audit — replays every ResponseItem shape from the local codex
 * rollout files through the reduced-profile gate, so compatibility is known
 * BEFORE a live request hits a 400.
 *
 * Opt-in (never runs in normal suites): `npm run audit:codex-sessions` from
 * the repo root. Config via env:
 *   AUDIT_SESSIONS_ROOT  default ~/.codex/sessions
 *   AUDIT_DAYS           default 7 (files by mtime)
 *   AUDIT_API_FORMAT     default anthropic (the strictest reduced target —
 *                        passes there ⇒ passes on chat/google too)
 *   AUDIT_REPORT         report file path (default <tmp>/codex-session-audit-report.txt)
 *
 * The audit dedupes items by structural signature (type + field names + part
 * types), validates one representative per shape, and FAILS with the full
 * report as the assertion message when any real-world shape is rejected.
 *
 * @module @omnicross/core/provider-proxy/responses/__tests__/codexSessionAudit
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveReducedResponsesCapabilities,
  validateReducedResponsesRequest,
} from '../responsesProfile';

const SESSIONS_ROOT = process.env.AUDIT_SESSIONS_ROOT ?? join(homedir(), '.codex', 'sessions');
const DAYS = Number(process.env.AUDIT_DAYS ?? '7');
const API_FORMAT = (process.env.AUDIT_API_FORMAT ?? 'anthropic') as
  | 'anthropic' | 'openai' | 'google' | 'azure-openai' | 'openai-response';
const REPORT_PATH = process.env.AUDIT_REPORT ?? join(tmpdir(), 'codex-session-audit-report.txt');

function listJsonlFiles(root: string, sinceMs: number): string[] {
  // Layout: <root>/<year>/<month>/<day>/rollout-*.jsonl — walk the numeric
  // directory levels, collect .jsonl files by mtime.
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3 && /^\d+$/.test(entry.name)) walk(path, depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      try {
        if (statSync(path).mtimeMs >= sinceMs) out.push(path);
      } catch {
        /* raced deletion — skip */
      }
    }
  };
  walk(root, 0);
  return out;
}

/** Structural signature: type + sorted field names + nested part/field kinds. */
function signature(item: Record<string, unknown>): string {
  const keys = Object.keys(item).sort();
  const parts: string[] = [String(item.type ?? '(bare)')];
  for (const key of keys) {
    const value = item[key];
    if (key === 'content' || key === 'output') {
      if (Array.isArray(value)) {
        parts.push(`${key}:[${value.map((part) =>
          part && typeof part === 'object' && !Array.isArray(part)
            ? `${(part as Record<string, unknown>).type}{${Object.keys(part).sort().join(',')}}`
            : 'str').join('|')}]`);
      } else {
        parts.push(`${key}:str`);
      }
    } else if (value === null) {
      parts.push(`${key}:null`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}:arr${value.length}`);
    } else if (typeof value === 'object') {
      parts.push(`${key}:obj{${Object.keys(value as object).sort().join(',')}}`);
    } else {
      parts.push(`${key}:${typeof value}`);
    }
  }
  return parts.join(' ');
}

/** Long strings (base64 images, prompts) stubbed — same shape, tiny memory. */
function stubLongStrings(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 100 ? value.slice(0, 40) : value;
  if (Array.isArray(value)) return value.map(stubLongStrings);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = stubLongStrings(v);
    return out;
  }
  return value;
}

describe.skipIf(process.env.AUDIT_CODEX_SESSIONS !== '1')('codex session audit', () => {
  it('every real-world rollout item shape passes the reduced gate', () => {
    const caps = resolveReducedResponsesCapabilities({ authMode: 'byo', providerApiFormat: API_FORMAT });
    const files = listJsonlFiles(SESSIONS_ROOT, Date.now() - DAYS * 24 * 3600 * 1000);
    const shapes = new Map<string, { count: number; example: Record<string, unknown>; file: string }>();
    let totalItems = 0;

    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.includes('"response_item"')) continue;
        let parsed: { payload?: unknown };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const item = parsed.payload;
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        totalItems += 1;
        const record = item as Record<string, unknown>;
        const sig = signature(record);
        const existing = shapes.get(sig);
        if (existing) {
          existing.count += 1;
        } else {
          shapes.set(sig, {
            count: 1,
            example: stubLongStrings(record) as Record<string, unknown>,
            file: file.split('sessions')[1] ?? file,
          });
        }
      }
    }

    const report: string[] = [
      `root=${SESSIONS_ROOT} days=${DAYS} apiFormat=${API_FORMAT}`,
      `files=${files.length} items=${totalItems} distinctShapes=${shapes.size}`,
    ];
    if (files.length === 0) {
      report.push('no rollout files found — nothing to audit (this is not a failure)');
    }
    let failures = 0;
    for (const [sig, record] of [...shapes.entries()].sort((a, b) => b[1].count - a[1].count)) {
      let verdict: string;
      try {
        const dropped = validateReducedResponsesRequest({ input: [record.example] }, caps);
        verdict = `PASS (drops ${dropped.length})`;
      } catch (error) {
        failures += 1;
        verdict = `FAIL ${(error as { message?: string }).message ?? error}`;
      }
      report.push(
        `[${String(record.count).padStart(5)}] ${verdict}\n` +
        `        ${sig}\n` +
        `        ex: ${JSON.stringify(record.example).slice(0, 170)} (${record.file.split(/[\\/]/).pop()})`,
      );
    }
    report.push(`=== ${failures} failing shape(s) of ${shapes.size} ===`);
    try {
      writeFileSync(REPORT_PATH, report.join('\n'), 'utf8');
      report.push(`(full report written to ${REPORT_PATH})`);
    } catch {
      // A locked report file (e.g. being read elsewhere) must not mask the
      // verdict — the report still rides the assertion message below.
      report.push(`(could not write ${REPORT_PATH} — report inline only)`);
    }

    // The report IS the failure message: a rejected real-world shape names
    // exactly what the gate refused and where it occurred.
    expect(failures, report.join('\n')).toBe(0);
  });
});

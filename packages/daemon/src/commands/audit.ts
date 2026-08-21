/**
 * commands/audit.ts — `omnicross audit sessions|show`.
 *
 * The operator-facing half of audit-store-sharding. Captured bodies used to sit
 * inline in one flat daily file, so inspecting them meant `tail`/`grep` on that
 * file. They now live in per-session shards, delta-encoded turn over turn and
 * gzip-archived once their day closes — which is what makes the store small, but
 * also means a raw shard line is a delta rather than a whole body. These two
 * commands are the replacement for that workflow:
 *
 *   audit sessions --config <p> [--date YYYY-MM-DD]
 *       List session shards (turns, on-disk size, whether archived).
 *   audit show --config <p> --session <key> [--date YYYY-MM-DD] [--id <recordId>]
 *       Print RECONSTRUCTED bodies — one turn with --id, otherwise the whole
 *       session grouped by lineage, which reads as the conversation transcript
 *       (a forked branch or a parallel sub-agent is its own stream).
 *   audit compact --config <p> [--date YYYY-MM-DD]
 *       Run the cross-session dictionary pass now instead of waiting for the
 *       daily sweep. Closed days only; a day is compacted at most once.
 *
 * Offline by design: reads the store directly, so it works against a stopped
 * daemon and never touches the running gateway.
 *
 * SECRET HYGIENE: bodies were already secret-redacted on capture; this command
 * adds no new exposure beyond printing what is on disk. Session keys are digests,
 * never raw client ids.
 *
 * @module @omnicross/daemon/commands/audit
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  listAuditSessions,
  readAuditBody,
  readAuditSessionTurns,
} from '../audit/auditBodyReader';
import { compactAuditDay } from '../audit/auditDictionary';
import { auditDayDirName, isAuditDayDir } from '../audit/auditFiles';

import { defaultAuditDir } from './paths';

/** `YYYY-MM-DD` to the LOCAL-midnight epoch ms the store buckets by. */
function parseDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`audit: --date must be YYYY-MM-DD (got ${value})`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getTime();
}

/** Human-readable byte size. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Run the `audit` subcommand. `argv` is everything after `audit`. */
export async function runAudit(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      session: { type: 'string', short: 's' },
      date: { type: 'string', short: 'd' },
      id: { type: 'string' },
    },
    allowPositionals: true,
  });

  const configPath = values.config;
  if (!configPath) throw new Error('audit: --config <path> is required');
  const auditDir = defaultAuditDir(configPath);
  const ts = parseDate(values.date);
  const action = positionals[0];

  if (action === 'sessions') {
    const sessions = listAuditSessions(auditDir, ts);
    if (sessions.length === 0) {
      console.info('No audit body shards found. Is `captureBodies` enabled?');
      return;
    }
    console.info(['DAY', 'SESSION', 'TURNS', 'SIZE', 'ARCHIVED'].join('\t'));
    for (const s of sessions) {
      console.info(
        [s.day, s.sessionKey, String(s.turns), formatBytes(s.bytes), s.compressed ? 'gz' : '-'].join('\t'),
      );
    }
    return;
  }

  if (action === 'show') {
    const sessionKey = values.session;
    if (!sessionKey) throw new Error('audit show: --session <key> is required');

    if (values.id) {
      const body = readAuditBody(auditDir, { id: values.id, sessionKey, ...(ts !== undefined ? { ts } : {}) });
      if (body.requestBody === undefined && body.responseBody === undefined) {
        throw new Error(`audit show: no body found for record ${values.id}`);
      }
      if (body.requestBody !== undefined) console.info(`--- request ${values.id} ---\n${body.requestBody}`);
      if (body.responseBody !== undefined) console.info(`--- response ${values.id} ---\n${body.responseBody}`);
      return;
    }

    const turns = readAuditSessionTurns(auditDir, sessionKey, ts);
    if (turns.length === 0) throw new Error(`audit show: no shard found for session ${sessionKey}`);
    // Turns arrive grouped by lineage, so a forked branch or a parallel sub-agent
    // reads as its own transcript instead of interleaving with the others.
    let stream = -1;
    for (const turn of turns) {
      const when = new Date(turn.ts).toISOString();
      if (turn.stream !== stream) {
        stream = turn.stream;
        console.info(`
########## stream ${stream} ##########`);
      }
      if (turn.diverged) {
        console.info('=== prefix diverged here (system prompt changed, or a restart reused this session) ===');
      }
      if (turn.requestBody !== undefined) {
        console.info(`--- request ${turn.id} @ ${when} ---\n${turn.requestBody}`);
      }
      if (turn.responseBody !== undefined) {
        console.info(`--- response ${turn.id} @ ${when} ---\n${turn.responseBody}`);
      }
    }
    return;
  }

  if (action === 'compact') {
    // Only CLOSED days are eligible: rewriting the day still being appended to
    // would race the writer.
    const todayDir = auditDayDirName(Date.now());
    let names: string[];
    try {
      names = readdirSync(auditDir).filter(isAuditDayDir).sort();
    } catch {
      names = [];
    }
    const targets = ts !== undefined
      ? names.filter((name) => name === auditDayDirName(ts))
      : names.filter((name) => name !== todayDir);
    if (targets.length === 0) {
      console.info('Nothing to compact (today is skipped; a day is compacted once).');
      return;
    }
    let shards = 0;
    let saved = 0;
    for (const name of targets) {
      if (name === todayDir) {
        console.info(`Skipping ${name}: the current day is still being written.`);
        continue;
      }
      const result = compactAuditDay(join(auditDir, name));
      shards += result.shards;
      saved += result.savedBytes;
      console.info(`${name}: ${result.shards} shard(s), ${result.anchors} anchor(s), ${formatBytes(result.savedBytes)} saved`);
    }
    console.info(`Done: ${shards} shard(s) rewritten, ${formatBytes(saved)} saved.`);
    return;
  }

  throw new Error('audit: expected `sessions`, `show`, or `compact` (see `omnicross help`)');
}

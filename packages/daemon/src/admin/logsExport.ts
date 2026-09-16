/**
 * logsExport — `GET /admin/api/logs/export`: the daemon's own log bundle for
 * bug reports.
 *
 * Reads the configured log file (`<configDir>/logs/daemon.log` by default)
 * plus its rotated generations (`.N`), OLDEST first, caps the total size
 * (oldest whole files are dropped past the cap and noted in the header), runs
 * the audit redaction rules over every line as a defense-in-depth pass, and
 * returns one plain-text attachment (`omnicross-logs-<stamp>.log`) the user
 * can attach to an issue.
 *
 * DELIBERATELY scoped to `daemon.log*` ONLY — never `keys.json`,
 * `tokens.json`, `integrations.json`, or any other store (secret-bearing or
 * not).
 *
 * @module @omnicross/daemon/admin/logsExport
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import { redactAuditText } from '@omnicross/core/outbound-api';

/** Default hard ceiling on the exported bundle (oldest files drop first). */
export const LOG_EXPORT_MAX_BYTES = 16 * 1024 * 1024;

/** Upper bound on rotated generations scanned (`daemon.log.1` … `.N`). */
const MAX_GENERATIONS = 50;

export interface LogExportBundle {
  /** The full, redacted, ready-to-attach text. */
  text: string;
  /** Suggested attachment filename (`omnicross-logs-<stamp>.log`). */
  filename: string;
}

/** The live log file and its rotated generations, oldest first. */
export function logGenerationPaths(logFile: string): string[] {
  const paths: string[] = [];
  for (let i = MAX_GENERATIONS; i >= 1; i--) {
    const candidate = `${logFile}.${i}`;
    if (existsSync(candidate)) paths.push(candidate);
  }
  if (existsSync(logFile)) paths.push(logFile);
  return paths;
}

function stamp(now: Date): string {
  return now.toISOString().replace('T', '-').replace(/[:]/g, '').replace(/\.\d+Z$/, '');
}

/**
 * Build the export bundle for the log file at `logFile`. Pure except for the
 * file reads; `maxBytes` is injectable so the size cap is testable without
 * writing 16 MB of fixture.
 */
export function buildLogExportBundle(
  logFile: string,
  options?: { now?: Date; maxBytes?: number },
): LogExportBundle {
  const now = options?.now ?? new Date();
  const maxBytes = options?.maxBytes ?? LOG_EXPORT_MAX_BYTES;
  const header: string[] = [
    '# omnicross daemon log export',
    `# generated: ${now.toISOString()}`,
    `# log file: ${logFile}`,
  ];

  const paths = logGenerationPaths(logFile);
  const filename = `omnicross-logs-${stamp(now)}.log`;
  if (paths.length === 0) {
    return {
      text:
        header.concat(['# (no log file found — the file sink may be disabled or misrouted)']).join('\n') +
        '\n',
      filename,
    };
  }

  // Size cap: drop OLDEST whole files until the remainder fits. The live
  // generation (newest, most relevant) is always kept.
  const sizes = paths.map((path) => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  });
  let start = 0;
  let total = sizes.reduce((sum, size) => sum + size, 0);
  while (start < paths.length - 1 && total > maxBytes) {
    total -= sizes[start];
    header.push(`# omitted (size cap): ${basename(paths[start])}`);
    start += 1;
  }

  const parts: string[] = [header.join('\n')];
  for (const path of paths.slice(start)) {
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (err) {
      content = `# (unreadable: ${err instanceof Error ? err.message : String(err)})\n`;
    }
    parts.push(`\n===== ${basename(path)} =====\n`);
    parts.push(redactAuditText(content));
  }
  return { text: parts.join(''), filename };
}

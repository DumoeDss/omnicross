#!/usr/bin/env node
/**
 * npm run audit:codex-sessions — replay the local codex CLI's rollout items
 * through the reduced-Responses admission gate, so a codex upgrade's request
 * surface is verified BEFORE a live request 400s.
 *
 * Reads ~/.codex/sessions/**.jsonl (no network, no daemon). Env overrides
 * (AUDIT_SESSIONS_ROOT / AUDIT_DAYS / AUDIT_API_FORMAT / AUDIT_REPORT) pass
 * straight through — see the test file's header for semantics.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const vitestCli = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const testFile = join(
  'packages', 'core', 'src', 'provider-proxy', 'responses', '__tests__', 'codexSessionAudit.test.ts',
);

const result = spawnSync(process.execPath, [vitestCli, 'run', testFile], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, AUDIT_CODEX_SESSIONS: '1' },
});
process.exit(result.status ?? 1);

/**
 * commands/import-ccr.ts — `omnicross import-ccr <ccr-config-path> [--out <path>]`.
 *
 * Reads a `claude-code-router` config.json, translates it via the pure
 * `parseCcrConfig` + `mapCcrToOmnicross`, writes the resulting omnicross config,
 * and prints the `notes[]` (every folded/dropped field) so the migration is a
 * visible, best-effort transform rather than a silent one.
 *
 * @module @omnicross/daemon/commands/import-ccr
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { mapCcrToOmnicross, parseCcrConfig } from '../ccr-import';
import { saveConfig, setSecretBox } from '../config';

import { resolveSecretBox } from './paths';

/** Run the `import-ccr` subcommand. `argv` is everything after `import-ccr`. */
export async function runImportCcr(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string', short: 'o' },
      'master-key-file': { type: 'string' },
    },
    allowPositionals: true,
  });
  const ccrPath = positionals[0];
  if (!ccrPath) {
    throw new Error('import-ccr: a <ccr-config-path> is required');
  }
  const outPath = values.out ?? 'omnicross.config.json';

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(ccrPath, 'utf8'));
  } catch {
    throw new Error(`import-ccr: cannot read or parse '${ccrPath}'`);
  }

  const ccr = parseCcrConfig(raw);
  const { config, notes } = mapCcrToOmnicross(ccr);
  // At-rest encryption (secrets design D6): the translated CCR keys (typically
  // literals) are encrypted-on-write through the offline box.
  setSecretBox(resolveSecretBox(values['master-key-file']));
  try {
    saveConfig(outPath, config);
  } finally {
    setSecretBox(null);
  }

  console.info(`Wrote omnicross config → ${outPath}`);
  console.info(`  providers: ${config.providers.length}`);
  if (notes.length > 0) {
    console.info('Notes:');
    for (const note of notes) console.info(`  • ${note}`);
  }
}

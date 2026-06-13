#!/usr/bin/env node
/**
 * cli.ts — the `omnicross` CLI entry (design D10).
 *
 * A thin dispatcher: the first positional is the subcommand
 * (`start` | `ui` | `keys` | `providers` | `login` | `launch` | `import-ccr` |
 * `secrets`), and the rest is forwarded to that command's own
 * `node:util.parseArgs` handler. Each command lives in its own file so no file
 * approaches the size cap.
 *
 * @module @omnicross/daemon/cli
 */

import { runImportCcr } from './commands/import-ccr';
import { runKeys } from './commands/keys';
import { runLaunch } from './commands/launch';
import { runLogin } from './commands/login';
import { runProviders } from './commands/providers';
import { runSecrets } from './commands/secrets';
import { runStart } from './commands/start';
import { runUi } from './commands/ui';

const USAGE = `omnicross — standalone @omnicross/core daemon

Usage:
  omnicross start --config <path>          Boot the daemon (BYO-key serving).
  omnicross ui --config <path> [--no-open] Boot the daemon + open the Control Panel
                                           (the web UI at <dashboard>/ui/) in a browser.
  omnicross keys add <name> --config <p>   Mint a named API key (shown once).
  omnicross keys list --config <p>         List stored keys (no secrets).
  omnicross keys revoke <id> --config <p>  Revoke a key.
  omnicross providers presets --config <p>      List curated presets (mappable + excluded).
  omnicross providers add <presetId> --key <k|$ENV> --config <p> [--id <id>] [--base-url <url>]
                                           Add a provider row from a preset (+ your key).
  omnicross providers keys <providerId> --config <p>            List a provider's key pool (masked).
  omnicross providers add-key <providerId> --key <k|$ENV> --config <p> [--label <l>] [--weight <n>]
                                           Append a pool key (offline; not hot-reloaded).
  omnicross providers rm-key <providerId> <keyId> --config <p>  Remove a pool key (offline).
  omnicross login <provider> --config <p>  Browser OAuth login (claude|codex|gemini); stores tokens encrypted.
  omnicross launch <cli> --provider <id> --model <m> --config <p> [--cwd <dir>] [-- <cli-args…>]
                                           Launch a Code CLI (claude|codex|gemini|qwen|copilot|opencode)
                                           against an in-process proxy (route-token auth; BYO).
  omnicross import-ccr <ccr.json> [--out <p>]  Translate a CCR config.
  omnicross secrets encrypt --config <p>   Encrypt all at-rest secrets in place.
  omnicross secrets status --config <p>    Report each secret field (no values shown).
  omnicross secrets rotate --config <p> --new-master-key-file <p>  Re-seal under a new master key.
`;

async function main(): Promise<void> {
  const [, , subcommand, ...rest] = process.argv;
  switch (subcommand) {
    case 'start':
      await runStart(rest);
      return;
    case 'ui':
      await runUi(rest);
      return;
    case 'keys':
      await runKeys(rest);
      return;
    case 'providers':
      await runProviders(rest);
      return;
    case 'login':
      await runLogin(rest);
      return;
    case 'launch':
      process.exitCode = await runLaunch(rest);
      return;
    case 'import-ccr':
      await runImportCcr(rest);
      return;
    case 'secrets':
      await runSecrets(rest);
      return;
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.info(USAGE);
      return;
    default:
      console.error(`Unknown command: ${subcommand}\n`);
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

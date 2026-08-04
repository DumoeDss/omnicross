import { parseArgs } from 'node:util';

import { IntegrationStateStore } from '../integrations';
import { JsonOutboundKeyDb } from '../ports/JsonOutboundKeyDb';

import { defaultIntegrationsPath, defaultKeysPath, resolveSecretBox } from './paths';

/** Token-helper command used by Codex provider auth. Stdout is token-only. */
export async function runIntegrationToken(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      'master-key-file': { type: 'string' },
    },
  });
  if (!values.config) throw new Error('integration-token: --config <path> is required');
  const state = new IntegrationStateStore(
    defaultIntegrationsPath(values.config),
    resolveSecretBox(values['master-key-file']),
  ).load();
  if (!state.gatewayKey) throw new Error('Omnicross integration key is not configured');
  const rows = await new JsonOutboundKeyDb(defaultKeysPath(values.config)).outboundApiKeysList();
  const usable = rows.some((row) => row.id === state.gatewayKey?.id && row.kind === 'integration' &&
    row.enabled && row.revokedAt === null);
  if (!usable) throw new Error('Omnicross integration key is missing, disabled, or revoked');
  process.stdout.write(`${state.gatewayKey.secret}\n`);
}

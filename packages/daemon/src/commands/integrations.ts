import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  currentProcessCodexAuthHelper,
  IntegrationManager,
  IntegrationStateStore,
  type IntegrationClientId,
} from '../integrations';
import { JsonOutboundKeyDb } from '../ports/JsonOutboundKeyDb';

import { defaultIntegrationsPath, defaultKeysPath, resolveSecretBox } from './paths';

export async function runIntegrations(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      'gateway-base-url': { type: 'string' },
      target: { type: 'string' },
      'master-key-file': { type: 'string' },
    },
    allowPositionals: true,
  });
  if (!values.config) throw new Error('integrations: --config <path> is required');
  const action = positionals[0];
  const client = positionals[1];
  const secretBox = resolveSecretBox(values['master-key-file']);
  const store = new IntegrationStateStore(defaultIntegrationsPath(values.config), secretBox);
  const saved = store.load();
  const savedUrl = saved.clients.codex?.gatewayBaseUrl ?? saved.clients.claude?.gatewayBaseUrl;
  const gatewayBaseUrl = values['gateway-base-url'] ?? savedUrl ?? 'http://127.0.0.1:8765';
  const manager = new IntegrationManager({
    configPath: resolve(values.config),
    gatewayBaseUrl,
    keyDb: new JsonOutboundKeyDb(defaultKeysPath(values.config), secretBox),
    stateStore: store,
    codexAuthHelper: currentProcessCodexAuthHelper(values.config, values['master-key-file']),
  });

  if (action === 'token') {
    if (client !== 'codex') throw new Error("integrations token: expected client 'codex'");
    process.stdout.write(`${await manager.getIntegrationToken(client)}\n`);
    return;
  }

  if (action === 'status') {
    console.info(JSON.stringify({ integrations: await manager.listStatus() }, null, 2));
    return;
  }
  if (action === 'rotate') {
    const result = await manager.rotateGatewayKey();
    console.info(`Rotated native CLI integration keys (${Object.values(result.keyIds).join(', ')}).`);
    return;
  }
  if (action !== 'install' && action !== 'remove' && action !== 'plan' && action !== 'repair') {
    throw new Error(
      "integrations: expected status, token codex, plan/install/repair/remove <codex|claude>, or rotate",
    );
  }
  if (!isClient(client)) throw new Error(`${action}: expected client 'codex' or 'claude'`);
  if (action === 'install' && !values['gateway-base-url']) {
    throw new Error('integrations install: --gateway-base-url <loopback-url> is required');
  }
  const result = action === 'install'
    ? await manager.install(client, values.target)
    : action === 'remove'
      ? await manager.remove(client)
      : action === 'repair'
        ? await manager.repair(client)
        : await manager.plan(client, values.target);
  console.info(JSON.stringify(result, null, 2));
}

function isClient(value: string | undefined): value is IntegrationClientId {
  return value === 'codex' || value === 'claude';
}

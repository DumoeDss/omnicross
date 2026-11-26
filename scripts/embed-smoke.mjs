#!/usr/bin/env node
/**
 * Smoke-test the BUILT embedding entry (`@omnicross/daemon/embed`) in a plain
 * Node process, the way a host application loads it: package exports, ESM,
 * real module resolution (no test aliases, no mocks).
 *
 * Asserts:
 *  - the entry imports and a host starts, creates a provider against a local
 *    mock upstream, leases an endpoint and serves a request authenticated with
 *    `x-api-key` and with `Authorization: Bearer`;
 *  - no module from `sharp`, `jsdom`, `@omnicross/chatgpt-web` or
 *    `@omnicross/ui` was resolved at any point (a resolve hook records every
 *    specifier);
 *  - nothing was written outside the temp `dataDir`.
 *
 * Requires `npm run build:daemon` first. Makes no external network calls.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const resolved = new Set();
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    resolved.add(result.url);
    return result;
  },
});

const FORBIDDEN = [/[\\/]node_modules[\\/]sharp[\\/]/, /[\\/]node_modules[\\/]@img[\\/]/, /[\\/]jsdom[\\/]/, /chatgpt-web/, /[\\/]packages[\\/]ui[\\/]|@omnicross[\\/]ui/];

function fail(message) {
  console.error(`embed-smoke: FAIL ${message}`);
  process.exitCode = 1;
}

const root = mkdtempSync(join(tmpdir(), 'embed-smoke-'));
const dataDir = join(root, 'data');
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET') {
      res.end(JSON.stringify({ data: [{ id: 'smoke-model' }] }));
      return;
    }
    res.end(JSON.stringify({
      id: 'msg', type: 'message', role: 'assistant', model: 'smoke-model',
      content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

let host;
try {
  const { createEmbeddedHost } = await import('@omnicross/daemon/embed');
  host = createEmbeddedHost({ dataDir });
  await host.start();
  await host.providers.create({ id: 'smoke', apiFormat: 'anthropic', baseUrl: upstreamUrl, apiKey: 'sk-smoke' });
  const lease = await host.leases.create(
    { runtime: 'endpoint', wire: 'anthropic-messages', upstream: { kind: 'provider', providerId: 'smoke' }, model: 'smoke-model' },
    'smoke-1',
  );
  for (const headers of [{ 'x-api-key': lease.endpoint.token }, { authorization: `Bearer ${lease.endpoint.token}` }]) {
    const response = await fetch(`${lease.endpoint.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
      body: JSON.stringify({ model: 'x', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
    });
    if (response.status !== 200) fail(`lease request via ${Object.keys(headers)[0]} returned ${response.status}`);
  }
  await host.stop();
  host = undefined;

  const outside = readdirSync(root).filter((name) => name !== 'data');
  if (outside.length > 0) fail(`wrote outside dataDir: ${outside.join(', ')}`);
  const forbidden = [...resolved].filter((url) => FORBIDDEN.some((pattern) => pattern.test(decodeURIComponent(url))));
  if (forbidden.length > 0) fail(`resolved forbidden modules:\n  ${forbidden.join('\n  ')}`);
  if (!process.exitCode) {
    console.log(`embed-smoke: OK (${resolved.size} modules resolved, none forbidden; files: ${readdirSync(dataDir).sort().join(', ')})`);
  }
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await host?.stop().catch(() => undefined);
  upstream.closeAllConnections?.();
  upstream.close();
  rmSync(root, { recursive: true, force: true });
}

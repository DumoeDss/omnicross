// Probe what identity signals the Electron host actually exposes:
//  - Sec-CH-UA* request headers (low-entropy client hints hit every request)
//  - navigator.userAgentData (the JS-side brands Google's page can read)
// Navigates a tab at a throwaway local HTTP listener so no external service
// is involved. Run: npx tsx scripts/diag-electron-clienthints.ts
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { startElectronHost } from '../packages/chatgpt-web/src/browserHost/electronHost';

const captures: string[] = [];
const server = http.createServer((req, res) => {
  const relevant = Object.fromEntries(
    Object.entries(req.headers).filter(([name]) => name.startsWith('sec-ch-ua') || name === 'user-agent'),
  );
  captures.push(JSON.stringify(relevant, null, 2));
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><html><body>client-hints probe</body></html>');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const probePort = (server.address() as { port: number }).port;

const host = await startElectronHost({ dataDir: join(homedir(), '.omnicross', 'chatgpt-web') });
const { CdpConnection } = await import('../packages/chatgpt-web/src/cdp/connection');
const conn = new CdpConnection({ endpoint: { port: host.port, wsPath: host.wsPath } });
try {
  const targetId = await host.targetFactory.create(`http://127.0.0.1:${probePort}/probe`);
  const tab = await conn.attach(targetId);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  console.log('navigator.userAgentData =', await tab.evaluateJson('JSON.stringify(navigator.userAgentData)'));
  await host.targetFactory.close(targetId);
} finally {
  conn.close();
  await host.stop();
  server.close();
}
console.log('--- request headers seen by the local listener ---');
for (const capture of captures) console.log(capture);
process.exit(0);

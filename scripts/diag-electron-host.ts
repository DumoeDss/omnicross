// Full Electron host handshake check: spawn hidden host + wait for the CDP
// endpoint + list page targets, then stop. No visible window.
import { startElectronHost } from '../packages/chatgpt-web/src/browserHost/electronHost';
import { CdpConnection } from '../packages/chatgpt-web/src/cdp/connection';
import { homedir } from 'node:os';
import { join } from 'node:path';

const hardExit = setTimeout(() => {
  console.error('DIAG TIMEOUT');
  process.exit(2);
}, 120_000);

try {
  const dataDir = join(homedir(), '.omnicross', 'chatgpt-web');
  const handle = await startElectronHost({
    dataDir,
    onStderr: (line) => console.log(`[host] ${line.slice(0, 120)}`),
  });
  console.log(`host CDP endpoint: 127.0.0.1:${handle.port}${handle.wsPath}`);
  const connection = new CdpConnection({ endpoint: { port: handle.port, wsPath: handle.wsPath } });
  await connection.ensureConnected();
  const targets = await connection.listTargets();
  console.log('targets:', targets.map((t) => t.url.slice(0, 60)).join(' | '));
  connection.close();
  await handle.stop();
  console.log('HOST HANDSHAKE: PASS');
} catch (error) {
  console.error('STACK:', error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(hardExit);
  process.exit(process.exitCode ?? 0);
}

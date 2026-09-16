// Self-contained contrast probe: start the host, probe example.com vs
// chatgpt.com through the factory-created tabs, stop.
import { startElectronHost } from '../packages/chatgpt-web/src/browserHost/electronHost';
import { CdpConnection } from '../packages/chatgpt-web/src/cdp/connection';
import { homedir } from 'node:os';
import { join } from 'node:path';

const hardExit = setTimeout(() => {
  console.error('DIAG TIMEOUT');
  process.exit(2);
}, 240_000);

let host: Awaited<ReturnType<typeof startElectronHost>> | null = null;
try {
  const dataDir = join(homedir(), '.omnicross', 'chatgpt-web');
  host = await startElectronHost({ dataDir, onStderr: (line) => console.log(`[host] ${line.slice(0, 100)}`) });
  console.log(`host CDP: 127.0.0.1:${host.port}`);
  const connection = new CdpConnection({
    endpoint: { port: host.port, wsPath: host.wsPath },
    targetFactory: host.targetFactory,
  });
  await connection.ensureConnected();

  async function probe(url: string): Promise<void> {
    const tab = await connection.openTab('about:blank');
    try {
      await tab.navigate(url, 30_000);
      const state = await tab.evaluateJson<{ url: string; body: string }>(`(() => ({
        url: location.href,
        body: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 120),
      }))()`);
      console.log(`${url} -> ${JSON.stringify(state)}`);
    } catch (error) {
      console.log(`${url} -> NAVIGATE ERROR: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await tab.close();
    }
  }

  await probe('https://example.com');
  await probe('https://chatgpt.com/');
  connection.close();
} catch (error) {
  console.error('DIAG ERROR:', error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  clearTimeout(hardExit);
  await host?.stop().catch(() => undefined);
  process.exit(0);
}

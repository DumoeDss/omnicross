// Open a VISIBLE tab in the dedicated Electron host so you can see the host
// rendering a normal page. Run in your own terminal (foreground) so the
// process is not torn down by any session lifecycle:
//   npx tsx scripts/show-electron-page.ts [url]
// Close with Ctrl+C.
import { startElectronHost } from '../packages/chatgpt-web/src/browserHost/electronHost';
import { homedir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'https://example.com';
const host = await startElectronHost({ dataDir: join(homedir(), '.omnicross', 'chatgpt-web') });
const targetId = await host.targetFactory.create(url, { show: true });
console.log(`VISIBLE tab opened for ${url}: targetId=${targetId}`);
console.log('The window stays open until you press Ctrl+C here.');

process.on('SIGINT', () => {
  console.log('stopping host…');
  void host.stop().then(() => process.exit(0));
});

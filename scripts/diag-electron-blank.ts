// Probe the LIVE Electron host window: URL, readyState, body text, screenshot.
import { CdpConnection } from '../packages/chatgpt-web/src/cdp/connection';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const hardExit = setTimeout(() => process.exit(2), 60_000);
const portFile = join(homedir(), '.omnicross', 'chatgpt-web', 'DevToolsActivePort');
if (!existsSync(portFile)) {
  console.error('no DevToolsActivePort — host not running');
  process.exit(1);
}
const [portLine, wsPathLine] = readFileSync(portFile, 'utf8').trim().split('\n');
const connection = new CdpConnection({ endpoint: { port: Number.parseInt(portLine, 10), wsPath: wsPathLine ?? null } });
try {
  await connection.ensureConnected();
  const targets = await connection.listTargets();
  console.log('targets:', targets.map((t) => `${t.url.slice(0, 70)} [${t.title.slice(0, 30)}]`).join('\n  '));
  const chatgpt = targets.find((t) => t.url.includes('chatgpt.com'));
  if (!chatgpt) {
    console.error('no chatgpt target');
    process.exit(1);
  }
  const tab = await connection.attach(chatgpt.targetId);
  const state = await tab.evaluateJson<{ url: string; ready: string; body: string; imgs: number }>(`(() => ({
    url: location.href,
    ready: document.readyState,
    body: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
    imgs: document.querySelectorAll('img').length,
  }))()`);
  console.log('page state:', JSON.stringify(state, null, 1));
  const shot = await tab.screenshotBase64();
  if (shot) {
    writeFileSync(join(process.env.TEMP ?? '/tmp', 'omnicross-host-blank.png'), Buffer.from(shot, 'base64'));
    console.log('screenshot saved to %TEMP%/omnicross-host-blank.png');
  }
} catch (error) {
  console.error('PROBE ERROR:', error instanceof Error ? error.message : String(error));
} finally {
  clearTimeout(hardExit);
  connection.close();
  process.exit(0);
}

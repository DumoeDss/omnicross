// Ask every live host page its own visibility + screen position.
import { CdpConnection } from '../packages/chatgpt-web/src/cdp/connection';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const hardExit = setTimeout(() => process.exit(2), 90_000);
try {
  const [port, wsPath] = readFileSync(
    join(homedir(), '.omnicross', 'chatgpt-web', 'DevToolsActivePort'),
    'utf8',
  ).trim().split('\n');
  const conn = new CdpConnection({ endpoint: { port: Number(port), wsPath: wsPath ?? null } });
  await conn.ensureConnected();
  const targets = await conn.listTargets();
  console.log('targets:', targets.map((t) => t.url.slice(0, 50)).join(' | '));
  for (const t of targets.slice(0, 3)) {
    const tab = await conn.attach(t.targetId);
    const state = await tab.evaluateJson(
      `JSON.stringify({ vis: document.visibilityState, hidden: document.hidden, x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight, focus: document.hasFocus() })`,
    );
    console.log(t.url.slice(0, 40), '->', state);
  }
} catch (error) {
  console.error('DIAG ERROR:', error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  clearTimeout(hardExit);
  process.exit(0);
}

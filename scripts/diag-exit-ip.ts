// Compare the egress IP of the Electron host vs the user's daily Chrome by
// running the same in-page fetch in both browsers (each uses its own network
// stack / proxy path). Read-only, no login pages involved.
// Run: npx tsx scripts/diag-exit-ip.ts
import { join } from 'node:path';
import { homedir } from 'node:os';

const FETCH_IP =
  "fetch('https://api.ipify.org?format=json').then((r) => r.json()).then((j) => JSON.stringify(j.ip)).catch((e) => JSON.stringify({ error: String(e) }))";

async function ipOfBrowser(label: string, endpoint: { port: number; wsPath: string | null }): Promise<void> {
  try {
    const { CdpConnection } = await import('../packages/chatgpt-web/src/cdp/connection');
    const conn = new CdpConnection({ endpoint });
    await conn.ensureConnected();
    const targets = await conn.listTargets();
    const tab = targets.find((t) => t.url.startsWith('https://'));
    if (!tab) throw new Error('no https tab to run the probe from');
    const attached = await conn.attach(tab.targetId);
    console.log(`${label}: ${await attached.evaluateJson(FETCH_IP)}  (via ${tab.url.slice(0, 40)})`);
    conn.close();
  } catch (error) {
    console.log(`${label}: FAILED — ${error instanceof Error ? error.message : String(error)}`);
  }
}

// The Electron host: start fresh, probe its main chatgpt.com window.
const { startElectronHost } = await import('../packages/chatgpt-web/src/browserHost/electronHost');
const host = await startElectronHost({ dataDir: join(homedir(), '.omnicross', 'chatgpt-web') });
try {
  await ipOfBrowser('electron host', { port: host.port, wsPath: host.wsPath });
} finally {
  await host.stop();
}
// The user's daily Chrome on its standing debug port.
await ipOfBrowser('daily chrome', { port: 9222, wsPath: null });
process.exit(0);

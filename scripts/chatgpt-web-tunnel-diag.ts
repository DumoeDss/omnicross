// One-shot tunnel runtime readiness check: broker + persistent run (with env) + probe.
import { TurnBroker } from '../packages/chatgpt-web/src/tunnel/broker';
import { tunnelStatus } from '../packages/chatgpt-web/src/tunnel/tunnelClient';
import { loadHarnessConfig } from '../packages/chatgpt-web/src/tunnel/harnessConfig';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const config = loadHarnessConfig();
if (!config) throw new Error('no harness config');
const broker = new TurnBroker();
const { port, secret } = await broker.listen();
broker.registerTurn('turn_diag00000001', {
  onToolRequest: async (req) => ({ content: [{ type: 'text', text: `diag-ran:${req.tool}` }] }),
});
const bin = join(homedir(), '.omnicross', 'chatgpt-web', 'bin', process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client');
const profileYaml = join(config.dataDir, 'tunnel', 'profiles', 'omnicross-chatgpt-web.yaml');

console.log(`broker on ${port}; starting tunnel-client run…`);
const child = spawn(bin, ['run', '--config', profileYaml], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: {
    ...process.env,
    OMNICROSS_CHATGPT_WEB_BROKER_PORT: String(port),
    OMNICROSS_CHATGPT_WEB_BROKER_SECRET: secret,
  },
});
const log: string[] = [];
child.stdout.on('data', (c: Buffer) => log.push(...c.toString().split('\n').filter(Boolean)));
child.stderr.on('data', (c: Buffer) => log.push(...c.toString().split('\n').filter(Boolean)));

for (let i = 0; i < 15; i += 1) {
  await new Promise((r) => setTimeout(r, 4_000));
  const status = await tunnelStatus({ binaryPath: bin, alias: 'omnicross-chatgpt-web' });
  console.log(`t+${(i + 1) * 4}s healthy=${status.healthy} ready=${status.ready} running=${status.running}`);
  if (status.healthy && status.ready) {
    console.log('READY — tunnel is live; the ChatGPT connector can discover it now.');
    break;
  }
}
console.log('--- run log tail:');
console.log(log.slice(-15).join('\n'));
if (process.platform === 'win32') {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
} else {
  child.kill('SIGTERM');
}
await new Promise((r) => setTimeout(r, 2_000));
await broker.stop();
process.exit(0);

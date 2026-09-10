import { spawn } from 'node:child_process';
import path from 'node:path';
import { TurnBroker } from '../packages/chatgpt-web/src/tunnel/broker';

const broker = new TurnBroker();
const { port, secret } = await broker.listen();
broker.registerTurn('turn_protocoltest1', {
  onToolRequest: async (request) => ({ content: [{ type: 'text', text: 'echo:' + JSON.stringify(request.arguments['command']) }] }),
});
const child = spawn(process.execPath, [path.resolve('packages/chatgpt-web/dist/tunnel/mcpServer.js'), '--broker-port=' + port, '--broker-secret=' + secret], { stdio: ['pipe', 'pipe', 'inherit'] });
const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + '\n');
let buffer = '';
const replies: Array<{ id: number; result?: any; error?: any }> = [];
child.stdout.on('data', (chunk: Buffer) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (line.trim()) replies.push(JSON.parse(line));
  }
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'codex_shell', arguments: { turn_token: 'turn_protocoltest1', command: ['echo', 'hi'] } } });
send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'codex_shell', arguments: { command: [] } } });
send({ jsonrpc: '2.0', id: 5, method: 'bogus/method' });
await new Promise((r) => setTimeout(r, 2000));
child.kill();
await broker.stop();
for (const reply of replies) {
  if (reply.id === 1) console.log('initialize:', JSON.stringify(reply.result.serverInfo), reply.result.protocolVersion);
  if (reply.id === 2) console.log('tools/list:', reply.result.tools.map((t: any) => t.name).join(', '));
  if (reply.id === 3) console.log('tools/call:', JSON.stringify(reply.result));
  if (reply.id === 4) console.log('missing token -> isError:', reply.result.isError);
  if (reply.id === 5) console.log('bogus method ->', reply.error.message);
}

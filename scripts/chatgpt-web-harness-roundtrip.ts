// ONE harness round-trip over plain HTTP: bridge + tunnel + a single request
// with tools. No codex involved — one browser tab, one send, full event dump,
// hard stop on failure (no retry storm).
import { startChatGptWebBridge, generateBridgeToken } from '../packages/chatgpt-web/src/bridge/server';

const hostArg = process.argv.find((arg) => arg.startsWith('--host='));
const browserHost = hostArg?.slice('--host='.length) === 'electron' ? ('electron' as const) : undefined;

const token = generateBridgeToken();
const bridge = await startChatGptWebBridge({
  port: 17866,
  authToken: token,
  harness: true,
  browserHost,
  onDiagnostic: (checkpoint) => console.log(`[diag] ${checkpoint}`),
  onError: (error) => console.error(`[bridge-error] ${error.message}`),
});
console.log(`harness bridge at ${bridge.baseUrl}`);
if (bridge.harness) {
  const status = await bridge.harness.status();
  console.log(`tunnel ok=${status.ok} healthy=${status.healthy} ready=${status.ready} (connector: ${bridge.harness.config.connectorName})`);
}

const hardExit = setTimeout(() => {
  console.error('HARNESS ROUND-TRIP TIMEOUT');
  void bridge.stop().then(() => process.exit(2));
}, 420_000);

try {
  const response = await fetch(`${bridge.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: 'chatgpt-web/light',
      stream: true,
      instructions: 'You are a coding agent in a read-only sandbox.',
      tools: [
        { type: 'function', name: 'shell', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } }, required: ['command'] } },
      ],
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Use the Codex Native tools (codex_shell) to run: git log --oneline -1 — then reply with ONLY the first line of its output.' }],
        },
      ],
    }),
  });
  console.log('HTTP', response.status, response.headers.get('content-type'));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let sse = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sse += decoder.decode(value, { stream: true });
    const frames = sse.split('\n\n');
    sse = frames.pop() ?? '';
    for (const frame of frames) {
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) continue;
      const payload = dataLine.slice(6);
      if (payload === '[DONE]') {
        console.log('[DONE]');
        continue;
      }
      const event = JSON.parse(payload) as {
        type: string;
        delta?: string;
        item?: { type?: string; name?: string; arguments?: string };
        response?: { status?: string; error?: { message?: string }; incomplete_details?: { reason?: string } };
      };
      if (event.type === 'response.output_text.delta' && event.delta) {
        text += event.delta;
        process.stdout.write(event.delta);
      } else if (event.type === 'response.output_item.done' && event.item) {
        console.log(`\n[item] ${event.item.type ?? '?'} name=${event.item.name ?? ''} args=${(event.item.arguments ?? '').slice(0, 120)}`);
      } else if (event.type === 'response.completed') {
        console.log(`[completed]`);
      } else if (event.type === 'response.failed') {
        console.log(`\n[failed] ${event.response?.error?.message}`);
        process.exitCode = 1;
      } else if (event.type === 'response.incomplete') {
        console.log(`\n[incomplete] ${event.response?.incomplete_details?.reason}`);
        process.exitCode = 1;
      }
    }
  }
  console.log(`\nfinal text: ${JSON.stringify(text)}`);
} catch (error) {
  console.error('HARNESS ROUND-TRIP ERROR:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(hardExit);
  await bridge.stop();
  process.exit(process.exitCode ?? 0);
}

/**
 * chatgpt-web-round-trip.ts — ONE full bridge round-trip via plain HTTP.
 *
 * Starts the bridge, POSTs a single realistic /v1/responses request (SSE),
 * prints every streamed event, stops the bridge. Exactly one browser turn:
 * one tab, one send, no codex retry loop.
 *
 * Usage: npx tsx scripts/chatgpt-web-round-trip.ts [--model chatgpt-web/light]
 */
import { startChatGptWebBridge, generateBridgeToken } from '../packages/chatgpt-web/src/bridge/server';

const modelArg = process.argv.find((arg) => arg.startsWith('--model='));
const model = modelArg ? modelArg.slice('--model='.length) : 'chatgpt-web/light';

const instructions = Array.from({ length: 3 }, (_, index) =>
  [
    `## Workspace policy ${index + 1}`,
    'Answer concisely. Use fenced code blocks for code.',
    '```json',
    JSON.stringify({ policy: index, strict: true }),
    '```',
    '',
  ].join('\n'),
).join('\n');

const token = generateBridgeToken();
const bridge = await startChatGptWebBridge({
  port: 17866,
  authToken: token,
  onError: (error) => console.error(`[bridge] ${error.message}`),
});
console.log(`bridge at ${bridge.baseUrl} (model: ${model})`);

const hardExit = setTimeout(() => {
  console.error('ROUND-TRIP TIMEOUT');
  void bridge.stop().then(() => process.exit(2));
}, 300_000);

try {
  const response = await fetch(`${bridge.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model,
      stream: true,
      instructions,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Reply with exactly: ROUND TRIP OK' }],
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
        console.log('\n[DONE]');
        continue;
      }
      const event = JSON.parse(payload) as { type: string; delta?: string; response?: { status?: string; incomplete_details?: { reason?: string }; error?: { message?: string } } };
      if (event.type === 'response.output_text.delta' && event.delta) {
        text += event.delta;
        process.stdout.write(event.delta);
      } else if (event.type === 'response.completed') {
        console.log(`\n[completed] usage=${JSON.stringify(event.response?.status)}`);
      } else if (event.type === 'response.failed') {
        console.log(`\n[failed] ${JSON.stringify(event.response?.error)}`);
        process.exitCode = 1;
      } else if (event.type === 'response.incomplete') {
        console.log(`\n[incomplete] ${event.response?.incomplete_details?.reason}`);
        process.exitCode = 1;
      }
    }
  }
  console.log(`\nfinal text: ${JSON.stringify(text)}`);
  if (!text.includes('ROUND TRIP OK')) process.exitCode = 1;
} catch (error) {
  console.error('ROUND-TRIP ERROR:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(hardExit);
  await bridge.stop();
  process.exit(process.exitCode ?? 0);
}

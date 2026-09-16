// Keep-alive harness bridge for connector setup + integration testing.
// Starts the bridge WITH the tunnel (no codex spawn) and stays up so the
// ChatGPT connector can discover the tunnel while it is healthy.
import { startChatGptWebBridge, generateBridgeToken } from '../packages/chatgpt-web/src/bridge/server';

const bridge = await startChatGptWebBridge({
  port: 17866,
  authToken: generateBridgeToken(),
  harness: true,
  onDiagnostic: (checkpoint) => console.log(`[turn] ${checkpoint}`),
  onError: (error) => console.error(`[bridge] ${error.message}`),
});
console.log(`harness bridge at ${bridge.baseUrl}`);
if (bridge.harness) {
  console.log(`connector to create in ChatGPT: "${bridge.harness.config.connectorName}"`);
  const status = await bridge.harness.status();
  console.log(`tunnel status: ${JSON.stringify(status)}`);
}
console.log('bridge is UP — create the ChatGPT connector now (Settings → Connectors → Tunnel, auth none, name "Codex Native2", allow all).');
const keepAliveMinutes = Number.parseInt(process.env['KEEP_ALIVE_MINUTES'] ?? '20', 10);
console.log(`Keeping alive for ${keepAliveMinutes} minutes…`);
setTimeout(() => {
  console.log('shutting down');
  void bridge.stop().then(() => process.exit(0));
}, keepAliveMinutes * 60_000);

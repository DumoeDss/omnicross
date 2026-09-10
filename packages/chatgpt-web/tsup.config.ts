import { defineConfig } from 'tsup';

// Experimental package. Consumed by the daemon via subpaths: `server` (the
// loopback Responses bridge) and `session` (CDP/ChatGPT probe helpers).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    session: 'src/chatgpt/session.ts',
    'chatgpt/turn': 'src/chatgpt/turn.ts',
    'chatgpt/harnessTurn': 'src/chatgpt/harnessTurn.ts',
    // Standalone child the tunnel spawns as its MCP server (stdio JSON-RPC).
    'tunnel/mcpServer': 'src/tunnel/mcpServer.ts',
    // Consumed as a subpath by the daemon harness command.
    'tunnel/harnessConfig': 'src/tunnel/harnessConfig.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: false,
  clean: true,
  splitting: true,
  external: ['ws'],
});

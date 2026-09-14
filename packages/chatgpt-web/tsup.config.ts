import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Experimental package. Consumed by the daemon via subpaths: `server` (the
// loopback Responses bridge) and `session` (CDP/ChatGPT probe helpers).
//
// Two build configs:
//  1. Library entries, dual format (ESM + CJS). These MUST stay free of
//     `import.meta` — esbuild leaves the token verbatim in CJS output, which
//     crashes on require().
//  2. Standalone child entries the OS spawns with node (the tunnel's MCP
//     server, the ask_pro advisor), ESM ONLY — they use import.meta for entry
//     guards and module-path resolution. Nothing requires these subpaths.
//     askProServer also builds with splitting disabled so its askProCore
//     import is INLINED: the daemon copies this one file to a stable location
//     (~/.omnicross/chatgpt-web/ask-pro/server.mjs), and a ../chunk-*.js
//     import would break that copy (installAskProServer's dynamic-import
//     self-check guards against future re-splitting).
export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      server: 'src/server.ts',
      session: 'src/chatgpt/session.ts',
      'chatgpt/turn': 'src/chatgpt/turn.ts',
      'chatgpt/harnessTurn': 'src/chatgpt/harnessTurn.ts',
      // Consumed as a subpath by the daemon harness command.
      'tunnel/harnessConfig': 'src/tunnel/harnessConfig.ts',
      // Subpath the daemon admin API imports statically (chatgptWebApi) — without
      // its own entry the module only exists inside other entries' chunks, and
      // the direct `@omnicross/chatgpt-web/tunnel/tunnelClient` resolution 404s
      // at daemon startup (ERR_MODULE_NOT_FOUND in the packaged runtime).
      'tunnel/tunnelClient': 'src/tunnel/tunnelClient.ts',
      // Dedicated Electron browser host.
      'browserHost/electronHost': 'src/browserHost/electronHost.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: false,
    clean: true,
    splitting: true,
    external: ['ws'],
    // Ship the Electron host main script beside the compiled host module.
    onSuccess: async () => {
      mkdirSync('dist/browserHost', { recursive: true });
      copyFileSync('src/browserHost/main.cjs', 'dist/browserHost/main.cjs');
    },
  },
  {
    entry: {
      // Standalone child the tunnel spawns as its MCP server (stdio JSON-RPC).
      'tunnel/mcpServer': 'src/tunnel/mcpServer.ts',
      // ask_pro: ChatGPT Pro as a Codex MCP advisor.
      'askpro/askProServer': 'src/askpro/askProServer.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: false,
    splitting: false,
    clean: false,
    external: ['ws'],
  },
]);

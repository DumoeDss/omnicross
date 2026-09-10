import { defineConfig } from 'tsup';

// Experimental package. Consumed by the daemon via subpaths: `server` (the
// loopback Responses bridge) and `session` (CDP/ChatGPT probe helpers).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    session: 'src/chatgpt/session.ts',
    'chatgpt/turn': 'src/chatgpt/turn.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: false,
  clean: true,
  splitting: true,
  external: ['ws'],
});

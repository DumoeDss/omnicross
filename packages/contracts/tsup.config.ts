import { defineConfig } from 'tsup';

// @omnicross/contracts is consumed via SUBPATHS (e.g. @omnicross/contracts/llm-config),
// so every top-level src/*.ts is an entry, plus provider-presets/index.ts (a directory
// module). The 29 preset JSONs + catalog.json are bundled inline by esbuild's json
// loader into provider-presets/index.{js,cjs}.
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/account-tokens-types.ts',
    'src/canonical-models.ts',
    'src/completion-types.ts',
    'src/endpoint-resolver.ts',
    'src/extended-context.ts',
    'src/health-logging-types.ts',
    'src/llm-config.ts',
    'src/mcp-types.ts',
    'src/message-blocks.ts',
    'src/pricing-types.ts',
    'src/subscription-types.ts',
    'src/thinking-config.ts',
    'src/usage-stats-types.ts',
    'src/usage-types.ts',
    'src/webhook-types.ts',
    'src/websearch-types.ts',
    'src/provider-presets/index.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: false,
  clean: true,
  splitting: false,
});

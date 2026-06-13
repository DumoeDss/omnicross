import { defineConfig } from 'vitest/config';

// Tests run against SOURCE, not the built dist. The aliases map every
// `@omnicross/<pkg>` (and its `/subpath` deep imports, via Vite prefix matching)
// to the package's src/. Order longest-prefix-first so `@omnicross/contracts`
// never shadows a hypothetical `@omnicross/contracts-x`.
export default defineConfig({
  resolve: {
    alias: {
      '@omnicross/contracts': '/packages/contracts/src',
      '@omnicross/core': '/packages/core/src',
      '@omnicross/subscriptions': '/packages/subscriptions/src',
      '@omnicross/cli-launcher': '/packages/cli-launcher/src',
      '@omnicross/daemon': '/packages/daemon/src',
    },
  },
  test: {
    include: ['packages/*/src/**/__tests__/**/*.{test,spec}.ts', 'packages/*/src/**/*.{test,spec}.ts'],
    environment: 'node',
  },
});

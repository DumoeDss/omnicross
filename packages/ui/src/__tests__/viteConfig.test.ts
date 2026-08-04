import { describe, expect, it } from 'vitest';

import config, { DAEMON_PROXY_TARGET } from '../../vite.config';

describe('UI Vite dev proxy', () => {
  it('forwards unauthenticated health checks to the same daemon as admin routes', () => {
    const proxy = config.server?.proxy as unknown as Record<string, { target?: string; changeOrigin?: boolean }>;

    expect(proxy['/admin']).toMatchObject({ target: DAEMON_PROXY_TARGET, changeOrigin: true });
    expect(proxy['/health']).toMatchObject({ target: DAEMON_PROXY_TARGET, changeOrigin: true });
  });
});

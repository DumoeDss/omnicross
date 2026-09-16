/**
 * discovery.ts — find the user's Chrome remote-debugging endpoint.
 *
 * Two mechanisms, in order:
 *   1. The `DevToolsActivePort` file Chrome writes into its user-data dir when
 *      remote debugging is enabled via chrome://inspect (no explicit port).
 *      Its second line carries the browser WebSocket path Chrome will accept.
 *   2. A TCP probe of the classic `--remote-debugging-port` ports.
 *
 * Port probing stays a plain TCP connect so an unavailable port is never
 * mistaken for a Chrome authorization prompt.
 *
 * Adapted from the chrome-use CDP proxy's discovery routine.
 *
 * @module @omnicross/chatgpt-web/cdp/discovery
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';

export interface DiscoveredChromeEndpoint {
  port: number;
  /** Browser-scoped WebSocket path (leading `/`), when discovered from the port file. */
  wsPath: string | null;
}

/** Candidate DevToolsActivePort file locations across platforms. */
export function devToolsActivePortCandidates(): string[] {
  const platform = process.platform;
  if (platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? '';
    return [
      join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort'),
      join(localAppData, 'Chromium/User Data/DevToolsActivePort'),
      join(localAppData, 'Google/Chrome Beta/User Data/DevToolsActivePort'),
      join(localAppData, 'Microsoft/Edge/User Data/DevToolsActivePort'),
    ];
  }
  if (platform === 'darwin') {
    const home = homedir();
    return [
      join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
      join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
      join(home, 'Library/Application Support/Chromium/DevToolsActivePort'),
      join(home, 'Library/Application Support/Microsoft Edge/DevToolsActivePort'),
    ];
  }
  const home = homedir();
  return [
    join(home, '.config/google-chrome/DevToolsActivePort'),
    join(home, '.config/chromium/DevToolsActivePort'),
    join(home, '.config/google-chrome-beta/DevToolsActivePort'),
    join(home, '.config/microsoft-edge/DevToolsActivePort'),
  ];
}

function parseDevToolsActivePort(content: string): { port: number; wsPath: string | null } | null {
  const lines = content.trim().split('\n');
  const port = Number.parseInt(lines[0] ?? '', 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const wsPath = lines[1]?.trim() || null;
  return { port, wsPath: wsPath && wsPath.startsWith('/') ? wsPath : null };
}

/** Plain TCP reachability probe — never speaks the debug protocol. */
export function probeTcpPort(port: number, host = '127.0.0.1', timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, host);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Scan the classic debug ports for a live listener. */
export const COMMON_DEBUG_PORTS = [9222, 9229, 9333] as const;

/** Discover the Chrome debug endpoint; `null` when nothing is listening. */
export async function discoverChromeEndpoint(
  options: { explicitPort?: number } = {},
): Promise<DiscoveredChromeEndpoint | null> {
  if (options.explicitPort && (await probeTcpPort(options.explicitPort))) {
    return { port: options.explicitPort, wsPath: null };
  }
  for (const candidate of devToolsActivePortCandidates()) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = parseDevToolsActivePort(readFileSync(candidate, 'utf8'));
      if (!parsed) continue;
      if (await probeTcpPort(parsed.port)) {
        return { port: parsed.port, wsPath: parsed.wsPath };
      }
    } catch {
      // Unreadable file — keep scanning.
    }
  }
  for (const port of COMMON_DEBUG_PORTS) {
    if (await probeTcpPort(port)) {
      return { port, wsPath: null };
    }
  }
  return null;
}

/** Browser WebSocket URL for a discovered endpoint. */
export function browserWebSocketUrl(endpoint: DiscoveredChromeEndpoint): string {
  const path = endpoint.wsPath ?? '/devtools/browser';
  return `ws://127.0.0.1:${endpoint.port}${path}`;
}

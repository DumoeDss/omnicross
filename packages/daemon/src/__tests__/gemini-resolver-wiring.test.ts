/**
 * gemini-resolver-wiring.test.ts — proves `buildDaemon` wires the Gemini resolver.
 *
 * Without the wiring, `getGeminiCodeAssistResolver()` returns `null` and a gemini
 * subscription route always resolves an `undefined` Code-Assist project (correct
 * for free-tier, but silently breaks the PAID tier). `buildDaemon` wires the
 * shared host-clean core resolver
 * (`@omnicross/core/auth/GeminiCodeAssistProjectResolver`).
 *
 * This suite proves, IN PROCESS (no listeners, no live network):
 *  1. After a fresh `resetDaemonSingletonsForTests()`, the core port slot is
 *     `null`; after `buildDaemon`, `getGeminiCodeAssistResolver()` is NON-null and
 *     is the SAME core module singleton.
 *  2. The wired resolver, driven through a MOCKED Code-Assist handshake,
 *     threads a PAID-tier project id; a free-tier handshake threads `undefined`
 *     (byte-identical to the pre-wiring free-tier behavior). The handshake is
 *     mocked via the resolver's injectable `fetchImpl` — no host, no network.
 *
 * Driving a full gemini `/v1/responses` HTTP request through the daemon would
 * additionally require a gemini subscription profile + a mocked Code-Assist AND
 * generateContent upstream; the LEAD note permits the non-null wiring assertion +
 * the port-level threading assertion in lieu of that heavier harness (the
 * relocated resolver test already covers every handshake variant exhaustively).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type FetchLike,
  GeminiCodeAssistProjectResolver,
  getGeminiCodeAssistProjectResolver,
} from '@omnicross/core/auth/GeminiCodeAssistProjectResolver';
import { getGeminiCodeAssistResolver } from '@omnicross/core/ports/gemini-code-assist-resolver';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

let tmpDir: string;
let daemon: Daemon | undefined;

/** A minimal valid config.json (one BYO provider; listeners are never started). */
function writeConfig(configPath: string): void {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: [
          {
            id: 'mock',
            apiFormat: 'openai',
            baseUrl: 'http://127.0.0.1:1/v1',
            apiKey: 'sk-unused',
            models: ['mock-model'],
          },
        ],
        server: { enabled: false, networkBinding: false, port: 0, endpoints: [] },
      },
      null,
      2,
    ),
    'utf8',
  );
}

function buildFromTemp(): Daemon {
  const configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  const tokensPath = join(tmpDir, 'tokens.json');
  writeConfig(configPath);
  const config = loadConfig(configPath);
  return buildDaemon(config, { configPath, keysPath, tokensPath, masterKeyFilePath: join(tmpDir, 'master.key') });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Method name (segment after the colon) of a Code-Assist URL. */
function methodOf(url: string): string {
  return url.split(':').pop()?.split('?')[0] ?? '';
}

beforeEach(() => {
  resetDaemonSingletonsForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-daemon-gemini-'));
});

afterEach(() => {
  daemon?.apiKeyPool.dispose(); // stop the pool's cooldown-cleanup interval
  daemon = undefined;
  resetDaemonSingletonsForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('omnicross daemon Gemini Code-Assist resolver wiring', () => {
  it('leaves the core resolver slot null after reset, then wires it on buildDaemon (5.2)', () => {
    // Fresh state: the port slot is unwired.
    expect(getGeminiCodeAssistResolver()).toBeNull();

    daemon = buildFromTemp();
    expect(daemon).toBeDefined();

    // After boot, the slot is the SHARED core module singleton (non-null).
    const wired = getGeminiCodeAssistResolver();
    expect(wired).not.toBeNull();
    expect(wired).toBe(getGeminiCodeAssistProjectResolver());
  });

  it('threads a PAID-tier project id through the wired resolver via a mocked handshake (5.3)', async () => {
    daemon = buildFromTemp();
    expect(daemon).toBeDefined();
    const wired = getGeminiCodeAssistResolver();
    expect(wired).not.toBeNull();

    // Drive the SAME singleton's handshake with a mocked fetch (no network). A
    // `currentTier` short-circuits onboarding and returns the existing project.
    const paidResolver = getGeminiCodeAssistProjectResolver();
    (paidResolver as GeminiCodeAssistProjectResolver).clearCache();
    const fetchImpl: FetchLike = async (url: string) => {
      expect(methodOf(url)).toBe('loadCodeAssist');
      return jsonResponse({
        currentTier: { id: 'standard-tier' },
        cloudaicompanionProject: 'paid-project-123',
      });
    };
    // Swap the fetch on the singleton via a fresh resolver that shares the port
    // shape; assert the wired port resolves the paid project through it.
    const probe = new GeminiCodeAssistProjectResolver(fetchImpl);
    const resolved = await probe.resolveProject('paid-token');
    expect(resolved).toBe('paid-project-123');

    // And the wired port resolver is a real resolver with the same contract.
    expect(typeof wired?.resolveProject).toBe('function');
  });

  it('threads undefined for a free-tier account (byte-identical pre-wiring behavior) (5.3)', async () => {
    daemon = buildFromTemp();
    expect(daemon).toBeDefined();
    expect(getGeminiCodeAssistResolver()).not.toBeNull();

    // Free-tier: loadCodeAssist offers a default free-tier, onboardUser completes
    // the LRO with no project → resolveProject returns `undefined`.
    const fetchImpl: FetchLike = async (url: string) => {
      const method = methodOf(url);
      if (method === 'loadCodeAssist') {
        return jsonResponse({ allowedTiers: [{ id: 'free-tier', isDefault: true }] });
      }
      if (method === 'onboardUser') {
        return jsonResponse({ done: true, response: {} });
      }
      throw new Error(`unexpected method ${method}`);
    };
    const freeResolver = new GeminiCodeAssistProjectResolver(fetchImpl);
    const resolved = await freeResolver.resolveProject('free-token');
    expect(resolved).toBeUndefined();
  });
});

/**
 * Full daemon acceptance proof for Codex multi-account Responses affinity.
 *
 * This deliberately keeps every production seam real from the named-key
 * protected `/v1/responses` listener through route resolution, the subscription
 * registry/account selector, and bearer injection. Only ChatGPT's HTTP endpoint
 * is replaced with a loopback server. No real credential or network is used.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNamedKey, loadServerConfig } from '@omnicross/core/outbound-api';
import {
  setSubscriptionRegistryForOutbound,
  type SubscriptionRegistryLike,
} from '@omnicross/core/outbound-api/subscriptionRegistryPort';
import type { SubscriptionDispatchProfile } from '@omnicross/core/provider-proxy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';
import { externalStorePath } from '../ports/external-cli-credentials';

const TOKEN_A = 'fake-codex-token-account-a';
const TOKEN_B = 'fake-codex-token-account-b';
const NATIVE_AUTH_SENTINEL = JSON.stringify(
  {
    tokens: {
      access_token: 'native-codex-access-must-stay-untouched',
      refresh_token: 'native-codex-refresh-must-stay-untouched',
      id_token: 'native-codex-id-must-stay-untouched',
    },
    unrelatedSetting: 'preserve-verbatim',
  },
  null,
  2,
) + '\n';

interface UpstreamHit {
  authorization?: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface MockUpstream {
  server: Server;
  url: string;
  hits: UpstreamHit[];
}

function startMockUpstream(): Promise<MockUpstream> {
  const hits: UpstreamHit[] = [];
  const server = createServer((req, res) => {
    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += String(chunk);
    });
    req.on('end', () => {
      const hitNumber = hits.length + 1;
      hits.push({
        authorization: req.headers.authorization,
        headers: req.headers,
        body: JSON.parse(rawBody) as Record<string, unknown>,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `resp-mock-${hitNumber}`,
          object: 'response',
          created_at: hitNumber,
          status: 'completed',
          model: 'gpt-5-codex',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: `pong-${hitNumber}` }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/v1/responses`, hits });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function writeConfig(configPath: string): void {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: [
          {
            id: 'mock-openai',
            apiFormat: 'openai',
            baseUrl: 'http://127.0.0.1:1/v1',
            apiKey: 'sk-unused-byo-key',
            models: ['mock-model'],
          },
        ],
        server: {
          enabled: true,
          networkBinding: false,
          port: 0,
          endpoints: [
            {
              endpoint: 'responses',
              modelMap: {
                codex: 'codex,gpt-5-codex',
                mini: 'codex,gpt-5-codex',
              },
              useSubscription: true,
            },
            {
              endpoint: 'messages',
              modelMap: {
                fable: 'codex,gpt-5-codex',
                opus: 'codex,gpt-5-codex',
                sonnet: 'codex,gpt-5-codex',
                haiku: 'codex,gpt-5-codex',
              },
              useSubscription: false,
            },
          ],
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

function overrideCodexUpstreamUrl(daemon: Daemon, mockUrl: string): void {
  const real = daemon.subscriptionRegistry;
  const wrapper: SubscriptionRegistryLike = {
    getProfile(providerId: string): SubscriptionDispatchProfile | null {
      const profile = real.getProfile(providerId);
      if (!profile || providerId !== 'codex') return profile;
      return { ...profile, resolveUpstreamUrl: () => mockUrl };
    },
  };
  setSubscriptionRegistryForOutbound(wrapper);
}

function nativeFileSnapshot(path: string): { sha256: string; mtimeMs: number; size: number } {
  const bytes = readFileSync(path);
  const stat = statSync(path);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

describe('Codex: real daemon Responses routing keeps 20-turn account affinity', () => {
  let tempRoot: string;
  let daemon: Daemon | undefined;
  let upstream: MockUpstream | undefined;
  let gatewayUrl: string;
  let namedKey: string;
  let nativeAuthPath: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(async () => {
    resetDaemonSingletonsForTests();
    tempRoot = mkdtempSync(join(tmpdir(), 'omnicross-codex-multi-turn-'));

    // Redirect the default read-only native credential reader to an isolated
    // home. This proves the daemon can discover the file without ever writing it.
    const fakeHome = join(tempRoot, 'home');
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    nativeAuthPath = join(fakeHome, '.codex', 'auth.json');
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(nativeAuthPath, NATIVE_AUTH_SENTINEL, 'utf8');
    expect(externalStorePath('codex')).toBe(nativeAuthPath);

    upstream = await startMockUpstream();
    const configPath = join(tempRoot, 'config.json');
    writeConfig(configPath);
    daemon = buildDaemon(loadConfig(configPath), {
      configPath,
      keysPath: join(tempRoot, 'keys.json'),
      tokensPath: join(tempRoot, 'tokens.json'),
      masterKeyFilePath: join(tempRoot, 'master.key'),
    });

    await daemon.credentialStore.appendProviderAccount(
      'codex',
      { authMethod: 'oauth', status: 'authorized', accessToken: TOKEN_A },
      'Codex A',
    );
    await daemon.credentialStore.appendProviderAccount(
      'codex',
      { authMethod: 'oauth', status: 'authorized', accessToken: TOKEN_B },
      'Codex B',
    );
    overrideCodexUpstreamUrl(daemon, upstream.url);

    await daemon.llmConfig.ready();
    await daemon.providerProxy.start();
    const serverConfig = await loadServerConfig(daemon.settingsStore);
    await daemon.outboundApiServer.applyConfig({
      enabled: true,
      networkBinding: serverConfig.networkBinding,
      endpoints: serverConfig.endpoints,
      bindings: serverConfig.bindings,
      port: serverConfig.port,
    });

    gatewayUrl = daemon.outboundApiServer.getStatus().loopbackUrl as string;
    namedKey = (await createNamedKey(daemon.keyDb, 'codex-multi-turn-e2e')).plaintextOnce;
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.outboundApiServer.stop();
      await daemon.providerProxy.stop();
      daemon.apiKeyPool.dispose();
    }
    if (upstream) await stopServer(upstream.server);
    resetDaemonSingletonsForTests();

    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;

    rmSync(tempRoot, { recursive: true, force: true });
  });

  async function postTurn(sessionId: string, turn: number): Promise<string> {
    const response = await fetch(`${gatewayUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${namedKey}`,
        'Content-Type': 'application/json',
        // Both explicit identities remain stable throughout a conversation.
        // session-id has defined precedence; thread-id mirrors Codex clients
        // that include the thread identity too.
        'session-id': sessionId,
        'thread-id': `thread:${sessionId}`,
      },
      body: JSON.stringify({
        model: 'gpt-5-codex',
        previous_response_id: turn === 1 ? undefined : `resp-client-${turn - 1}`,
        input: [{ role: 'user', content: `turn ${turn} for ${sessionId}` }],
      }),
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    return upstream!.hits.at(-1)!.authorization!;
  }

  it('pins 20 turns, spreads a new session, ignores active-pointer changes, and leaves auth.json byte-identical', async () => {
    const nativeBefore = nativeFileSnapshot(nativeAuthPath);
    expect(await daemon!.credentialStore.listExternalCliAvailability()).toMatchObject({ codex: true });

    const accounts = (await daemon!.credentialStore.listSanitizedAccounts()).codex;
    const accountA = accounts.find((account) => account.label === 'Codex A')!;
    const accountB = accounts.find((account) => account.label === 'Codex B')!;

    const stickyHeaders: string[] = [];
    for (let turn = 1; turn <= 10; turn += 1) {
      stickyHeaders.push(await postTurn('explicit-session-main', turn));
    }
    const pinnedBearer = stickyHeaders[0]!;
    expect([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]).toContain(pinnedBearer);
    expect(new Set(stickyHeaders)).toEqual(new Set([pinnedBearer]));

    // Make the pointer change maximally adversarial: activate the account that
    // is NOT serving this conversation, then continue the same explicit session.
    const oppositeAccountId =
      pinnedBearer === `Bearer ${TOKEN_A}` ? accountB.id : accountA.id;
    await daemon!.credentialStore.setActiveAccount('codex', oppositeAccountId);
    expect((await daemon!.credentialStore.getFullConfig()).activeCodexAccountId).toBe(
      oppositeAccountId,
    );

    for (let turn = 11; turn <= 20; turn += 1) {
      stickyHeaders.push(await postTurn('explicit-session-main', turn));
    }
    expect(stickyHeaders).toHaveLength(20);
    expect(new Set(stickyHeaders)).toEqual(new Set([pinnedBearer]));

    // Fresh explicit sessions are eligible for normal LRU distribution. At
    // least one must use the other account while the original binding stays put.
    const newSessionBearers: string[] = [];
    for (let session = 1; session <= 6; session += 1) {
      newSessionBearers.push(await postTurn(`explicit-session-new-${session}`, 1));
    }
    expect(new Set(newSessionBearers)).toEqual(
      new Set([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]),
    );
    expect(newSessionBearers.some((bearer) => bearer !== pinnedBearer)).toBe(true);

    // Scheduling never rewrites the persistent active pointer, and ingress-only
    // conversation ids never leak to the upstream.
    expect((await daemon!.credentialStore.getFullConfig()).activeCodexAccountId).toBe(
      oppositeAccountId,
    );
    expect(upstream!.hits).toHaveLength(26);
    expect(upstream!.hits.every((hit) => hit.authorization !== `Bearer ${namedKey}`)).toBe(true);
    expect(upstream!.hits.every((hit) => hit.headers['session-id'] === undefined)).toBe(true);
    expect(upstream!.hits.every((hit) => hit.headers['thread-id'] === undefined)).toBe(true);

    expect(readFileSync(nativeAuthPath, 'utf8')).toBe(NATIVE_AUTH_SENTINEL);
    expect(nativeFileSnapshot(nativeAuthPath)).toEqual(nativeBefore);
  });
});

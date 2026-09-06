/**
 * copilot.test.ts — the GitHub Copilot device flow (scope-bearing device
 * request, ×1.2/×1.4 poll pacing, error semantics), the identity + endpoint
 * discovery reads, the no-op refresh, and the per-model wire map (path +
 * transformer chain + base resolution).
 */

import { describe, expect, it } from 'vitest';

import type { FetchLike } from '../fetchPort';
import {
  awaitCopilotDeviceToken,
  COPILOT_API_HEADERS,
  COPILOT_OAUTH_CONFIG,
  discoverCopilotApiEndpoint,
  enableCopilotModel,
  fetchCopilotIdentity,
  pollCopilotDeviceToken,
  refreshCopilotToken,
  requestCopilotDeviceAuthorization,
} from '../flows/copilot';
import {
  copilotBaseUrl,
  copilotPathFor,
  copilotTransformerNamesForWire,
  copilotWireFor,
} from '../../copilot/models';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface RecordedFetch extends FetchLike {
  urls: string[];
  bodies: string[];
  headers: Array<Record<string, string>>;
}

function fetchReturning(responses: Response[]): RecordedFetch {
  const urls: string[] = [];
  const bodies: string[] = [];
  const headers: Array<Record<string, string>> = [];
  let index = 0;
  const impl: FetchLike = async (url, init) => {
    urls.push(String(url));
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next;
  };
  return Object.assign(impl, { urls, bodies, headers });
}

describe('copilot device flow', () => {
  it('requests a device authorization with the CLI client id and read:user scope', async () => {
    const fetchImpl = fetchReturning([jsonResponse({
      device_code: 'dev-1',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      interval: 5,
      expires_in: 900,
    })]);
    const authorization = await requestCopilotDeviceAuthorization(fetchImpl);
    expect(authorization).toMatchObject({ userCode: 'ABCD-1234', deviceCode: 'dev-1', interval: 5 });
    expect(fetchImpl.urls[0]).toBe('https://github.com/login/device/code');
    const params = new URLSearchParams(fetchImpl.bodies[0] ?? '');
    expect(params.get('client_id')).toBe(COPILOT_OAUTH_CONFIG.clientId);
    expect(params.get('scope')).toBe('read:user');
  });

  it('treats authorization_pending/slow_down as pending, other errors as failed', async () => {
    const pending = await pollCopilotDeviceToken('dev', fetchReturning([jsonResponse({ error: 'authorization_pending' }, 200)]));
    expect(pending).toEqual({ state: 'pending' });

    const slow = await pollCopilotDeviceToken('dev', fetchReturning([jsonResponse({ error: 'slow_down', interval: 10 }, 200)]));
    expect(slow).toEqual({ state: 'slowDown', intervalSeconds: 10 });

    const denied = await pollCopilotDeviceToken('dev', fetchReturning([jsonResponse({ error: 'access_denied', error_description: 'nope' }, 200)]));
    expect(denied).toEqual({ state: 'failed', message: 'nope' });
  });

  it('paces polls with the escalating multipliers until the token lands', async () => {
    const fetchImpl = fetchReturning([
      jsonResponse({ error: 'authorization_pending' }, 200),
      jsonResponse({ error: 'slow_down' }, 200),
      jsonResponse({ access_token: 'ghu_1' }, 200),
    ]);
    const sleeps: number[] = [];
    const result = await awaitCopilotDeviceToken(
      { userCode: 'c', deviceCode: 'dev', verificationUri: 'u', interval: 5, expiresIn: 900 },
      fetchImpl,
      { sleep: async (ms) => { sleeps.push(ms); } },
    );
    expect(result).toEqual({ accessToken: 'ghu_1' });
    // Baseline 5s × 1.2; slow_down (no interval field) adds +5s AND raises the
    // multiplier to ×1.4 → ceil(10s × 1.4).
    expect(sleeps).toEqual([6000, 14000]);
  });

  it('reads the GitHub identity and the plan-advertised API endpoint', async () => {
    const identity = fetchReturning([jsonResponse({ login: 'octocat', email: 'o@example.com' })]);
    expect(await fetchCopilotIdentity('ghu_1', identity)).toEqual({ accountId: 'octocat', email: 'o@example.com' });

    const endpoint = fetchReturning([jsonResponse({ endpoints: { api: 'https://api.githubcopilot.com/' } })]);
    expect(await discoverCopilotApiEndpoint('ghu_1', endpoint)).toBe('https://api.githubcopilot.com');
    const none = fetchReturning([jsonResponse({ endpoints: {} })]);
    expect(await discoverCopilotApiEndpoint('ghu_1', none)).toBeUndefined();
  });

  it('refresh is a LOCAL no-op returning the same token with far-future expiry', () => {
    const result = refreshCopilotToken('ghu_1');
    expect(result).toMatchObject({ accessToken: 'ghu_1', refreshToken: 'ghu_1' });
    expect(result.expiresIn).toBeGreaterThan(9 * 365 * 24 * 3600);
  });

  it('the policy-enable POST carries the chat-policy intent headers', async () => {
    const fetchImpl = fetchReturning([jsonResponse({ ok: true })]);
    const ok = await enableCopilotModel('ghu_1', 'claude-sonnet-5', 'https://api.githubcopilot.com', fetchImpl);
    expect(ok).toBe(true);
    expect(fetchImpl.urls[0]).toBe('https://api.githubcopilot.com/models/claude-sonnet-5/policy');
    expect(fetchImpl.bodies[0]).toBe('{"state":"enabled"}');
    const headers = fetchImpl.headers[0]!;
    expect(headers['X-Initiator']).toBe('user');
    expect(headers['X-Interaction-Type']).toBe('chat-policy');
    expect(headers['X-GitHub-Api-Version']).toBe('2026-08-01');
  });

  it('the static API identity set mirrors the official CLI (agent initiator)', () => {
    expect(COPILOT_API_HEADERS['Copilot-Integration-Id']).toBe('copilot-developer-cli');
    expect(COPILOT_API_HEADERS['Editor-Version']).toContain('copilot/');
    expect(COPILOT_API_HEADERS['X-GitHub-Api-Version']).toBe('2026-08-01');
    expect(COPILOT_API_HEADERS['X-Initiator']).toBe('agent');
    expect(COPILOT_API_HEADERS['X-Interaction-Type']).toBe('conversation-agent');
  });
});

describe('copilot wire map', () => {
  it('routes each family to its wire, path, and transformer chain', () => {
    expect(copilotWireFor('claude-sonnet-5')).toBe('anthropic');
    expect(copilotPathFor('anthropic')).toBe('/v1/messages');
    expect(copilotTransformerNamesForWire('anthropic')).toEqual(['anthropic']);

    expect(copilotWireFor('gpt-5.6-sol')).toBe('responses');
    expect(copilotPathFor('responses')).toBe('/v1/responses');
    expect(copilotTransformerNamesForWire('responses')).toEqual(['openai-response']);

    expect(copilotWireFor('gemini-3.5-flash')).toBe('chat');
    expect(copilotPathFor('chat')).toBe('/v1/chat/completions');
    expect(copilotTransformerNamesForWire('chat')).toEqual(['openai']);

    // Unknown ids fall to the responses wire (newest models land there first).
    expect(copilotWireFor('brand-new-model')).toBe('responses');
  });

  it('resolves the API base: discovered endpoint > GHE domain > canonical host', () => {
    expect(copilotBaseUrl(undefined)).toBe('https://api.githubcopilot.com');
    expect(copilotBaseUrl({ apiEndpoint: 'https://custom.example/copilot/' })).toBe('https://custom.example/copilot');
    expect(copilotBaseUrl({ enterpriseUrl: 'company.ghe.com' })).toBe('https://copilot-api.company.ghe.com');
  });
});

/**
 * mock-daemon.mjs — a throwaway mock of the daemon admin API for the browser
 * data-contract check (verification 6.6). Serves the exact shapes the daemon
 * returns: GET /admin/api/providers, /presets, /providers/:id/keys, and the D8
 * POST routes (reorder, discover-models) + PUT/POST/DELETE provider CRUD.
 *
 * Run: node scripts/mock-daemon.mjs   (listens on 127.0.0.1:8766)
 * NOT part of the app — a dev/verify aid only.
 */
import { createServer } from 'node:http';

let providers = [
  { id: 'openai', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o'], hasApiKey: true, apiKeyMasked: 'sk-…wxyz', enabled: true },
  { id: 'anthropic', apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-3-5-sonnet'], hasApiKey: true, apiKeyMasked: 'sk-…abcd', enabled: false },
];

const presets = [
  { id: 'deepseek', presetId: 'deepseek', name: 'DeepSeek', apiFormat: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat'] },
];

// ── Phase-2 in-memory state (server / status / keys / accounts) ───────────────

const MOCK_PORT = 8788;

function emptyEndpoint(endpoint) {
  return { endpoint, defaultModel: '', backgroundModel: '', useSubscription: false };
}

// The persisted outbound-server config (mirrors `OutboundApiServerConfig`).
let serverConfig = {
  enabled: false,
  networkBinding: false,
  port: MOCK_PORT,
  endpoints: [
    emptyEndpoint('chat'),
    emptyEndpoint('responses'),
    emptyEndpoint('messages'),
    emptyEndpoint('gemini'),
  ],
};

// Named outbound keys (mirrors `OutboundApiKeyInfo`; create returns plaintextOnce).
let outboundKeys = [];
let keySeq = 1;

function formatUrls(base) {
  return {
    chat: `${base}/v1/chat/completions`,
    responses: `${base}/v1/responses`,
    messages: `${base}/v1/messages`,
    gemini: `${base}/v1beta/models/gemini-pro:generateContent`,
  };
}

/** Derive the live `/status` shape from the stored config (like the real daemon). */
function deriveStatus() {
  const running = serverConfig.enabled;
  const port = running ? serverConfig.port ?? MOCK_PORT : 0;
  const loopbackUrl = running ? `http://127.0.0.1:${port}` : null;
  const lanUrl = running && serverConfig.networkBinding ? `http://192.168.1.10:${port}` : null;
  return {
    running,
    port,
    loopbackUrl,
    lanUrl,
    formats: loopbackUrl ? formatUrls(loopbackUrl) : null,
    lanFormats: lanUrl ? formatUrls(lanUrl) : null,
    // STATUS projection — note the field is `model`, NOT `defaultModel`.
    endpoints: serverConfig.endpoints.map((e) => ({
      endpoint: e.endpoint,
      model: e.defaultModel,
      useSubscription: e.useSubscription,
    })),
  };
}

// Subscription accounts (mirrors `SubscriptionListEntry` + sanitized accounts).
const accountsList = [
  { providerId: 'claude', displayName: 'Claude', kind: 'oauth-bearer', credentialStatus: { providerId: 'claude', ok: true } },
  { providerId: 'codex', displayName: 'Codex', kind: 'oauth-bearer', credentialStatus: { providerId: 'codex', ok: false, reason: 'missing-credential' } },
  { providerId: 'gemini', displayName: 'Gemini', kind: 'oauth-bearer', credentialStatus: { providerId: 'gemini', ok: false, reason: 'missing-credential' } },
  { providerId: 'opencodego', displayName: 'OpenCodeGo', kind: 'static-bearer', credentialStatus: { providerId: 'opencodego', ok: false, reason: 'missing-credential' } },
];
let providerAccounts = {
  claude: [{ id: 'claude:1', label: 'Personal', status: 'configured', hasAccessToken: true, isActive: true }],
  codex: [],
  gemini: [],
  opencodego: [],
};

const VALID_PROVIDERS = new Set(['claude', 'codex', 'gemini', 'opencodego']);

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }

  if (p === '/admin/api/providers' && method === 'GET') return send(res, 200, { providers });
  if (p === '/admin/api/presets' && method === 'GET') return send(res, 200, { presets, excluded: [] });

  if (p === '/admin/api/providers/reorder' && method === 'POST') {
    const body = await readBody(req);
    const order = Array.isArray(body.order) ? body.order : [];
    const byId = new Map(providers.map((x) => [x.id, x]));
    const seen = new Set();
    const next = [];
    for (const id of order) { const r = byId.get(id); if (r && !seen.has(id)) { next.push(r); seen.add(id); } }
    for (const r of providers) if (!seen.has(r.id)) { next.push(r); seen.add(r.id); }
    providers = next;
    return send(res, 200, { ok: true, providers });
  }

  const discMatch = p.match(/^\/admin\/api\/providers\/([^/]+)\/discover-models$/);
  if (discMatch && method === 'POST') {
    const row = providers.find((x) => x.id === discMatch[1]);
    if (!row) return send(res, 404, { error: { message: 'not found' } });
    if (row.apiFormat !== 'openai') return send(res, 200, { models: [], unsupportedFormat: true });
    return send(res, 200, { models: ['gpt-4o', 'gpt-4o-mini', 'o3'] });
  }

  const testMatch = p.match(/^\/admin\/api\/providers\/([^/]+)\/test$/);
  if (testMatch && method === 'POST') {
    const row = providers.find((x) => x.id === testMatch[1]);
    if (!row) return send(res, 404, { error: { message: 'not found' } });
    if (row.apiFormat === 'gemini') return send(res, 200, { ok: false, unsupportedFormat: true });
    if (!row.hasApiKey) return send(res, 200, { ok: false, message: 'no API key configured for this provider' });
    return send(res, 200, { ok: true, status: 200, latencyMs: 412, sample: 'OK' });
  }

  const keysMatch = p.match(/^\/admin\/api\/providers\/([^/]+)\/keys$/);
  if (keysMatch && method === 'GET') {
    return send(res, 200, { keys: [{ id: `${keysMatch[1]}:default`, label: 'default', enabled: true, weight: 1, apiKeyMasked: 'sk-…wxyz' }] });
  }

  const idMatch = p.match(/^\/admin\/api\/providers\/([^/]+)$/);
  if (idMatch) {
    const id = idMatch[1];
    const idx = providers.findIndex((x) => x.id === id);
    if (method === 'PUT') {
      const body = await readBody(req);
      if (idx < 0) return send(res, 404, { error: { message: 'not found' } });
      const cur = providers[idx];
      const updated = { ...cur, apiFormat: body.apiFormat ?? cur.apiFormat, baseUrl: body.baseUrl ?? cur.baseUrl };
      if (typeof body.enabled === 'boolean') updated.enabled = body.enabled;
      if (Array.isArray(body.models)) updated.models = body.models;
      providers[idx] = updated;
      return send(res, 200, { provider: updated });
    }
    if (method === 'DELETE') {
      if (idx >= 0) providers.splice(idx, 1);
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/admin/api/providers' && method === 'POST') {
    const body = await readBody(req);
    const row = { id: body.id, apiFormat: body.apiFormat, baseUrl: body.baseUrl, models: body.models ?? [], hasApiKey: Boolean(body.apiKey), apiKeyMasked: body.apiKey ? 'sk-…new' : '', enabled: body.enabled !== false };
    if (providers.some((x) => x.id === row.id)) return send(res, 409, { error: { message: 'exists' } });
    providers.push(row);
    return send(res, 201, { provider: row });
  }

  // ── Server config (GET/PUT) — PUT shallow-merges the four fields, replaces
  //    endpoints WHOLESALE like the real `mergeServerConfig` (no deep merge). ──
  if (p === '/admin/api/server' && method === 'GET') return send(res, 200, { server: serverConfig });
  if (p === '/admin/api/server' && method === 'PUT') {
    const patch = await readBody(req);
    serverConfig = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : serverConfig.enabled,
      networkBinding:
        typeof patch.networkBinding === 'boolean' ? patch.networkBinding : serverConfig.networkBinding,
      // Wholesale replace (NOT per-endpoint merge) — the honesty trap the adapter
      // guards against by always sending the full array.
      endpoints: Array.isArray(patch.endpoints) ? patch.endpoints : serverConfig.endpoints,
      port: typeof patch.port === 'number' ? patch.port : serverConfig.port,
    };
    return send(res, 200, { server: serverConfig });
  }

  // ── Status (derived from the stored config) ──────────────────────────────────
  if (p === '/admin/api/status' && method === 'GET') return send(res, 200, deriveStatus());

  // ── Named keys (list / create / revoke / enabled) ────────────────────────────
  if (p === '/admin/api/keys' && method === 'GET') return send(res, 200, { keys: outboundKeys });
  if (p === '/admin/api/keys' && method === 'POST') {
    const body = await readBody(req);
    const id = `key-${keySeq++}`;
    const name = typeof body.name === 'string' ? body.name : id;
    outboundKeys.push({ id, name, keyPrefix: 'ock_abcd', enabled: true, createdAt: Date.now(), lastUsedAt: null, revoked: false });
    // plaintextOnce is the ONLY place a full key crosses the wire.
    return send(res, 201, { id, name, keyPrefix: 'ock_abcd', createdAt: Date.now(), plaintextOnce: `ock_abcd1234_${id}_FULLSECRET` });
  }
  const keyRevoke = p.match(/^\/admin\/api\/keys\/([^/]+)\/revoke$/);
  if (keyRevoke && method === 'POST') {
    const k = outboundKeys.find((x) => x.id === keyRevoke[1]);
    if (!k) return send(res, 404, { ok: false });
    k.revoked = true;
    k.enabled = false;
    return send(res, 200, { ok: true });
  }
  const keyEnabled = p.match(/^\/admin\/api\/keys\/([^/]+)\/enabled$/);
  if (keyEnabled && method === 'POST') {
    const body = await readBody(req);
    const k = outboundKeys.find((x) => x.id === keyEnabled[1]);
    if (!k) return send(res, 404, { ok: false, enabled: false });
    k.enabled = body.enabled === true;
    return send(res, 200, { ok: true, enabled: k.enabled });
  }

  // ── Accounts (token-free GET + secret-IN-never-OUT write) ────────────────────
  if (p === '/admin/api/accounts' && method === 'GET') {
    return send(res, 200, { accounts: accountsList, providerAccounts });
  }
  const acctActive = p.match(/^\/admin\/api\/accounts\/([^/]+)\/active$/);
  if (acctActive && method === 'PUT') {
    if (!VALID_PROVIDERS.has(acctActive[1])) return send(res, 400, { error: { message: 'unknown provider' } });
    const body = await readBody(req);
    if (!body.id) return send(res, 400, { error: { message: 'active switch requires { id }' } });
    const list = providerAccounts[acctActive[1]] ?? [];
    const found = list.some((a) => a.id === body.id);
    if (!found) return send(res, 404, { error: { message: `account '${body.id}' not found` } });
    for (const a of list) a.isActive = a.id === body.id;
    return send(res, 200, { ok: true });
  }
  const acctSingle = p.match(/^\/admin\/api\/accounts\/([^/]+)\/([^/]+)$/);
  if (acctSingle && method === 'DELETE') {
    if (!VALID_PROVIDERS.has(acctSingle[1])) return send(res, 400, { error: { message: 'unknown provider' } });
    const list = providerAccounts[acctSingle[1]] ?? [];
    const idx = list.findIndex((a) => a.id === acctSingle[2]);
    if (idx < 0) return send(res, 404, { error: { message: `account '${acctSingle[2]}' not found` } });
    list.splice(idx, 1);
    return send(res, 200, { ok: true });
  }
  const acctProvider = p.match(/^\/admin\/api\/accounts\/([^/]+)$/);
  if (acctProvider) {
    const providerId = acctProvider[1];
    if (!VALID_PROVIDERS.has(providerId)) return send(res, 400, { error: { message: `unknown subscription provider '${providerId}'` } });
    if (method === 'DELETE') {
      providerAccounts[providerId] = [];
      const entry = accountsList.find((a) => a.providerId === providerId);
      if (entry) entry.credentialStatus = { providerId, ok: false, reason: 'missing-credential' };
      return send(res, 200, { ok: true });
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readBody(req);
      // Minimal shape-check (mirrors `validateTokenBody`'s required fields). Reject
      // a body missing authMethod/status with a 400 — never echo the body back.
      if (!body.authMethod || !body.status) {
        return send(res, 400, { error: { message: `malformed token body for provider '${providerId}'` } });
      }
      const entry = accountsList.find((a) => a.providerId === providerId);
      if (entry) entry.credentialStatus = { providerId, ok: body.status === 'configured' || body.status === 'authorized' };
      // STATUS-ONLY response — never the submitted token body.
      return send(res, 200, entry ? { account: entry } : { ok: true });
    }
  }

  // ── Playground (503 when stopped; canned JSON / SSE) ─────────────────────────
  if (p === '/admin/api/playground' && method === 'POST') {
    const body = await readBody(req);
    if (!serverConfig.enabled) return send(res, 503, { error: { message: 'outbound server not running' } });
    const payload = body && typeof body.body === 'object' ? body.body : {};
    if (payload && payload.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" from the mock"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    return send(res, 200, {
      id: 'mock-completion',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from the mock daemon playground.' } }],
    });
  }

  return send(res, 404, { error: { message: `no route ${method} ${p}` } });
});

server.listen(8766, '127.0.0.1', () => console.log('mock daemon on http://127.0.0.1:8766'));

/** Authenticated System One gateway; decision behavior lives in core/logjev. */
import type http from 'node:http';

import { hashKey, type OutboundKeyDb } from '@omnicross/core';
import { createLogJevClient, isOpenRouterUpstream, LogJevError } from '@omnicross/core/logjev';
import type { JevRequest, LogJevClient, LogJevProvider } from '@omnicross/core/logjev';
import { getOpenCodeGoUserAgent } from '@omnicross/core/provider-proxy/identity/openCodeGoHeaders';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';
import { normalizeOpenCodeGoBaseUrl } from '@omnicross/subscriptions';

import { loadConfig } from './config';
import type { DaemonProviderConfig } from './config';
import { resolveEnvKey } from './pool/resolveEnvKey';

export { isOpenRouterUpstream, openRouterDecisionsUrl, mapDecisionsResponse } from '@omnicross/core/logjev';

/** One opencodego account's chat-relevant credential (secret used in-process only). */
export interface JevOpenCodeGoAccount {
  apiKey: string | null;
  zenBaseUrl?: string;
}

/** The zen-half chat BASE (`…/zen/v1`) the LogJev client appends its
 *  `/chat/completions` to — exported for the probe route. */
export function openCodeGoChatBase(zenBaseUrl?: string): string {
  return `${normalizeOpenCodeGoBaseUrl(zenBaseUrl ?? 'https://opencode.ai/zen')}/v1`;
}

/** The opencode.ai egress identity headers (announcement: identify the tool;
 *  stable session id for cache affinity). Same discipline as the relay path. */
function openCodeGoIdentityHeaders(): Record<string, string> {
  return {
    'user-agent': getOpenCodeGoUserAgent(),
    'x-opencode-session': 'omnicross-logjev',
  };
}

function providerConfig(
  row: DaemonProviderConfig,
  allRows: readonly DaemonProviderConfig[],
  ocAccount?: JevOpenCodeGoAccount | null,
): LogJevProvider {
  // LogJev-as-selector (chat mode): the row references an ALREADY configured
  // upstream instead of carrying its own key/url — resolve that upstream's
  // credentials here so it stays the single source of truth (key rotation,
  // proxy, headers all follow it).
  const upstreamRef = row.logjev?.kind === 'chat' ? row.logjev.upstream : undefined;
  if (upstreamRef?.kind === 'provider') {
    const target = allRows.find(p => p.id === upstreamRef.id && p.category !== 'other'
      && p.enabled !== false && p.apiFormat === 'openai');
    if (!target) {
      throw new LogJevError('invalid_request',
        `LogJev upstream provider '${upstreamRef.id}' is missing or disabled (模型服务)`);
    }
    // BYO rows store EITHER a base (`…/v1`) or the full endpoint
    // (`…/v1/chat/completions`); the client appends `/chat/completions`
    // itself, so strip a pre-existing suffix.
    const chatBase = target.baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    return { ...row.logjev, kind: 'chat', baseUrl: chatBase, model: upstreamRef.model,
      apiKey: resolveEnvKey(target.apiKey), headers: target.extraHeaders };
  }
  if (upstreamRef?.kind === 'account-pool') {
    // opencodego's zen half serves the OpenAI chat wire; the account's static
    // key + zen host override resolve per call (the ACTIVE account today).
    if (!ocAccount?.apiKey) {
      throw new LogJevError('invalid_request',
        'LogJev upstream opencodego account has no API key (账号订阅)');
    }
    return { ...row.logjev, kind: 'chat', baseUrl: openCodeGoChatBase(ocAccount.zenBaseUrl),
      model: upstreamRef.model, apiKey: ocAccount.apiKey, headers: openCodeGoIdentityHeaders() };
  }
  const model = row.models?.[0] ?? 'jev-latest';
  // Preserve old native Jev rows without misrouting Qwen/etc on OpenRouter.
  const kind = row.logjev?.kind ?? (row.id === 'jev' || isOpenRouterUpstream(row.baseUrl) && /^(typesafe\/)?jev[-/]/i.test(model) ? 'jev' : 'chat');
  return { ...row.logjev, kind, baseUrl: row.baseUrl, model,
    apiKey: resolveEnvKey(row.apiKey), headers: row.extraHeaders };
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}
function writeError(res: http.ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: { type: 'jev_error', message } });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16 * 1024 * 1024) throw new LogJevError('invalid_request', 'LogJev body exceeds 16 MiB');
    chunks.push(bytes);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new LogJevError('invalid_request', 'body must be valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LogJevError('invalid_request', 'body must be a JSON object');
  return parsed as Record<string, unknown>;
}

export function createJevSystemoneMount(deps: {
  configPath: string;
  keyDb: OutboundKeyDb;
  /**
   * Resolve an opencodego account's chat credential for account-pool upstream
   * references (the ACTIVE account; secret used daemon-side only). Optional
   * for tests; absent ⇒ an account-pool reference fails 422 with guidance.
   */
  resolveOpenCodeGoAccount?: () => Promise<JevOpenCodeGoAccount | null>;
}): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  const clients = new Map<string, { signature: string; client: LogJevClient }>();
  return async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]?.replace(/\/+$/, '') || '/';
    if (path !== '/v1/systemone') return false;
    if (req.method !== 'POST') { writeError(res, 405, 'use POST /v1/systemone'); return true; }
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ') ||
        !(await deps.keyDb.outboundApiKeysGetByHash(hashKey(header.slice(7).trim())))) {
      writeError(res, 401, 'invalid or missing access key (Authorization: Bearer <omnicross access key>)');
      return true;
    }
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnect);
    try {
      const body = await readJsonBody(req);
      const allProviders = loadConfig(deps.configPath).providers;
      const rows = allProviders.filter(p => p.category === 'other' && p.enabled !== false);
      for (const id of clients.keys()) if (!rows.some(row => row.id === id)) clients.delete(id);
      if (body.provider !== undefined && typeof body.provider !== 'string') throw new LogJevError('invalid_request', 'provider must be a provider ID');
      const row = typeof body.provider === 'string' ? rows.find(p => p.id === body.provider)
        : rows.find(p => p.id === 'logjev') ?? rows.find(p => p.id === 'open-jev') ?? rows[0];
      if (!row) {
        writeError(res, 409, 'no enabled Jev upstream: add LogJev under LLM Providers → Other (existing open-jev rows remain supported)');
        return true;
      }
      // Account-pool references resolve the account credential per call — the
      // resolved key/zen-host ride the config SIGNATURE below, so an account
      // switch (rotation, re-keying) transparently rebuilds the client.
      const needsOcAccount = row.logjev?.kind === 'chat' && row.logjev.upstream?.kind === 'account-pool';
      const ocAccount = needsOcAccount
        ? await (deps.resolveOpenCodeGoAccount?.() ?? Promise.resolve(null)).catch(() => null)
        : undefined;
      const config = providerConfig(row, allProviders, ocAccount);
      const signature = JSON.stringify(config);
      let entry = clients.get(row.id);
      if (!entry || entry.signature !== signature) {
        // Account-pool egress rides the opencodego proxy lane + identity; BYO
        // references keep the byo lane.
        const fetchProviderId = needsOcAccount ? 'opencodego' : 'byo';
        const fetcher: typeof globalThis.fetch = (input, init) => fetchUpstream(String(input), init ?? {}, { providerId: fetchProviderId });
        entry = { signature, client: createLogJevClient(config, { fetch: fetcher }) };
        clients.set(row.id, entry);
      }
      const result = await entry.client.evaluate(body as unknown as JevRequest, { signal: controller.signal });
      writeJson(res, 200, result);
    } catch (error) {
      if (!controller.signal.aborted) {
        const status = error instanceof LogJevError && error.code === 'invalid_request' ? 422 : 502;
        writeError(res, status, error instanceof LogJevError ? error.message : 'LogJev evaluation failed; check provider configuration');
      }
    } finally { res.off('close', disconnect); }
    return true;
  };
}

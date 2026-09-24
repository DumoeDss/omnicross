/** Authenticated System One gateway; decision behavior lives in core/logjev. */
import type http from 'node:http';

import { hashKey, type OutboundKeyDb } from '@omnicross/core';
import { createLogJevClient, isOpenRouterUpstream, LogJevError } from '@omnicross/core/logjev';
import type { JevRequest, LogJevClient, LogJevProvider } from '@omnicross/core/logjev';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';

import { loadConfig } from './config';
import type { DaemonProviderConfig } from './config';
import { resolveEnvKey } from './pool/resolveEnvKey';

export { isOpenRouterUpstream, openRouterDecisionsUrl, mapDecisionsResponse } from '@omnicross/core/logjev';

function providerConfig(row: DaemonProviderConfig, allRows: readonly DaemonProviderConfig[]): LogJevProvider {
  // LogJev-as-selector (chat mode): the row references an ALREADY configured
  // provider instead of carrying its own key/url — resolve that row's
  // credentials here so the referenced provider stays the single source of
  // truth (key rotation, proxy, headers all follow it).
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
      const config = providerConfig(row, allProviders);
      const signature = JSON.stringify(config);
      let entry = clients.get(row.id);
      if (!entry || entry.signature !== signature) {
        const fetcher: typeof globalThis.fetch = (input, init) => fetchUpstream(String(input), init ?? {}, { providerId: 'byo' });
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

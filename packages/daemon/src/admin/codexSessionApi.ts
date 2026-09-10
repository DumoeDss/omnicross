/** HTTP handlers for the authenticated Codex session management surface. */

import http from 'node:http';

import {
  CodexSessionManagerError,
  type ApplyCodexSessionProviderInput,
  type CodexSessionManager,
} from './codexSessionManager';

export async function handleCodexSessionApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  manager: CodexSessionManager | undefined,
): Promise<void> {
  if (!manager) return writeJsonError(res, 501, 'Codex session management is not available');

  try {
    const method = (req.method ?? 'GET').toUpperCase();
    if (path === '/admin/api/codex-sessions' && (method === 'GET' || method === 'HEAD')) {
      const projectPath = new URL(req.url ?? '/', 'http://localhost').searchParams.get('projectPath') ?? '';
      return writeJson(res, 200, await manager.list(projectPath));
    }

    if (path === '/admin/api/codex-sessions/preview' && method === 'POST') {
      const body = await readJsonBody(req);
      return writeJson(res, 200, await manager.preview(parseApplyInput(body)));
    }

    if (path === '/admin/api/codex-sessions/apply' && method === 'POST') {
      const body = await readJsonBody(req);
      return writeJson(res, 200, await manager.apply(parseApplyInput(body)));
    }

    return writeJsonError(res, 404, 'unknown Codex session admin route');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return writeJsonError(res, error instanceof CodexSessionManagerError ? 400 : 500, message);
  }
}
async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    throw new CodexSessionManagerError('request body must be a JSON object');
  }
}

function parseApplyInput(body: Record<string, unknown>): ApplyCodexSessionProviderInput {
  const projectPath = body['projectPath'];
  const sessionIds = body['sessionIds'];
  const toProvider = body['toProvider'];
  const fromProvider = body['fromProvider'];
  if (typeof projectPath !== 'string') throw new CodexSessionManagerError('projectPath must be a string');
  if (!Array.isArray(sessionIds) || !sessionIds.every((value) => typeof value === 'string')) {
    throw new CodexSessionManagerError('sessionIds must be an array of strings');
  }
  if (typeof toProvider !== 'string') throw new CodexSessionManagerError('toProvider must be a string');
  if (fromProvider !== undefined && typeof fromProvider !== 'string') {
    throw new CodexSessionManagerError('fromProvider must be a string when provided');
  }
  return {
    projectPath,
    sessionIds,
    toProvider,
    ...(fromProvider === undefined ? {} : { fromProvider }),
  };
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function writeJsonError(res: http.ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: { type: 'admin_api_error', message } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

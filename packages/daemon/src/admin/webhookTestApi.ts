/**
 * webhookTestApi — the AUTHED `POST /admin/api/webhook-test` handler
 * (webhook-notifications, design D8). An operator triggers a `test` event to ONE
 * configured destination and gets the delivery outcome back.
 *
 * Lives in its OWN helper module (the #4/#8/#10 convention) so `adminApi.ts` — at
 * its line cap — is untouched: `AdminServer.dispatch` routes this single path
 * here directly, AFTER its auth gate. Delivery goes through the live dispatcher
 * (`deliverWebhookTest`), which finds the destination by id and sends a single
 * attempt (this is the admin request path, NOT a relay path, so awaiting is fine).
 * SECRET-FREE: it returns only `{ ok, status?, error? }` — never a secret.
 *
 * @module @omnicross/daemon/admin/webhookTestApi
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { deliverWebhookTest } from '../webhook/webhookRuntime';

/** Read the JSON request body (bounded, tolerant — a bad body ⇒ `{}`). */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** Serve `POST /admin/api/webhook-test { destinationId }` → a delivery outcome. */
export async function handleWebhookTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const destinationId = body['destinationId'];
  if (typeof destinationId !== 'string' || !destinationId.trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'bad_request', message: 'destinationId is required' } }));
    return;
  }
  const result = await deliverWebhookTest(destinationId.trim());
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ result }));
}

/**
 * webhookRuntime — the module-slot that connects the core emit port + the #2
 * health sources to the daemon `WebhookDispatcher` (webhook-notifications, D2/D3).
 *
 * Mirrors the `upstreamProxyResolver` module-slot pattern: `bootstrap` injects
 * the live dispatcher + health tracker once ({@link setWebhookRuntime}), then
 * `start.ts` (boot) and the admin config PUT (hot-reload) call
 * {@link applyWebhookConfig} with the current `webhook` segment. When the segment
 * is enabled with ≥1 destination, this registers the core sink
 * (`setWebhookSink`) AND subscribes the health `onRecovered` / `onAnomaly`
 * signals to the dispatcher; when disabled/absent it tears BOTH down so
 * `emitWebhookEvent` returns to a strict no-op (zero regression). The dispatcher
 * always receives the live config (destinations) so the admin `test` button can
 * probe a destination even before the master switch is on.
 *
 * @module @omnicross/daemon/webhook/webhookRuntime
 */

import type { WebhookConfig } from '@omnicross/contracts/webhook-types';
import type { SubscriptionAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { setWebhookSink } from '@omnicross/core/pipeline/webhookEmit';

import type { WebhookDeliveryResult, WebhookDispatcher } from './WebhookDispatcher';

let dispatcher: WebhookDispatcher | null = null;
let health: SubscriptionAccountHealth | null = null;
let unsubscribers: Array<() => void> = [];
let wired = false;

/** Inject the live dispatcher + health tracker (bootstrap, once per boot). */
export function setWebhookRuntime(d: WebhookDispatcher, h: SubscriptionAccountHealth): void {
  dispatcher = d;
  health = h;
}

/**
 * Apply the current webhook config: (re)wire the core sink + health subscriptions
 * when enabled with ≥1 destination, or tear them down otherwise. Always pushes
 * the live config into the dispatcher so the test path sees current destinations.
 * Idempotent — safe to call on every admin PUT.
 */
export function applyWebhookConfig(config: WebhookConfig | undefined): void {
  if (!dispatcher) return;
  dispatcher.setConfig(config);
  const shouldWire = config?.enabled === true && (config?.destinations.length ?? 0) > 0;
  if (shouldWire && !wired) {
    const active = dispatcher;
    setWebhookSink((event) => active.emit(event));
    if (health) {
      unsubscribers.push(
        health.onRecovered((e) =>
          active.emit({ kind: 'account.recovery', at: e.at, providerId: e.providerId, accountId: e.accountId }),
        ),
      );
      unsubscribers.push(
        health.onAnomaly((e) =>
          active.emit({
            kind: 'account.anomaly',
            at: e.at,
            providerId: e.providerId,
            accountId: e.accountId,
            state: e.state,
          }),
        ),
      );
    }
    wired = true;
  } else if (!shouldWire && wired) {
    teardown();
  }
}

/**
 * ADMIN test path (design D8): deliver a `test` event to one destination and
 * await the result. Runs on the admin request path only (never a relay path).
 */
export async function deliverWebhookTest(destinationId: string): Promise<WebhookDeliveryResult> {
  if (!dispatcher) return { ok: false, error: 'webhook dispatcher not wired' };
  return dispatcher.deliverTest(destinationId);
}

function teardown(): void {
  setWebhookSink(null);
  for (const unsub of unsubscribers) unsub();
  unsubscribers = [];
  wired = false;
}

/** TEST SEAM — clear the runtime slot + any sink/subscriptions between suites. */
export function resetWebhookRuntimeForTests(): void {
  if (wired) teardown();
  dispatcher = null;
  health = null;
  unsubscribers = [];
  wired = false;
}

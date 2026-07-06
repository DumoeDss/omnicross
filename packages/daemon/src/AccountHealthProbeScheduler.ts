/**
 * AccountHealthProbeScheduler — the scheduled ACTIVE account-health probe
 * (subscription-account-probe #8, design D1–D6).
 *
 * #2's health machine is PASSIVE — an account is only found dead when a REAL
 * request hits it and fails. This scheduler is the active complement: on a plain
 * `unref()`ed interval (omnicross has no cron dep) it runs a CHEAP per-account
 * probe and feeds the outcome into #2's EXISTING shared tracker
 * (`recordUpstreamOutcome`) — inventing no new marking path. Modeled EXACTLY on
 * `AccountHealthSweeper`: `start()` arms the timer, `dispose()` clears it, a
 * single-sweep re-entrancy guard prevents overlap.
 *
 * TWO-TIER, cheapest-first (design D1):
 *  1. FREE local — read the account's token via the credential store; no usable
 *     token ⇒ dead ⇒ a synthesized `401` outcome, NO upstream call.
 *  2. Minimal AUTHED upstream GET (only providers with a VERIFIED cheap endpoint)
 *     via #3's proxy-aware `fetchUpstream` with a short timeout.
 *
 * SAFE tracker mapping (LEAD constraint, mirrors #2's bare-429 discipline):
 * **401/403 → mark; 2xx → clear transient; 429 / 5xx / thrown/timeout → NEVER a
 * mark** (a probe rate-limit or upstream blip must not blacklist a healthy
 * account). So only 401/403/2xx are forwarded to the tracker; the rest are
 * history-only. NEVER a billable probe — the upstream tier is a free authed GET.
 *
 * NEVER-STRAND: marking flows through #2, whose ≥2-account gate (in the strategy's
 * schedulable derivation) keeps a marked SOLE account schedulable — so a probe can
 * never strand a single-account user. `onlyMultiAccount` (default) additionally
 * skips single-account providers entirely.
 *
 * ZERO REGRESSION: default `enabled:false` ⇒ `start()` never arms + `sweep()`
 * early-returns ⇒ no probes, no `/health` boolean, byte-identical.
 *
 * @module @omnicross/daemon/AccountHealthProbeScheduler
 */

import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import type { Logger } from '@omnicross/core';
import type { AccountProbeConfig } from '@omnicross/core/outbound-api';
import type { SubscriptionAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';

import * as accountMulti from './ports/account-multi';
import { type ProbePlan, probePlanFor } from './probe/ProbeStrategy';

const KEY_SEP = '\0';
/** Cap the 403 body read for the ban sniff (`recordUpstreamOutcome` only reads a 403). */
const MAX_BODY_SNIFF = 2048;
/** The four subscription providers, in a stable probe order. */
const PROBE_PROVIDERS: readonly SubscriptionProviderId[] = [
  'claude',
  'codex',
  'gemini',
  'opencodego',
];

/** One rolling probe result (design D4; in-memory, cleared on restart). */
export interface ProbeRecord {
  /** Epoch ms of the probe. */
  ts: number;
  /** Whether the probe observed a HEALTHY signal (2xx upstream / token-present local). */
  ok: boolean;
  /** The HTTP status (`null` = thrown/timeout); absent for a token-present local record. */
  status?: number | null;
  /** Upstream round-trip latency (ms); absent for a local-tier record. */
  latencyMs?: number;
  /** Which tier produced this record. */
  tier: 'local' | 'upstream';
}

/** Per-account probe history for the authed admin surface (names account ids). */
export interface AccountProbeHistorySnapshot {
  providerId: string;
  accountId: string;
  records: ProbeRecord[];
}

/**
 * The read surface the AUTHED admin route consumes (subscription-account-probe,
 * design D5). Structurally satisfied by {@link AccountHealthProbeScheduler}; typed
 * narrow so the admin layer carries no scheduler coupling.
 */
export interface AccountProbeHistoryReader {
  getAllHistory(): AccountProbeHistorySnapshot[];
}

/** The narrow credential-store surface the scheduler reads (#1 seams). */
export interface ProbeCredentialStore {
  getFullConfig(): Promise<AccountTokensConfig>;
  getAccessTokenForAccount(
    providerId: SubscriptionProviderId,
    accountId: string,
  ): Promise<string | null>;
}

/** Proxy-aware upstream fetch signature (#3 `fetchUpstream`). */
export type ProbeFetch = typeof fetchUpstream;

/** Injectable test seams (all default to production behavior). */
export interface ProbeSchedulerOptions {
  /** Injectable clock (ms). Default `Date.now`. */
  now?: () => number;
  /** Injectable proxy-aware fetch (#3). Default `fetchUpstream`. */
  fetchImpl?: ProbeFetch;
  /** Injectable inter-probe delay (stagger). Default a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable per-provider probe-plan resolver. Default {@link probePlanFor}. */
  planFor?: (providerId: string) => ProbePlan;
}

export class AccountHealthProbeScheduler implements AccountProbeHistoryReader {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private readonly history = new Map<string, ProbeRecord[]>();

  private readonly now: () => number;
  private readonly fetchImpl: ProbeFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly planFor: (providerId: string) => ProbePlan;

  constructor(
    private readonly store: ProbeCredentialStore,
    private readonly health: SubscriptionAccountHealth,
    private readonly logger: Logger,
    private config: AccountProbeConfig,
    opts: ProbeSchedulerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetchImpl ?? fetchUpstream;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.planFor = opts.planFor ?? probePlanFor;
  }

  /** Whether probing is enabled by the current config. */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Re-apply config to the live instance (the async `start.ts` loads the persisted
   * `accountProbe` segment after `buildDaemon`). Call BEFORE `start()`.
   */
  configure(config: AccountProbeConfig): void {
    this.config = config;
  }

  /** Arm the probe interval. No-op when disabled (zero regression). Idempotent. */
  start(): void {
    if (this.timer || !this.config.enabled) return;
    this.timer = setInterval(() => void this.sweep(), this.config.intervalMs);
    this.timer.unref?.();
  }

  /** Clear the interval (daemon shutdown / test teardown). Idempotent. */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One sweep: probe every ELIGIBLE account SEQUENTIALLY with a `staggerMs` gap.
   * Disabled ⇒ no-op. `onlyMultiAccount` skips single-account providers. Exposed
   * for tests; never throws.
   */
  async sweep(): Promise<void> {
    if (!this.config.enabled || this.sweeping) return;
    this.sweeping = true;
    try {
      const config = await this.store.getFullConfig();
      let probed = 0;
      let marked = 0;
      for (const providerId of PROBE_PROVIDERS) {
        const accounts = accountMulti.listAccounts(config, providerId);
        if (this.config.onlyMultiAccount && accounts.length < 2) continue;
        for (const account of accounts) {
          if (probed > 0 && this.config.staggerMs > 0) await this.sleep(this.config.staggerMs);
          const outcome = await this.probeAccount(providerId, account.id);
          probed += 1;
          if (outcome.marked) marked += 1;
        }
      }
      this.logger.debug('account-probe sweep complete', { probed, marked });
    } catch (error) {
      this.logger.warn('account-probe sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Probe ONE account (design D1). Local tier first (dead token → synthesized 401,
   * no upstream); else the upstream tier when a verified endpoint exists. Records
   * the rolling history entry either way; returns whether the tracker was MARKED.
   */
  async probeAccount(
    providerId: SubscriptionProviderId,
    accountId: string,
  ): Promise<{ ok: boolean; marked: boolean }> {
    const now = this.now();
    let token: string | null = null;
    let readThrew = false;
    try {
      token = await this.store.getAccessTokenForAccount(providerId, accountId);
    } catch {
      // A THROWN local read (fs/decrypt hiccup) is INCONCLUSIVE — not an account
      // fault (review M2). Record history only; NEVER synthesize a 401 mark on a
      // read error (that would blacklist a possibly-healthy account for 30 min).
      readThrew = true;
    }
    if (readThrew) {
      this.record(providerId, accountId, { ts: now, ok: false, status: null, tier: 'local' });
      return { ok: false, marked: false };
    }

    // Local tier — a DEFINITIVELY absent/unrefreshable token ⇒ dead ⇒ synthesized
    // 401, NO upstream (D1.1). Only a confirmed-`null` token marks (not a throw).
    if (!token) {
      this.health.recordUpstreamOutcome(providerId, accountId, { status: 401, now });
      this.record(providerId, accountId, { ts: now, ok: false, status: 401, tier: 'local' });
      return { ok: false, marked: true };
    }

    const plan = this.planFor(providerId);
    if (plan.kind === 'local') {
      // Token present but no VERIFIED upstream endpoint — record presence only.
      // Do NOT touch the tracker: mere token-presence must not CLEAR a genuine
      // traffic-driven mark (we did not confirm the token actually works upstream).
      this.record(providerId, accountId, { ts: now, ok: true, tier: 'local' });
      return { ok: true, marked: false };
    }

    // Upstream tier — minimal authed GET through #3's proxy-aware fetch.
    const start = this.now();
    let status: number | null = null;
    let bodyText: string | undefined;
    try {
      const res = await this.fetchImpl(
        plan.url,
        { ...plan.buildInit(token), signal: AbortSignal.timeout(this.config.timeoutMs) },
        { providerId, accountId },
      );
      status = res.status;
      if (status === 403) bodyText = await this.readBounded(res);
    } catch {
      // Thrown / timeout — NOT the account's fault; left as a history failure only.
      status = null;
    }
    const latencyMs = this.now() - start;
    const marked = this.applyOutcome(providerId, accountId, status, bodyText, now);
    this.record(providerId, accountId, {
      ts: now,
      ok: status !== null && status >= 200 && status < 300,
      status,
      latencyMs,
      tier: 'upstream',
    });
    return { ok: status !== null && status < 400, marked };
  }

  /** Per-account rolling history for the authed admin surface (design D5). */
  getAllHistory(): AccountProbeHistorySnapshot[] {
    const out: AccountProbeHistorySnapshot[] = [];
    for (const [key, records] of this.history) {
      const [providerId, accountId] = this.parseKey(key);
      out.push({ providerId, accountId, records: records.slice() });
    }
    return out;
  }

  /**
   * The coarse, account-ANONYMOUS `/health` signal (design D5): `true` when no
   * probed account is currently unhealthy (per #2's tracker). No ids, no counts —
   * safe for the unauthenticated `/health`. Vacuously `true` when nothing probed.
   */
  probedAccountsHealthy(now: number = this.now()): boolean {
    for (const key of this.history.keys()) {
      const [providerId, accountId] = this.parseKey(key);
      if (!this.health.isSchedulable(providerId, accountId, now)) return false;
    }
    return true;
  }

  /**
   * Feed ONLY the account/auth-decisive statuses to #2 (LEAD constraint):
   * 401/403 → mark; 2xx → clear transient; 429 / 5xx / other 4xx / null →
   * NOT forwarded (never a mark). Returns whether a NEGATIVE mark was applied.
   */
  private applyOutcome(
    providerId: SubscriptionProviderId,
    accountId: string,
    status: number | null,
    bodyText: string | undefined,
    now: number,
  ): boolean {
    if (status === null) return false; // network / timeout — not an auth error
    if (status === 401 || status === 403) {
      this.health.recordUpstreamOutcome(providerId, accountId, { status, bodyText, now });
      return true;
    }
    if (status >= 200 && status < 300) {
      // Probe 2xx attests the TOKEN works → heal ONLY the auth/transient mark; do
      // NOT clear a rate-limit/overload cooldown (review M1): a 200 from the
      // lightweight `/v1/models` does not prove `/v1/messages` recovered. #2's
      // real-traffic 2xx (`recordUpstreamOutcome`) is UNCHANGED and still clears
      // rate + transient together (it IS traffic on the served endpoint).
      this.health.clearTransientMark(providerId, accountId);
      return false;
    }
    // 429 / 5xx / other 4xx — NOT the account's fault; do not touch the tracker.
    return false;
  }

  /** Append a record, capping the ring at `historySize` (drop oldest). */
  private record(
    providerId: SubscriptionProviderId,
    accountId: string,
    rec: ProbeRecord,
  ): void {
    const key = this.key(providerId, accountId);
    const list = this.history.get(key) ?? [];
    list.push(rec);
    const overflow = list.length - this.config.historySize;
    if (overflow > 0) list.splice(0, overflow);
    this.history.set(key, list);
  }

  /** Read a bounded slice of the response body for the 403-ban sniff (never throws). */
  private async readBounded(res: Response): Promise<string> {
    try {
      return (await res.text()).slice(0, MAX_BODY_SNIFF);
    } catch {
      return '';
    }
  }

  private key(providerId: string, accountId: string): string {
    return `${providerId}${KEY_SEP}${accountId}`;
  }

  private parseKey(key: string): [string, string] {
    const idx = key.indexOf(KEY_SEP);
    return [key.slice(0, idx), key.slice(idx + 1)];
  }
}

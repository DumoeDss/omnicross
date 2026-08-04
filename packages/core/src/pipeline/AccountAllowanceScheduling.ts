/**
 * Default-off allowance-aware scheduling policy.
 *
 * This layer consumes only normalized, secret-free snapshots. Missing, stale,
 * unsupported, or reset-expired data is deliberately ignored so telemetry can
 * never strand an account by accident.
 */

import type { AccountAllowanceSnapshot } from '@omnicross/contracts/account-allowance-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';

import type { AllowanceSchedulingConfig } from '../outbound-api/types';
import { AccountAllowanceStore, getSharedAccountAllowanceStore } from './AccountAllowanceStore';

export type AllowanceSchedulingAction = 'normal' | 'demote' | 'pause' | 'ignore';

export interface AllowanceSchedulingDecision {
  providerId: SubscriptionProviderId;
  accountId: string;
  action: AllowanceSchedulingAction;
  reason:
    | 'policy-disabled'
    | 'provider-unsupported'
    | 'snapshot-missing'
    | 'snapshot-not-fresh'
    | 'below-threshold'
    | 'demote-threshold'
    | 'pause-threshold';
  basePriority: number;
  effectivePriority: number;
  schedulable: boolean;
  usedPercent?: number;
  observedAt?: string;
  resumeAt?: string;
  decidedAt: string;
}

const DEFAULT_POLICY: AllowanceSchedulingConfig = {
  enabled: false,
  demoteAtPercent: 80,
  pauseAtPercent: 98,
  priorityPenalty: 100,
};

const HISTORY_LIMIT = 200;

/**
 * Safe, structured signal emitted only when an enabled allowance policy paused
 * every otherwise eligible account. Request ingress maps it to HTTP 429 instead
 * of disguising a local scheduling decision as an upstream 5xx.
 */
export class AccountAllowanceExhaustedError extends Error {
  readonly code = 'account_allowance_exhausted';
  readonly status = 429;

  constructor(
    readonly providerId: SubscriptionProviderId,
    readonly resumeAt?: string,
  ) {
    super(
      resumeAt
        ? `All ${providerId} subscription accounts are paused by the allowance policy until ${resumeAt}`
        : `All ${providerId} subscription accounts are paused by the allowance policy`,
    );
    this.name = 'AccountAllowanceExhaustedError';
  }
}

/** Structural guard survives package/bundle boundaries and never inspects secrets. */
export function isAccountAllowanceExhaustedError(
  error: unknown,
): error is AccountAllowanceExhaustedError {
  if (error instanceof AccountAllowanceExhaustedError) return true;
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; status?: unknown };
  return value.code === 'account_allowance_exhausted' && value.status === 429;
}

function freshWorstWindow(snapshot: AccountAllowanceSnapshot) {
  return snapshot.windows
    .filter((window) => window.state === 'fresh' && typeof window.usedPercent === 'number')
    .sort((left, right) => (right.usedPercent ?? -1) - (left.usedPercent ?? -1))[0];
}

export class AccountAllowanceScheduling {
  private config: AllowanceSchedulingConfig = { ...DEFAULT_POLICY };
  private readonly history: AllowanceSchedulingDecision[] = [];
  private readonly lastRecorded = new Map<string, string>();

  constructor(
    private readonly store: AccountAllowanceStore = getSharedAccountAllowanceStore(),
    private readonly now: () => number = Date.now,
  ) {}

  configure(config: AllowanceSchedulingConfig | undefined): void {
    this.config = config ? { ...config } : { ...DEFAULT_POLICY };
  }

  getConfig(): AllowanceSchedulingConfig {
    return { ...this.config };
  }

  evaluate(
    providerId: SubscriptionProviderId,
    accountId: string,
    basePriority: number,
    now: number = this.now(),
  ): AllowanceSchedulingDecision {
    const decision = this.decide(providerId, accountId, basePriority, now);
    this.recordApplied(decision);
    return decision;
  }

  /**
   * Project the current policy result without recording an applied decision.
   * Admin/read-model callers use this so polling an account list never creates
   * synthetic demotion/pause history entries.
   */
  preview(
    providerId: SubscriptionProviderId,
    accountId: string,
    basePriority: number,
    now: number = this.now(),
  ): AllowanceSchedulingDecision {
    return this.decide(providerId, accountId, basePriority, now);
  }

  private decide(
    providerId: SubscriptionProviderId,
    accountId: string,
    basePriority: number,
    now: number,
  ): AllowanceSchedulingDecision {
    const decidedAt = new Date(now).toISOString();
    const base = {
      providerId,
      accountId,
      basePriority,
      effectivePriority: basePriority,
      schedulable: true,
      decidedAt,
    };
    if (!this.config.enabled) return { ...base, action: 'ignore', reason: 'policy-disabled' };
    if (providerId !== 'claude' && providerId !== 'codex') {
      return { ...base, action: 'ignore', reason: 'provider-unsupported' };
    }

    const snapshot = this.store.get(providerId, accountId, now);
    if (!snapshot) return { ...base, action: 'ignore', reason: 'snapshot-missing' };
    const worst = freshWorstWindow(snapshot);
    if (!worst || worst.usedPercent === null) {
      return { ...base, action: 'ignore', reason: 'snapshot-not-fresh', observedAt: snapshot.observedAt };
    }

    const resumeAt = worst.resetsAt ?? snapshot.expiresAt;
    const resumeMs = resumeAt ? Date.parse(resumeAt) : Number.NaN;
    const canPauseUntilKnownDeadline = Number.isFinite(resumeMs) && resumeMs > now;
    let decision: AllowanceSchedulingDecision;
    if (worst.usedPercent >= this.config.pauseAtPercent && canPauseUntilKnownDeadline) {
      decision = {
        ...base,
        action: 'pause',
        reason: 'pause-threshold',
        schedulable: false,
        usedPercent: worst.usedPercent,
        observedAt: snapshot.observedAt,
        resumeAt,
      };
    } else if (worst.usedPercent >= this.config.demoteAtPercent) {
      decision = {
        ...base,
        action: 'demote',
        reason: 'demote-threshold',
        effectivePriority: basePriority + this.config.priorityPenalty,
        usedPercent: worst.usedPercent,
        observedAt: snapshot.observedAt,
        resumeAt: canPauseUntilKnownDeadline ? resumeAt : undefined,
      };
    } else {
      decision = {
        ...base,
        action: 'normal',
        reason: 'below-threshold',
        usedPercent: worst.usedPercent,
        observedAt: snapshot.observedAt,
        resumeAt: canPauseUntilKnownDeadline ? resumeAt : undefined,
      };
    }
    return decision;
  }

  getHistory(): AllowanceSchedulingDecision[] {
    return this.history.map((decision) => ({ ...decision }));
  }

  clearHistory(): void {
    this.history.length = 0;
    this.lastRecorded.clear();
  }

  private recordApplied(decision: AllowanceSchedulingDecision): void {
    if (decision.action !== 'demote' && decision.action !== 'pause') return;
    const key = `${decision.providerId}\0${decision.accountId}`;
    const signature = `${decision.action}\0${decision.observedAt ?? ''}\0${decision.usedPercent ?? ''}`;
    if (this.lastRecorded.get(key) === signature) return;
    this.lastRecorded.set(key, signature);
    this.history.push({ ...decision });
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
  }
}

let sharedScheduling: AccountAllowanceScheduling | null = null;

export function getSharedAccountAllowanceScheduling(): AccountAllowanceScheduling {
  if (!sharedScheduling) sharedScheduling = new AccountAllowanceScheduling();
  return sharedScheduling;
}

export function __resetSharedAccountAllowanceSchedulingForTests(): void {
  sharedScheduling = null;
}

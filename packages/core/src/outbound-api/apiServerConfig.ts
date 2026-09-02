/**
 * apiServerConfig — load / save / default the outbound API server config
 * (`outbound-api-server`, design D4).
 *
 * The config (`{ enabled, networkBinding, endpoints, port }`) is persisted via
 * a small key/value store (the app SettingsService) under a single key, so it
 * survives restart. Defaults: disabled, loopback, four blank endpoints +
 * `useSubscription` OFF, default port. The per-endpoint shape is heterogeneous:
 * kind-mapped endpoints (`messages`/`responses`) carry a blank `modelMap` (one
 * key per declared kind); role-based endpoints (`chat`/`gemini`) carry blank
 * `defaultModel`/`backgroundModel`. NO legacy migration — `normalizeServerConfig`
 * drops unknown/legacy fields (incl. `visionModel`) and fills blanks. Shared by
 * the router and the bootstrap wiring so both read/write the same shape.
 *
 * @module outbound-api/apiServerConfig
 */

import type { ProxyConfig } from '@omnicross/contracts/account-tokens-types';
import { type AuditConfig, DEFAULT_AUDIT_CONFIG } from '@omnicross/contracts/audit-types';
import { type BillingConfig, DEFAULT_BILLING_CONFIG } from '@omnicross/contracts/billing-types';
import type { VoucherConfig } from '@omnicross/contracts/voucher-types';
import {
  WEBHOOK_DESTINATION_TYPES,
  WEBHOOK_EVENT_KINDS,
  type WebhookConfig,
  type WebhookDestination,
  type WebhookEventKind,
} from '@omnicross/contracts/webhook-types';

import { isKindMappedEndpoint, modelKindsForEndpoint } from './kindDetection';
import { DEFAULT_OUTBOUND_PORT } from './OutboundApiServer';
import { normalizeImagesServerConfig } from './imagesServerConfig';
import { normalizeSearchServerConfig } from './searchServerConfig';
import type { BoundAccountFallbackPolicy } from '../pipeline/BoundAccountSelectionError';
import type {
  AccountHealthConfig,
  AccountProbeConfig,
  AllowanceSchedulingConfig,
  AnthropicConfigSegment,
  AnthropicCountTokensMode,
  AnthropicModelsShape,
  ConcurrencyQueueConfig,
  EndpointRoutingConfig,
  FingerprintConfig,
  GatewayBinding,
  GatewayBindingFallback,
  GatewayBindingTarget,
  GatewayModelMapping,
  ModelPrefixTargets,
  ModelRef,
  OutboundApiServerConfig,
  OutboundEndpoint,
  OutboundProxyConfig,
  UserMessageQueueConfig,
} from './types';

/** The settings key the config persists under. */
export const OUTBOUND_API_SERVER_CONFIG_KEY = 'outboundApiServer.config';

/**
 * Frozen defaults for the user-message serial queue segment (SSOT). Note the
 * `waitTimeoutMs` default is **60000** — the office-hours draft's 30000 is
 * superseded by the user's拍板 / planning-context §COMMITTED.
 */
export const DEFAULT_USER_MESSAGE_QUEUE: UserMessageQueueConfig = {
  enabled: false,
  delayMs: 200,
  waitTimeoutMs: 60_000,
};

/** Frozen defaults for the per-key concurrency queue segment (SSOT). */
export const DEFAULT_CONCURRENCY_QUEUE: ConcurrencyQueueConfig = {
  maxQueueSizeFactor: 2,
  minQueueSize: 4,
  waitTimeoutMs: 60_000,
};

/**
 * Frozen defaults for the subscription account-health segment (SSOT). LEAD OQ1:
 * 529 overload cooldown ON by default, bounded 10 min.
 */
export const DEFAULT_ACCOUNT_HEALTH: AccountHealthConfig = {
  overloadCooldownEnabled: true,
  overloadCooldownMs: 10 * 60_000,
};

/** Fill + range-CLAMP the account-health segment to the frozen defaults. */
export function normalizeAccountHealth(
  raw: Partial<OutboundApiServerConfig> | undefined | null,
): AccountHealthConfig {
  const ah = raw?.accountHealth;
  return {
    overloadCooldownEnabled: ah?.overloadCooldownEnabled !== false,
    overloadCooldownMs: clampNumber(
      ah?.overloadCooldownMs,
      60_000,
      3_600_000,
      DEFAULT_ACCOUNT_HEALTH.overloadCooldownMs,
    ),
  };
}

/**
 * Frozen defaults for the scheduled account-probe segment (SSOT,
 * subscription-account-probe #8). Default OFF (zero regression); a 15-min cadence,
 * multi-account-only, short timeout, small rolling history, staggered — every knob
 * a load-safety valve (see `AccountProbeConfig`).
 */
export const DEFAULT_ACCOUNT_PROBE: AccountProbeConfig = {
  enabled: false,
  intervalMs: 15 * 60_000,
  onlyMultiAccount: true,
  timeoutMs: 5_000,
  historySize: 10,
  staggerMs: 500,
};

/** Default-off thresholds for allowance-aware account scheduling. */
export const DEFAULT_ALLOWANCE_SCHEDULING: AllowanceSchedulingConfig = {
  enabled: false,
  demoteAtPercent: 80,
  pauseAtPercent: 98,
  priorityPenalty: 100,
};

/** Fill and clamp the optional allowance scheduling segment. */
export function normalizeAllowanceScheduling(
  raw: Partial<OutboundApiServerConfig> | undefined | null,
): AllowanceSchedulingConfig {
  const value = raw?.allowanceScheduling;
  const demoteAtPercent = clampNumber(
    value?.demoteAtPercent,
    0,
    100,
    DEFAULT_ALLOWANCE_SCHEDULING.demoteAtPercent,
  );
  const requestedPause = clampNumber(
    value?.pauseAtPercent,
    0,
    100,
    DEFAULT_ALLOWANCE_SCHEDULING.pauseAtPercent,
  );
  return {
    enabled: value?.enabled === true,
    demoteAtPercent,
    pauseAtPercent: Math.max(demoteAtPercent, requestedPause),
    priorityPenalty: Math.trunc(clampNumber(
      value?.priorityPenalty,
      1,
      1_000,
      DEFAULT_ALLOWANCE_SCHEDULING.priorityPenalty,
    )),
  };
}

/** Fill + range-CLAMP the account-probe segment to the frozen defaults. */
export function normalizeAccountProbe(
  raw: Partial<OutboundApiServerConfig> | undefined | null,
): AccountProbeConfig {
  const ap = raw?.accountProbe;
  return {
    enabled: ap?.enabled === true,
    intervalMs: clampNumber(ap?.intervalMs, 60_000, 86_400_000, DEFAULT_ACCOUNT_PROBE.intervalMs),
    onlyMultiAccount: ap?.onlyMultiAccount !== false,
    timeoutMs: clampNumber(ap?.timeoutMs, 1_000, 60_000, DEFAULT_ACCOUNT_PROBE.timeoutMs),
    historySize: Math.trunc(
      clampNumber(ap?.historySize, 1, 200, DEFAULT_ACCOUNT_PROBE.historySize),
    ),
    staggerMs: clampNumber(ap?.staggerMs, 0, 60_000, DEFAULT_ACCOUNT_PROBE.staggerMs),
  };
}

/**
 * Fill + range-CLAMP the request-audit segment to the frozen defaults
 * (request-audit-log, design D2). Lenient like the other segment normalizers:
 * `enabled`/`captureBodies`/`trustForwardedFor` coerce to booleans (default
 * false). `maxBodyBytes:-1` means unlimited; other finite values clamp to
 * `[0, 1_048_576]`. `retentionDays` clamps to `[1, 365]`;
 * `compactStreamingBodies` coerces to a boolean (default false). Default (all-off) ⇒
 * no capture ⇒ zero regression.
 */
export function normalizeAudit(
  raw: Partial<OutboundApiServerConfig> | undefined | null,
): AuditConfig {
  const a = raw?.audit;
  return {
    enabled: a?.enabled === true,
    captureBodies: a?.captureBodies === true,
    maxBodyBytes: normalizeMaxBodyBytes(a?.maxBodyBytes),
    retentionDays: Math.trunc(
      clampNumber(a?.retentionDays, 1, 365, DEFAULT_AUDIT_CONFIG.retentionDays),
    ),
    compactStreamingBodies: a?.compactStreamingBodies === true,
    trustForwardedFor: a?.trustForwardedFor === true,
  };
}

/** Normalize the audit body limit while preserving `-1` as the unlimited sentinel. */
function normalizeMaxBodyBytes(value: unknown): number {
  if (value === -1) return -1;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_AUDIT_CONFIG.maxBodyBytes;
  }
  return Math.trunc(Math.min(1_048_576, value));
}

/**
 * Fill + range-CLAMP the billing segment to the frozen defaults
 * (billing-event-stream, design D6). Lenient like `normalizeAudit`: `enabled`
 * coerces to a boolean (default false); `endpoint`/`secret` are carried only when
 * non-empty strings (a blank/absent `endpoint` ⇒ ledger-only mode); `maxRetryAgeMs`
 * clamps to `[60_000, 30 days]`. Default (off) ⇒ no publish ⇒ zero regression.
 */
export function normalizeBilling(
  raw: Partial<OutboundApiServerConfig> | undefined | null,
): BillingConfig {
  const b = raw?.billing;
  const config: BillingConfig = {
    enabled: b?.enabled === true,
    maxRetryAgeMs: Math.trunc(
      clampNumber(b?.maxRetryAgeMs, 60_000, 2_592_000_000, DEFAULT_BILLING_CONFIG.maxRetryAgeMs),
    ),
  };
  if (typeof b?.endpoint === 'string' && b.endpoint.trim()) config.endpoint = b.endpoint.trim();
  // The secret may be an `enc:`/`$ENV` envelope at load (the box decrypts after) —
  // carry any non-empty string verbatim; the secret box normalizes downstream.
  if (typeof b?.secret === 'string' && b.secret.length > 0) config.secret = b.secret;
  return config;
}

/**
 * Frozen defaults for the client-fingerprint segment (SSOT,
 * subscription-client-fingerprint #7). Default OFF ⇒ no capture/replay ⇒
 * byte-identical outbound headers.
 */
export const DEFAULT_FINGERPRINT: FingerprintConfig = { enabled: false };

/**
 * Fill the client-fingerprint segment to the frozen defaults. Lenient like the
 * other segment normalizers: `enabled` coerces to a boolean (default false); `ua`
 * is carried only when a non-empty trimmed string (a blank/absent baseline stays
 * absent). Default (off) ⇒ zero regression. Carries NO secret.
 */
export function normalizeFingerprint(
  raw: Partial<OutboundApiServerConfig> | undefined | null,
): FingerprintConfig {
  const f = raw?.fingerprint;
  const out: FingerprintConfig = { enabled: f?.enabled === true };
  if (typeof f?.ua === 'string' && f.ua.trim().length > 0) out.ua = f.ua.trim();
  return out;
}

/**
 * Fill the voucher segment to the frozen defaults (voucher-redemption #9). Lenient
 * like the other segment normalizers: `enabled` coerces to a boolean (default
 * false). Default (off) ⇒ the redeem endpoint is inert ⇒ zero regression. Carries
 * NO secret (codes are hashed at rest in the separate voucher store).
 */
export function normalizeVoucher(
  raw: Partial<OutboundApiServerConfig> | undefined | null,
): VoucherConfig {
  return { enabled: raw?.voucher?.enabled === true };
}

/** Frozen defaults for the Anthropic-protocol segment (§10 skeleton). */
export const DEFAULT_ANTHROPIC_SEGMENT: AnthropicConfigSegment = {
  countTokens: { mode: 'auto', estimateBudgetMs: 2000 },
  modelsShape: 'auto',
  heartbeatIntervalMs: 20_000,
  pdfTextExtraction: { budgetMs: 2000 },
  proxyOauthUsage: false,
  apiHello: true,
};

const COUNT_TOKENS_MODES: readonly string[] = ['auto', 'passthrough', 'estimate', 'reject'];
const MODELS_SHAPES: readonly string[] = ['auto', 'anthropic', 'openai'];

/**
 * Fill + clamp the Anthropic-protocol segment to the frozen defaults
 * (claude-api-protocol-fidelity, §10). Lenient like the other segment
 * normalizers: unknown enum values fall back to the default, numbers clamp.
 * `estimateBudgetMs` clamps to 100..60000; `heartbeatIntervalMs` clamps to
 * 0..600000 (≤0 = heartbeat off). Never throws.
 */
export function normalizeAnthropicSegment(
  raw: Partial<OutboundApiServerConfig> | undefined | null,
): AnthropicConfigSegment {
  const a = raw?.anthropic;
  return {
    countTokens: {
      mode: COUNT_TOKENS_MODES.includes(String(a?.countTokens?.mode))
        ? (a?.countTokens?.mode as AnthropicCountTokensMode)
        : DEFAULT_ANTHROPIC_SEGMENT.countTokens!.mode,
      estimateBudgetMs: clampNumber(
        a?.countTokens?.estimateBudgetMs,
        100,
        60_000,
        DEFAULT_ANTHROPIC_SEGMENT.countTokens!.estimateBudgetMs!,
      ),
    },
    modelsShape: MODELS_SHAPES.includes(String(a?.modelsShape))
      ? (a?.modelsShape as AnthropicModelsShape)
      : DEFAULT_ANTHROPIC_SEGMENT.modelsShape,
    heartbeatIntervalMs: clampNumber(
      a?.heartbeatIntervalMs,
      0,
      600_000,
      DEFAULT_ANTHROPIC_SEGMENT.heartbeatIntervalMs!,
    ),
    pdfTextExtraction: {
      budgetMs: clampNumber(
        a?.pdfTextExtraction?.budgetMs,
        100,
        60_000,
        DEFAULT_ANTHROPIC_SEGMENT.pdfTextExtraction!.budgetMs!,
      ),
    },
    proxyOauthUsage: a?.proxyOauthUsage === true,
    apiHello: a?.apiHello !== false,
  };
}

/** Valid structured proxy types. */
const PROXY_TYPES: readonly string[] = ['http', 'https', 'socks5'];

/**
 * Validate ONE `ProxyConfig` (upstream-proxy). Returns the cleaned descriptor or
 * `undefined` (drop) when malformed. Lenient like the other segment normalizers:
 *  - `{ url }`        — a non-empty string URL (trimmed).
 *  - structured       — `type` ∈ {http,https,socks5} + non-empty `host` + a
 *                       finite integer `port` in `1..65535`. `username`/`password`
 *                       are non-empty-string-or-omit (may be `enc:`/`$ENV` at load
 *                       — the secret box decrypts afterwards).
 * Never throws.
 */
export function normalizeProxyConfig(raw: unknown): ProxyConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r['url'] === 'string' && r['url'].trim().length > 0) {
    return { url: r['url'].trim() };
  }
  const type = r['type'];
  const host = r['host'];
  const port = r['port'];
  if (
    typeof type === 'string' &&
    PROXY_TYPES.includes(type) &&
    typeof host === 'string' &&
    host.trim().length > 0 &&
    typeof port === 'number' &&
    Number.isFinite(port) &&
    port >= 1 &&
    port <= 65535
  ) {
    const out: ProxyConfig = {
      type: type as 'http' | 'https' | 'socks5',
      host: host.trim(),
      port: Math.trunc(port),
    };
    if (typeof r['username'] === 'string' && r['username'].length > 0) out.username = r['username'];
    if (typeof r['password'] === 'string' && r['password'].length > 0) out.password = r['password'];
    return out;
  }
  return undefined;
}

/**
 * Validate the optional `proxy` segment (upstream-proxy). Drops malformed entries
 * (a bad `global` or a bad `byProvider[*]` value/key is dropped, never thrown).
 * Returns `undefined` when nothing valid remains — a missing/empty proxy segment
 * stays ABSENT (zero-config = direct fetch; unlike `accountHealth`, no default is
 * synthesized).
 */
export function normalizeProxySegment(raw: unknown): OutboundProxyConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: OutboundProxyConfig = {};
  const global = normalizeProxyConfig(r['global']);
  if (global) out.global = global;
  if (r['byProvider'] && typeof r['byProvider'] === 'object') {
    const byProvider: Record<string, ProxyConfig> = {};
    for (const [key, value] of Object.entries(r['byProvider'] as Record<string, unknown>)) {
      if (!key.trim()) continue;
      const cfg = normalizeProxyConfig(value);
      if (cfg) byProvider[key] = cfg;
    }
    if (Object.keys(byProvider).length > 0) out.byProvider = byProvider;
  }
  return out.global || out.byProvider ? out : undefined;
}

/**
 * Validate ONE webhook destination (webhook-notifications). Returns the cleaned
 * descriptor or `undefined` (drop) when malformed — lenient like the proxy
 * normalizer, never throws:
 *  - `id`   — a non-empty trimmed string.
 *  - `type` — ∈ {custom, feishu}.
 *  - `url`  — a non-empty trimmed string.
 *  - `secret` — non-empty-string-or-omit (may be `enc:`/`$ENV` at load — the
 *               settings-store secret box decrypts afterwards).
 *  - `events` — kept only when a non-empty array of known kinds (unknown kinds
 *               dropped); an absent/empty filter means "all kinds".
 *  - `enabled` — coerced boolean (default true — a destination in the list is on
 *                unless explicitly disabled).
 */
export function normalizeWebhookDestination(raw: unknown): WebhookDestination | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'string' ? r['id'].trim() : '';
  const url = typeof r['url'] === 'string' ? r['url'].trim() : '';
  const type = r['type'];
  if (!id || !url || typeof type !== 'string' || !WEBHOOK_DESTINATION_TYPES.includes(type as never)) {
    return undefined;
  }
  const out: WebhookDestination = {
    id,
    type: type as WebhookDestination['type'],
    url,
    enabled: r['enabled'] !== false,
  };
  if (typeof r['secret'] === 'string' && r['secret'].length > 0) out.secret = r['secret'];
  if (Array.isArray(r['events'])) {
    const events = r['events'].filter(
      (e): e is WebhookEventKind => typeof e === 'string' && WEBHOOK_EVENT_KINDS.includes(e as never),
    );
    if (events.length > 0) out.events = events;
  }
  return out;
}

/**
 * Validate the optional `webhook` segment (webhook-notifications). Drops
 * malformed destinations; `enabled` defaults false. Returns `undefined` when the
 * segment is absent/non-object — a missing webhook segment stays ABSENT (no sink
 * wired ⇒ zero regression), unlike `accountHealth` no default is synthesized. A
 * present segment with `enabled` present OR any valid destination is kept.
 */
export function normalizeWebhookSegment(raw: unknown): WebhookConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const destinations: WebhookDestination[] = [];
  if (Array.isArray(r['destinations'])) {
    for (const entry of r['destinations']) {
      const d = normalizeWebhookDestination(entry);
      if (d) destinations.push(d);
    }
  }
  const enabled = r['enabled'] === true;
  if (!enabled && destinations.length === 0) return undefined;
  return { enabled, destinations };
}

/** Clamp a numeric to `[min, max]`, falling back to `fallback` when non-finite. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Fill + range-CLAMP the two queue segments to the frozen defaults. Lenient:
 * out-of-range persisted numerics are clamped to the nearest bound, never
 * thrown — strict validation is the daemon admin PUT's job. `enabled` coerces
 * to a boolean (default false).
 */
export function normalizeQueueSegments(raw: Partial<OutboundApiServerConfig> | undefined | null): {
  userMessageQueue: UserMessageQueueConfig;
  concurrencyQueue: ConcurrencyQueueConfig;
} {
  const umq = raw?.userMessageQueue;
  const cq = raw?.concurrencyQueue;
  return {
    userMessageQueue: {
      enabled: umq?.enabled === true,
      delayMs: clampNumber(umq?.delayMs, 0, 10_000, DEFAULT_USER_MESSAGE_QUEUE.delayMs),
      waitTimeoutMs: clampNumber(
        umq?.waitTimeoutMs,
        1000,
        300_000,
        DEFAULT_USER_MESSAGE_QUEUE.waitTimeoutMs,
      ),
    },
    concurrencyQueue: {
      maxQueueSizeFactor: clampNumber(
        cq?.maxQueueSizeFactor,
        1,
        10,
        DEFAULT_CONCURRENCY_QUEUE.maxQueueSizeFactor,
      ),
      minQueueSize: clampNumber(cq?.minQueueSize, 1, 100, DEFAULT_CONCURRENCY_QUEUE.minQueueSize),
      waitTimeoutMs: clampNumber(
        cq?.waitTimeoutMs,
        1000,
        300_000,
        DEFAULT_CONCURRENCY_QUEUE.waitTimeoutMs,
      ),
    },
  };
}

/** Structural subset of the settings store the config loader needs. */
export interface ApiServerSettingsStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
}

const ALL_ENDPOINTS: OutboundEndpoint[] = ['chat', 'responses', 'messages', 'gemini'];

/** A blank kind→ref map (every declared kind set to `''`) for an endpoint. */
function blankModelMap(endpoint: 'messages' | 'responses'): Record<string, ModelRef> {
  const modelMap: Record<string, ModelRef> = {};
  for (const kind of modelKindsForEndpoint(endpoint)) modelMap[kind] = '';
  return modelMap;
}

/**
 * A blank routing config for one endpoint (subscription OFF by default). The
 * shape depends on the endpoint class: kind-mapped → blank `modelMap`;
 * role-based → blank `defaultModel`/`backgroundModel`.
 */
function defaultEndpointConfig(endpoint: OutboundEndpoint): EndpointRoutingConfig {
  if (isKindMappedEndpoint(endpoint)) {
    return { endpoint, modelMap: blankModelMap(endpoint), useSubscription: false };
  }
  if (endpoint === 'chat') {
    return { endpoint, models: [], useSubscription: false };
  }
  return {
    endpoint,
    defaultModel: '',
    backgroundModel: '',
    useSubscription: false,
  };
}

/**
 * Validate the optional `chat` prefix-target map (openai-chat-bridge #11). Keeps
 * ONLY the three known prefixes (`claude`/`gpt`/`gemini`) whose value is a
 * non-empty trimmed `"providerId,modelId"` string; drops everything else. Returns
 * `undefined` when nothing valid remains (a prefix-mode chat endpoint with no
 * targets simply routes nothing until configured). Never throws.
 */
export function normalizePrefixTargets(raw: unknown): ModelPrefixTargets | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: ModelPrefixTargets = {};
  for (const key of ['claude', 'gpt', 'gemini'] as const) {
    const v = r[key];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim();
  }
  return out.claude || out.gpt || out.gemini ? out : undefined;
}

/**
 * Normalize ONE persisted endpoint block to the current heterogeneous shape,
 * dropping legacy/unknown fields with NO migration:
 *  - kind-mapped (`messages`/`responses`): keep ONLY the declared-kind `modelMap`
 *    (unknown kind keys dropped, missing kinds filled `''`, non-string values
 *    coerced to `''`); drop `defaultModel`/`backgroundModel`/`visionModel`/
 *    `backgroundModelIds`.
 *  - list-mapped (`chat`): keep `models` (string entries only, blanks dropped);
 *    drop `defaultModel`/`backgroundModel`/`backgroundModelIds`/`modelMap`.
 *  - role-based (`gemini`): keep `defaultModel`/`backgroundModel` (coerce
 *    non-string → `''`) and `backgroundModelIds` when it is an array; drop
 *    `modelMap`/`visionModel`.
 */
export function normalizeEndpointConfig(e: EndpointRoutingConfig): EndpointRoutingConfig {
  const endpoint = e.endpoint;
  const useSubscription = e.useSubscription === true;
  // OPTIONAL per-endpoint account/key binding (provider/subscription duality).
  // Carried ONLY when a non-blank string (absent/blank ⇒ account-pool / default-
  // key behavior); survives the per-class re-projection so an edited binding
  // round-trips through GET/PUT unchanged. Applies to ALL endpoint classes.
  const boundAccountId =
    typeof e.boundAccountId === 'string' && e.boundAccountId.trim() !== ''
      ? e.boundAccountId.trim()
      : undefined;
  // A binding without the new policy is legacy data: migrate it to strict
  // failure. Pool fallback is accepted only as the exact opt-in value. The
  // policy is omitted when the binding is cleared so stale UI fields cannot
  // affect a later unbound endpoint.
  const boundAccountFallbackPolicy: BoundAccountFallbackPolicy | undefined = boundAccountId
    ? e.boundAccountFallbackPolicy === 'pool'
      ? 'pool'
      : 'strict'
    : undefined;
  const boundKeyId =
    typeof e.boundKeyId === 'string' && e.boundKeyId.trim() !== ''
      ? e.boundKeyId
      : undefined;

  let config: EndpointRoutingConfig;
  if (isKindMappedEndpoint(endpoint)) {
    const rawMap =
      e.modelMap && typeof e.modelMap === 'object'
        ? (e.modelMap as Record<string, unknown>)
        : {};
    const modelMap: Record<string, ModelRef> = {};
    for (const kind of modelKindsForEndpoint(endpoint)) {
      const v = rawMap[kind];
      modelMap[kind] = typeof v === 'string' ? v : '';
    }
    config = { endpoint, modelMap, useSubscription };
  } else if (endpoint === 'chat') {
    const models = Array.isArray(e.models)
      ? e.models.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      : [];
    config = { endpoint, models, useSubscription };
    // openai-chat-bridge #11: `dispatchMode` defaults to `'list'` — carried ONLY
    // when explicitly `'prefix'` (any other/absent value is list, and a blank
    // list-mode chat config stays byte-identical). `prefixTargets` keeps only the
    // valid string refs for the three known prefixes; carried only in prefix mode.
    if (e.dispatchMode === 'prefix') {
      config.dispatchMode = 'prefix';
      const targets = normalizePrefixTargets(e.prefixTargets);
      if (targets) config.prefixTargets = targets;
    }
  } else {
    config = {
      endpoint,
      defaultModel: typeof e.defaultModel === 'string' ? e.defaultModel : '',
      backgroundModel: typeof e.backgroundModel === 'string' ? e.backgroundModel : '',
      useSubscription,
    };
    if (Array.isArray(e.backgroundModelIds)) {
      config.backgroundModelIds = e.backgroundModelIds;
    }
  }

  if (boundAccountId) {
    config.boundAccountId = boundAccountId;
    config.boundAccountFallbackPolicy = boundAccountFallbackPolicy;
  }
  if (boundKeyId) config.boundKeyId = boundKeyId;
  return config;
}

function normalizeBindingTarget(raw: unknown): GatewayBindingTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const target = raw as Record<string, unknown>;
  const providerId = typeof target.providerId === 'string' ? target.providerId.trim() : '';
  if (!providerId) return null;
  if (target.kind === 'account') {
    const accountId = typeof target.accountId === 'string' ? target.accountId.trim() : '';
    return accountId ? { kind: 'account', providerId, accountId } : null;
  }
  if (target.kind === 'account-group') {
    const group = typeof target.group === 'string' ? target.group.trim() : '';
    return group ? { kind: 'account-group', providerId, group } : null;
  }
  if (target.kind === 'account-pool') return { kind: 'account-pool', providerId };
  if (target.kind === 'provider') {
    const keyId = typeof target.keyId === 'string' ? target.keyId.trim() : '';
    return keyId ? { kind: 'provider', providerId, keyId } : { kind: 'provider', providerId };
  }
  return null;
}

function normalizeGatewayModelMappings(raw: unknown): GatewayModelMapping[] {
  if (!Array.isArray(raw)) return [];
  const mappings: GatewayModelMapping[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    const source = typeof value.source === 'string' ? value.source.trim() : '';
    const target = typeof value.target === 'string' ? value.target.trim() : '';
    if (!source || !target) continue;
    mappings.push({ source, target });
  }
  return mappings;
}

function hasConfiguredLegacyModels(config: EndpointRoutingConfig): boolean {
  return Object.values(config.modelMap ?? {}).some((value) => typeof value === 'string' && value.trim())
    || Boolean(config.models?.some((value) => typeof value === 'string' && value.trim()))
    || Boolean(config.defaultModel?.trim())
    || Boolean(config.backgroundModel?.trim())
    || Boolean(Object.values(config.prefixTargets ?? {}).some((value) => value?.trim()));
}

/** Split a `"providerId,modelId"` ref; `null` when either half is blank. */
function splitModelRef(ref: unknown): { providerId: string; modelId: string } | null {
  if (typeof ref !== 'string') return null;
  const idx = ref.indexOf(',');
  if (idx <= 0) return null;
  const providerId = ref.slice(0, idx).trim();
  const modelId = ref.slice(idx + 1).trim();
  return providerId && modelId ? { providerId, modelId } : null;
}

/** The upstream resource one legacy endpoint block pointed at, for `providerId`. */
function legacyTarget(
  config: EndpointRoutingConfig,
  providerId: string,
): GatewayBindingTarget {
  if (config.useSubscription) {
    if (config.boundAccountId) {
      return { kind: 'account', providerId, accountId: config.boundAccountId };
    }
    if (config.boundAccountGroup) {
      return { kind: 'account-group', providerId, group: config.boundAccountGroup };
    }
    return { kind: 'account-pool', providerId };
  }
  return config.boundKeyId
    ? { kind: 'provider', providerId, keyId: config.boundKeyId }
    : { kind: 'provider', providerId };
}

/**
 * Project ONE legacy endpoint block into downstream routes.
 *
 * A legacy block could name a different provider per model slot, which one
 * route (single target) cannot express — so the models are grouped by provider
 * and each group becomes its own route. They share a priority, and resolution
 * picks whichever can serve the requested model/kind, reproducing the legacy
 * per-slot dispatch.
 */
function legacyEndpointToBindings(config: EndpointRoutingConfig): GatewayBinding[] {
  // `pool` policy (or no bound account at all) kept serving from the wider pool,
  // which `next` preserves; `strict` refused, which is `fail`.
  const fallback: GatewayBindingFallback =
    config.boundAccountId && config.boundAccountFallbackPolicy === 'strict' ? 'fail' : 'next';
  const byProvider = new Map<string, GatewayBinding>();
  const routeFor = (providerId: string): GatewayBinding => {
    const existing = byProvider.get(providerId);
    if (existing) return existing;
    const created: GatewayBinding = {
      id: `legacy-${config.endpoint}-${providerId}`,
      name: `${config.endpoint} · ${providerId}`,
      enabled: true,
      keyScope: 'all',
      endpoint: config.endpoint,
      target: legacyTarget(config, providerId),
      fallback,
      modelMode: 'mapped',
    };
    byProvider.set(providerId, created);
    return created;
  };

  for (const [kind, ref] of Object.entries(config.modelMap ?? {})) {
    const parsed = splitModelRef(ref);
    if (!parsed) continue;
    const route = routeFor(parsed.providerId);
    route.modelMap = { ...route.modelMap, [kind]: ref as ModelRef };
  }
  for (const ref of config.models ?? []) {
    const parsed = splitModelRef(ref);
    if (!parsed) continue;
    const route = routeFor(parsed.providerId);
    route.models = [...(route.models ?? []), ref];
  }
  for (const [prefix, ref] of Object.entries(config.prefixTargets ?? {})) {
    const parsed = splitModelRef(ref);
    if (!parsed) continue;
    const route = routeFor(parsed.providerId);
    route.dispatchMode = 'prefix';
    route.prefixTargets = { ...route.prefixTargets, [prefix]: ref as ModelRef };
  }
  for (const [field, ref] of [
    ['defaultModel', config.defaultModel],
    ['backgroundModel', config.backgroundModel],
  ] as const) {
    const parsed = splitModelRef(ref);
    if (!parsed) continue;
    const route = routeFor(parsed.providerId);
    route[field] = ref as ModelRef;
    if (config.backgroundModelIds?.length) {
      route.backgroundModelIds = [...config.backgroundModelIds];
    }
  }
  return [...byProvider.values()];
}

/**
 * One-time migration off the removed global endpoint fallback: every configured
 * legacy endpoint block becomes an equivalent downstream route. Runs only when
 * the config carries no routes yet, so a user who has since deleted their routes
 * does not get the old ones resurrected. Idempotent by construction —
 * {@link normalizeServerConfig} blanks the legacy blocks in the same pass, so a
 * second run finds nothing to project.
 */
export function legacyEndpointsToBindings(
  endpoints: readonly EndpointRoutingConfig[],
): GatewayBinding[] {
  return endpoints
    .filter((endpoint) => hasConfiguredLegacyModels(endpoint))
    .flatMap((endpoint) => legacyEndpointToBindings(endpoint));
}

/** Normalize independent gateway bindings while dropping malformed entries. */
export function normalizeGatewayBindings(raw: unknown): GatewayBinding[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const bindings: GatewayBinding[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const endpoint = value.endpoint as OutboundEndpoint;
    const target = normalizeBindingTarget(value.target);
    if (!id || seen.has(id) || !name || !ALL_ENDPOINTS.includes(endpoint) || !target) continue;
    seen.add(id);
    const normalizedRoute = normalizeEndpointConfig({
      ...(value as unknown as EndpointRoutingConfig),
      endpoint,
      useSubscription: target.kind !== 'provider',
    });
    const apiKeyIds = Array.isArray(value.apiKeyIds)
      ? [...new Set(value.apiKeyIds.filter((key): key is string => typeof key === 'string' && key.trim() !== '').map((key) => key.trim()))]
      : [];
    const keyScope = value.keyScope === 'selected'
      ? 'selected'
      : value.keyScope === 'all'
        ? 'all'
        : apiKeyIds.length > 0
          ? 'selected'
          : 'all';
    const modelMappings = normalizeGatewayModelMappings(value.modelMappings);
    const modelMode = value.modelMode === 'passthrough'
      ? 'passthrough'
      : value.modelMode === 'mapped'
        ? 'mapped'
        : modelMappings.length > 0 || hasConfiguredLegacyModels(normalizedRoute)
          ? 'mapped'
          : 'passthrough';
    const priority =
      typeof value.priority === 'number' && Number.isFinite(value.priority)
        ? Math.max(0, Math.min(10_000, Math.round(value.priority)))
        : undefined;
    const binding: GatewayBinding = {
      id,
      name,
      enabled: value.enabled !== false,
      keyScope,
      endpoint,
      target,
      // Legacy `'global'` meant "yield to the removed global endpoint fallback";
      // it now yields to the next matching route, which is the same default.
      fallback: value.fallback === 'fail' ? 'fail' : 'next',
      modelMode,
    };
    if (apiKeyIds.length > 0) binding.apiKeyIds = apiKeyIds;
    if (modelMappings.length > 0) binding.modelMappings = modelMappings;
    if (priority !== undefined) binding.priority = priority;
    if (normalizedRoute.modelMap) binding.modelMap = normalizedRoute.modelMap;
    if (normalizedRoute.models) binding.models = normalizedRoute.models;
    if (normalizedRoute.dispatchMode) binding.dispatchMode = normalizedRoute.dispatchMode;
    if (normalizedRoute.prefixTargets) binding.prefixTargets = normalizedRoute.prefixTargets;
    if (normalizedRoute.defaultModel !== undefined) binding.defaultModel = normalizedRoute.defaultModel;
    if (normalizedRoute.backgroundModel !== undefined) binding.backgroundModel = normalizedRoute.backgroundModel;
    if (normalizedRoute.backgroundModelIds) binding.backgroundModelIds = normalizedRoute.backgroundModelIds;
    bindings.push(binding);
  }
  return bindings;
}

/** The default server config: disabled, loopback, four blank endpoints. */
export function defaultServerConfig(): OutboundApiServerConfig {
  const queues = normalizeQueueSegments(undefined);
  return {
    enabled: false,
    networkBinding: false,
    endpoints: ALL_ENDPOINTS.map(defaultEndpointConfig),
    bindings: [],
    port: DEFAULT_OUTBOUND_PORT,
    userMessageQueue: queues.userMessageQueue,
    concurrencyQueue: queues.concurrencyQueue,
    accountHealth: normalizeAccountHealth(undefined),
    accountProbe: normalizeAccountProbe(undefined),
    allowanceScheduling: normalizeAllowanceScheduling(undefined),
    audit: normalizeAudit(undefined),
    billing: normalizeBilling(undefined),
    fingerprint: normalizeFingerprint(undefined),
    voucher: normalizeVoucher(undefined),
    anthropic: normalizeAnthropicSegment(undefined),
    images: normalizeImagesServerConfig(undefined),
    search: normalizeSearchServerConfig(undefined),
  };
}

/**
 * Normalize a (possibly partial / legacy) persisted config to the full shape:
 * ensure all four endpoints exist, `useSubscription` defaults OFF, and a port
 * is present.
 */
export function normalizeServerConfig(
  raw: Partial<OutboundApiServerConfig> | undefined | null,
): OutboundApiServerConfig {
  const base = defaultServerConfig();
  if (!raw) return base;
  const byEndpoint = new Map<OutboundEndpoint, EndpointRoutingConfig>();
  for (const e of raw.endpoints ?? []) {
    if (e && ALL_ENDPOINTS.includes(e.endpoint)) {
      byEndpoint.set(e.endpoint, normalizeEndpointConfig(e));
    }
  }
  const queues = normalizeQueueSegments(raw);
  // The legacy per-endpoint blocks are no longer a routing source. Project them
  // into routes once (only when there are none yet, so deleting every route
  // stays deleted), then hand back BLANK blocks — routes are the only SSOT, and
  // a blank block can never trip the startup model-kind gate.
  const legacyEndpoints = ALL_ENDPOINTS.map((ep) => byEndpoint.get(ep) ?? defaultEndpointConfig(ep));
  const persistedBindings = normalizeGatewayBindings(raw.bindings);
  const bindings = persistedBindings.length > 0
    ? persistedBindings
    : normalizeGatewayBindings(legacyEndpointsToBindings(legacyEndpoints));
  const config: OutboundApiServerConfig = {
    enabled: raw.enabled === true,
    networkBinding: raw.networkBinding === true,
    endpoints: ALL_ENDPOINTS.map(defaultEndpointConfig),
    bindings,
    port: raw.port ?? base.port,
    userMessageQueue: queues.userMessageQueue,
    concurrencyQueue: queues.concurrencyQueue,
    accountHealth: normalizeAccountHealth(raw),
    accountProbe: normalizeAccountProbe(raw),
    allowanceScheduling: normalizeAllowanceScheduling(raw),
    audit: normalizeAudit(raw),
    billing: normalizeBilling(raw),
    fingerprint: normalizeFingerprint(raw),
    voucher: normalizeVoucher(raw),
    anthropic: normalizeAnthropicSegment(raw),
    images: normalizeImagesServerConfig(raw.images),
    search: normalizeSearchServerConfig(raw.search),
  };
  // Proxy segment is only carried when valid — absent stays absent (direct fetch).
  const proxy = normalizeProxySegment(raw.proxy);
  if (proxy) config.proxy = proxy;
  // Webhook segment is only carried when valid — absent stays absent (no sink).
  const webhook = normalizeWebhookSegment(raw.webhook);
  if (webhook) config.webhook = webhook;
  return config;
}

/** Load the persisted config (normalized), defaulting on a missing/blank key. */
export async function loadServerConfig(
  store: ApiServerSettingsStore,
): Promise<OutboundApiServerConfig> {
  const raw = await store.get<Partial<OutboundApiServerConfig>>(
    OUTBOUND_API_SERVER_CONFIG_KEY,
  );
  return normalizeServerConfig(raw);
}

/** Persist the config. */
export async function saveServerConfig(
  store: ApiServerSettingsStore,
  config: OutboundApiServerConfig,
): Promise<void> {
  await store.set(OUTBOUND_API_SERVER_CONFIG_KEY, config);
}

/** Apply a partial patch to a config, returning the merged whole. */
export function mergeServerConfig(
  current: OutboundApiServerConfig,
  patch: Partial<OutboundApiServerConfig>,
): OutboundApiServerConfig {
  return normalizeServerConfig({
    enabled: patch.enabled ?? current.enabled,
    networkBinding: patch.networkBinding ?? current.networkBinding,
    endpoints: patch.endpoints ?? current.endpoints,
    bindings: patch.bindings ?? current.bindings,
    port: patch.port ?? current.port,
    userMessageQueue: patch.userMessageQueue ?? current.userMessageQueue,
    concurrencyQueue: patch.concurrencyQueue ?? current.concurrencyQueue,
    accountHealth: patch.accountHealth ?? current.accountHealth,
    accountProbe: patch.accountProbe ?? current.accountProbe,
    allowanceScheduling: patch.allowanceScheduling ?? current.allowanceScheduling,
    audit: patch.audit ?? current.audit,
    billing: patch.billing ?? current.billing,
    // Proxy is layer-replaced (not deep-merged): a PUT carrying `proxy` swaps the
    // whole segment; omitting it keeps the current one. `undefined` on both ⇒ absent.
    proxy: patch.proxy ?? current.proxy,
    // Webhook is layer-replaced too (a PUT carrying `webhook` swaps the whole
    // segment; omitting it keeps the current one). `undefined` on both ⇒ absent.
    webhook: patch.webhook ?? current.webhook,
    // Fingerprint is always-filled (normalizeFingerprint synthesizes a default);
    // a PUT carrying it replaces the segment, else the current one is kept.
    fingerprint: patch.fingerprint ?? current.fingerprint,
    // Voucher is always-filled (normalizeVoucher synthesizes a default); a PUT
    // carrying it replaces the segment, else the current one is kept.
    voucher: patch.voucher ?? current.voucher,
    // Anthropic segment is always-filled (normalizeAnthropicSegment synthesizes
    // defaults); a PUT carrying it replaces the segment, else kept.
    anthropic: patch.anthropic ?? current.anthropic,
    // Images is a complete nested policy segment. Missing legacy data remains
    // default-disabled; a present PUT replaces the whole normalized segment.
    images: patch.images ?? current.images,
    // Search is layer-replaced like Images: a PUT carrying `search` swaps the
    // whole normalized segment, omitting it keeps the current one.
    search: patch.search ?? current.search,
  });
}

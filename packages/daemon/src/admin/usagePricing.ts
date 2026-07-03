/**
 * usagePricing — the admin API's usage-stats + pricing-table surface
 * (usage-pricing child; extracted from adminApi.ts following the
 * `cliLaunch.ts` pattern: pure handlers returning `{ status, body }`, with the
 * http plumbing staying in the router).
 *
 * Usage queries go through the `UsageRecorder` facade (which delegates to the
 * JSONL store); pricing mutations go through the `PricingEngine`; the row
 * DELETE goes through the CONCRETE `JsonPricingStore` (delete is store-local —
 * the core port is frozen) followed by an engine cache invalidation.
 *
 * SECRET DISCIPLINE (IN-never-OUT): pricing rows and usage aggregates carry no
 * key material — none of these handlers reads a secret store or a config
 * secret field, so no GET can leak one. By-api-key label resolution reads ONLY
 * the pool keys' `{ id, label }` (never `apiKey`).
 *
 * Conflict resolution is STATELESS: `fetch-latest` returns the conflicts in
 * full (`current` + `incoming`) and the client echoes each decision back WITH
 * its `incoming` entry; the handler rebuilds the pending map per request. No
 * server-side conflict session exists between the two calls.
 *
 * @module @omnicross/daemon/admin/usagePricing
 */

import type {
  PricingConflictDecision,
  PricingEntryInput,
} from '@omnicross/contracts/pricing-types';
import type { UsageDateRange, UsageTimeBucket } from '@omnicross/contracts/usage-stats-types';
import type { PricingEngine, UsageRecorder } from '@omnicross/core/usage';

import { type DaemonConfig, loadConfig } from '../config';
import type { JsonPricingStore } from '../ports/JsonPricingStore';

/** The result shape the router writes back (mirrors `CliHandlerResult`). */
export interface UsagePricingResult {
  status: number;
  body: unknown;
}

/** The live handles this surface operates over (threaded from `AdminApiDeps`). */
export interface UsagePricingDeps {
  /** Path to `config.json` — read ONLY for pool-key `{ id, label }` resolution. */
  readonly configPath: string;
  /** Stats query facade (delegates to the JSONL usage-event store). */
  readonly usageRecorder: UsageRecorder;
  /** Pricing engine (upsert/fetch/resolve + cache invalidation). */
  readonly pricingEngine: PricingEngine;
  /** CONCRETE pricing store — only for the store-local `delete`. */
  readonly pricingStore: JsonPricingStore;
}

const err = (status: number, message: string): UsagePricingResult => ({
  status,
  body: { error: { type: 'admin_api_error', message } },
});

/** Parse a query value as a finite integer (unix millis); null on failure. */
function parseFiniteInt(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

/** Validate `startTs`/`endTs` query params → `UsageDateRange` or an error result. */
function parseRange(query: URLSearchParams): UsageDateRange | UsagePricingResult {
  const startTs = parseFiniteInt(query.get('startTs'));
  const endTs = parseFiniteInt(query.get('endTs'));
  if (startTs === null || endTs === null) {
    return err(400, 'startTs and endTs are required finite-integer unix-millis query params');
  }
  return { startTs, endTs };
}

const isRange = (v: UsageDateRange | UsagePricingResult): v is UsageDateRange =>
  (v as UsageDateRange).startTs !== undefined && !('status' in v);

/**
 * Upper-bound millis per bucket (shortest possible span) — used ONLY to project
 * a pathological-range guard COUNT, never for actual bucketing (the store walks
 * real local boundaries). `month` uses 28 days so the projection never
 * UNDER-counts (a short month would otherwise let a bigger range slip the cap).
 */
const BUCKET_SPAN_MS: Record<UsageTimeBucket, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  month: 28 * 86_400_000,
};

/** C1 guard: reject a range that would project more than this many buckets. */
const MAX_TIMESERIES_BUCKETS = 2000;

// ── Usage stats ───────────────────────────────────────────────────────────────

/** `GET /admin/api/usage/totals|by-model|by-api-key?startTs&endTs` */
export async function handleUsageGet(
  view: string | undefined,
  query: URLSearchParams,
  deps: UsagePricingDeps,
): Promise<UsagePricingResult> {
  const range = parseRange(query);
  if (!isRange(range)) return range;

  switch (view) {
    case 'totals':
      return { status: 200, body: await deps.usageRecorder.getTotals(range) };
    case 'by-model':
      return { status: 200, body: await deps.usageRecorder.getByModel(range) };
    case 'timeseries': {
      const bucket = query.get('bucket');
      if (bucket !== 'hour' && bucket !== 'day' && bucket !== 'month') {
        return err(400, "bucket must be one of 'hour', 'day', 'month'");
      }
      // C1 guard: clamp `endTs` to now (a future endTs would zero-fill empty
      // buckets forever) and reject a range that projects a pathological bucket
      // count. The projection uses the shortest-possible bucket span so it never
      // under-counts; an EMPTY range (`startTs >= endTs`) skips the cap and the
      // store returns `[]`.
      const now = Date.now();
      const clamped: UsageDateRange = { startTs: range.startTs, endTs: Math.min(range.endTs, now) };
      if (clamped.startTs < clamped.endTs) {
        const projected = Math.ceil((clamped.endTs - clamped.startTs) / BUCKET_SPAN_MS[bucket]) + 1;
        if (projected > MAX_TIMESERIES_BUCKETS) {
          return err(
            400,
            `requested range projects ~${projected} '${bucket}' buckets (max ${MAX_TIMESERIES_BUCKETS}); narrow the range or use a coarser bucket`,
          );
        }
      }
      return { status: 200, body: await deps.usageRecorder.getTimeSeries(clamped, bucket) };
    }
    case 'by-api-key': {
      const rows = await deps.usageRecorder.getByApiKey(range);
      const labels = poolKeyLabels(loadConfig(deps.configPath));
      return {
        status: 200,
        body: rows.map((r) => {
          if (r.apiKeyId === null) {
            // The unattributed sentinel group: null id, null provider.
            return { ...r, label: 'unattributed', providerId: null };
          }
          const known = labels.get(r.apiKeyId);
          return known
            ? { ...r, label: known.label, providerId: known.providerId }
            : { ...r, label: r.apiKeyId };
        }),
      };
    }
    default:
      return err(404, `unknown usage view '${view ?? ''}'`);
  }
}

/**
 * Resolve pool-key display labels from the provider catalog (design D4: label
 * resolution lives HERE so the store stays config-schema-free). Reads ONLY
 * `{ id, label }` per pool key — never the key value.
 */
function poolKeyLabels(cfg: DaemonConfig): Map<string, { label: string; providerId: string }> {
  const out = new Map<string, { label: string; providerId: string }>();
  for (const provider of cfg.providers) {
    for (const key of provider.apiKeys ?? []) {
      out.set(key.id, {
        label: key.label && key.label.length > 0 ? key.label : key.id,
        providerId: provider.id,
      });
    }
  }
  return out;
}

// ── Pricing table ─────────────────────────────────────────────────────────────

/** Sentinel for an optional price that is PRESENT but not a finite number/null. */
const INVALID_PRICE = Symbol('invalid-price');

/** Optional cache price: absent/null → null; finite number → it; anything else → invalid (400). */
function parseOptionalPrice(
  b: Record<string, unknown>,
  key: string,
): number | null | typeof INVALID_PRICE {
  if (!(key in b) || b[key] === null || b[key] === undefined) return null;
  const v = b[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : INVALID_PRICE;
}

/**
 * Shape-guard a `PricingEntryInput` body: reject missing ids, non-finite
 * required prices, and PRESENT-but-non-numeric optional cache prices (a typo'd
 * cache price must 400, not silently coerce to null).
 */
export function parsePricingEntryInput(raw: unknown): PricingEntryInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const providerId = typeof b['providerId'] === 'string' && b['providerId'].trim() ? b['providerId'].trim() : '';
  const modelId = typeof b['modelId'] === 'string' && b['modelId'].trim() ? b['modelId'].trim() : '';
  const inputPrice = b['inputPricePer1m'];
  const outputPrice = b['outputPricePer1m'];
  if (!providerId || !modelId) return null;
  if (typeof inputPrice !== 'number' || !Number.isFinite(inputPrice)) return null;
  if (typeof outputPrice !== 'number' || !Number.isFinite(outputPrice)) return null;
  const cacheRead = parseOptionalPrice(b, 'cacheReadPricePer1m');
  const cacheWrite = parseOptionalPrice(b, 'cacheWritePricePer1m');
  if (cacheRead === INVALID_PRICE || cacheWrite === INVALID_PRICE) return null;
  return {
    providerId,
    modelId,
    inputPricePer1m: inputPrice,
    outputPricePer1m: outputPrice,
    cacheReadPricePer1m: cacheRead,
    cacheWritePricePer1m: cacheWrite,
  };
}

/** `GET /admin/api/pricing` → the full `PricingEntry[]`. */
export async function handlePricingList(deps: UsagePricingDeps): Promise<UsagePricingResult> {
  return { status: 200, body: { entries: await deps.pricingEngine.getAll() } };
}

/** `PUT /admin/api/pricing` (body `PricingEntryInput`) → manual upsert (source 'user'). */
export async function handlePricingUpsert(
  body: Record<string, unknown>,
  deps: UsagePricingDeps,
): Promise<UsagePricingResult> {
  const input = parsePricingEntryInput(body);
  if (!input) {
    return err(400, 'invalid pricing entry (providerId, modelId, finite numeric inputPricePer1m/outputPricePer1m required)');
  }
  const entry = await deps.pricingEngine.upsertManual(input);
  return { status: 200, body: { entry } };
}

/** `DELETE /admin/api/pricing?providerId&modelId` → `{ deleted }`. */
export async function handlePricingDelete(
  query: URLSearchParams,
  deps: UsagePricingDeps,
): Promise<UsagePricingResult> {
  const providerId = query.get('providerId')?.trim() ?? '';
  const modelId = query.get('modelId')?.trim() ?? '';
  if (!providerId || !modelId) {
    return err(400, 'delete requires providerId and modelId query params');
  }
  const deleted = await deps.pricingStore.delete(providerId, modelId);
  if (deleted) await deps.pricingEngine.invalidateCache();
  return { status: 200, body: { deleted } };
}

/**
 * `POST /admin/api/pricing/fetch-latest` → refresh from the pricing source.
 * Applied rows come back as a COUNT (the full table is thousands of rows —
 * the UI re-fetches `GET /pricing`); conflicts come back IN FULL (the conflict
 * dialog needs `current` + `incoming`).
 */
export async function handlePricingFetchLatest(
  deps: UsagePricingDeps,
): Promise<UsagePricingResult> {
  try {
    const result = await deps.pricingEngine.fetchLatestFromSource();
    return {
      status: 200,
      body: {
        appliedCount: result.applied.length,
        conflicts: result.conflicts,
        fetchedAt: result.fetchedAt,
        sourceUrl: result.sourceUrl,
      },
    };
  } catch (e) {
    return err(502, `pricing-source fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * `POST /admin/api/pricing/resolve-conflicts` — STATELESS resolution. Body:
 * `{ resolutions: Array<{ providerId, modelId, action, incoming }> }`; each
 * decision carries EXPLICIT top-level row ids AND echoes back the conflict's
 * `incoming` entry, from which the pending map (keyed `providerId::modelId`)
 * is rebuilt per request.
 *
 * GUARDS (statelessness must not widen authority):
 * - top-level `providerId`/`modelId` are REQUIRED and must MATCH the echoed
 *   incoming's ids (400 on mismatch — a miswired client, fail the batch);
 * - an 'overwrite' only applies when the targeted row CURRENTLY exists with
 *   `userEdited: true` (i.e. it is still actually a conflict). A row that was
 *   deleted/changed since fetch-latest is rejected PER-ROW as stale — counted
 *   in the additive `staleCount` (the rest of the batch still applies), since
 *   staleness is a data race, not a malformed request.
 */
export async function handlePricingResolveConflicts(
  body: Record<string, unknown>,
  deps: UsagePricingDeps,
): Promise<UsagePricingResult> {
  const raw = body['resolutions'];
  if (!Array.isArray(raw)) {
    return err(400, 'resolve-conflicts requires { resolutions: [...] }');
  }
  // Exact-row existence index (the ENGINE's getEntry has wildcard/model-alias
  // fallbacks — wrong for an existence check, so read the store directly).
  const currentRows = await deps.pricingStore.getAll();
  const userEditedKeys = new Set(
    currentRows.filter((r) => r.userEdited).map((r) => `${r.providerId}::${r.modelId}`),
  );

  const decisions: PricingConflictDecision[] = [];
  const pendingIncoming = new Map<string, PricingEntryInput>();
  let staleCount = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object') return err(400, 'invalid resolution entry');
    const r = item as Record<string, unknown>;
    const action = r['action'];
    if (action !== 'overwrite' && action !== 'skip') {
      return err(400, "resolution action must be 'overwrite' or 'skip'");
    }
    const providerId = typeof r['providerId'] === 'string' && r['providerId'].trim() ? r['providerId'].trim() : '';
    const modelId = typeof r['modelId'] === 'string' && r['modelId'].trim() ? r['modelId'].trim() : '';
    if (!providerId || !modelId) {
      return err(400, 'each resolution requires top-level providerId and modelId');
    }
    const incoming = parsePricingEntryInput(r['incoming']);
    if (!incoming) return err(400, 'each resolution must echo a valid incoming pricing entry');
    if (incoming.providerId !== providerId || incoming.modelId !== modelId) {
      return err(400, 'resolution providerId/modelId must match the echoed incoming entry');
    }
    const key = `${providerId}::${modelId}`;
    if (action === 'overwrite' && !userEditedKeys.has(key)) {
      // Stale: the row no longer exists as a user-edited conflict — reject
      // THIS row only (data race with a delete/edit since fetch-latest).
      staleCount += 1;
      continue;
    }
    decisions.push({ providerId, modelId, action });
    pendingIncoming.set(key, incoming);
  }
  const resolution = await deps.pricingEngine.resolveConflicts(decisions, pendingIncoming);
  return { status: 200, body: { ...resolution, staleCount } };
}

/**
 * accountModelMap — pure helpers for the per-account `supportedModels` field
 * (subscription-account-model-map, design D1).
 *
 * CRS dual-format `SubscriptionAccountEntry.supportedModels`:
 *  - **array** — an ALLOW-LIST of supported logical models; no remap.
 *  - **object** — the KEYS are the same allow-list AND each VALUE is the
 *    account's ACTUAL upstream model (a logical→actual remap).
 *  - **absent** — supports every model, no remap (zero regression).
 *
 * Both helpers are pure. They fold into the EXISTING `accountSelection`
 * eligibility path (`accountSupportsModel` → `gateSchedulable`) and the outbound
 * body-model finalize point (`remapForAccount`); they add no new mechanism.
 *
 * Model ids are compared on ONE canonical form — the bare, trimmed, lower-cased
 * id (a `"providerId,modelId"` ref reduces to its `modelId`) — identical to the
 * key-model restriction's `canonicalModelId` (#6), so membership is case- and
 * ref-shape-insensitive and an alias cannot slip past.
 *
 * @module scheduler/accountModelMap
 */

/** The `supportedModels` value shape (mirrors the contract field). */
export type SupportedModels = string[] | Record<string, string>;

/**
 * Canonicalize a model id (or `"providerId,modelId"` ref) to the one comparison
 * form: the bare, trimmed, lower-cased modelId. Mirrors `keyPolicy.canonicalModelId`
 * (#6) so the account-model allow-list matches models exactly the way the key
 * restriction does.
 */
function canonicalModelId(value: string): string {
  const idx = value.indexOf(',');
  const bare = idx >= 0 ? value.slice(idx + 1) : value;
  return bare.trim().toLowerCase();
}

/**
 * Whether an account with this `supportedModels` supports the resolved model.
 *  - absent ⇒ `true` (supports everything — zero regression).
 *  - array  ⇒ case-insensitive membership.
 *  - object ⇒ the model is one of the KEYS (the keys are the allow-list).
 */
export function accountSupportsModel(
  supportedModels: SupportedModels | undefined,
  model: string,
): boolean {
  if (!supportedModels) return true;
  const target = canonicalModelId(model);
  if (Array.isArray(supportedModels)) {
    return supportedModels.some((m) => canonicalModelId(m) === target);
  }
  return Object.keys(supportedModels).some((k) => canonicalModelId(k) === target);
}

/**
 * The ACTUAL upstream model this account serves the logical model as. Only the
 * OBJECT form remaps: when a key matches the resolved model its value is
 * returned; an array form, an absent map, or a missing key ⇒ the model unchanged.
 */
export function remapForAccount(
  supportedModels: SupportedModels | undefined,
  model: string,
): string {
  if (!supportedModels || Array.isArray(supportedModels)) return model;
  const target = canonicalModelId(model);
  for (const [key, actual] of Object.entries(supportedModels)) {
    if (canonicalModelId(key) === target) return actual;
  }
  return model;
}

/**
 * The remapped model to REPORT to the relay, or `undefined` when there is no
 * actual change (array form / absent / no matching key / a remap equal to the
 * resolved model). Returning `undefined` on a no-op keeps the outbound body
 * byte-identical on the same-format path (the relay only rewrites `body.model`
 * when a value is present).
 */
export function remapReportForAccount(
  supportedModels: SupportedModels | undefined,
  model: string | undefined,
): string | undefined {
  if (!model) return undefined;
  const remapped = remapForAccount(supportedModels, model);
  return remapped === model ? undefined : remapped;
}

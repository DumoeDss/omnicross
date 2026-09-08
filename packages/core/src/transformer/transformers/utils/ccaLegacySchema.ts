/**
 * ccaLegacySchema — the schema cleaner for the CCA LEGACY `parameters` tool
 * schema form (the Claude family on Antigravity; antigravity-subscription-
 * provider design / spec: legacy `parametersJsonSchema` → `parameters` with
 * the Google-unsupported JSON Schema keywords removed — `$schema` /
 * `additionalProperties` and friends trigger an upstream 400).
 *
 * Mirrors the reference cleaner's semantics (`geminiSchemaCleaner` in the
 * relay-service reference): a WIDENING projection — everything the output
 * accepts is a subset of the input's acceptance:
 *   - `$ref` / `$id` / `$defs` / `definitions` / `format` and other unsupported
 *     keywords are dropped (a `$ref` degrades to a description hint),
 *   - `anyOf` / `oneOf` collapse to the most-structured alternative with a
 *     type hint in the description,
 *   - `allOf` merges properties/required,
 *   - `const` folds into `enum`, array `type` flattens to its primary with a
 *     hint, boolean `additionalProperties` is dropped (noted as a hint),
 *   - constraint keywords that have no legacy representation
 *     (`pattern`/`minLength`/…) move into the description.
 */

interface CleanedSchema {
  type?: string;
  description?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  enum?: unknown[];
  [key: string]: unknown;
}

function appendHint(description: string | undefined, hint: string | undefined): string {
  if (!hint) return description ?? '';
  if (!description) return hint;
  return `${description} (${hint})`;
}

function refHint(refValue: string): string {
  const name = refValue.slice(refValue.lastIndexOf('/') + 1);
  return name ? `See: ${name}` : '';
}

/** Constraint keywords with no legacy-schema representation → description hints. */
const CONSTRAINT_KEYS = [
  'minLength',
  'maxLength',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'pattern',
  'minItems',
  'maxItems',
] as const;

function normalizeType(typeValue: unknown): { type: string; hint: string } {
  if (typeof typeValue === 'string' && typeValue) return { type: typeValue, hint: '' };
  if (!Array.isArray(typeValue) || typeValue.length === 0) return { type: '', hint: '' };
  const raw = typeValue.map((t) => (t == null ? '' : String(t))).filter(Boolean);
  const hasNull = raw.includes('null');
  const nonNull = raw.filter((t) => t !== 'null');
  const primary = nonNull[0] || 'string';
  const hints: string[] = [];
  if (nonNull.length > 1) hints.push(`Accepts: ${nonNull.join(' | ')}`);
  if (hasNull) hints.push('nullable');
  return { type: primary, hint: hints.join('; ') };
}

function schemaScore(schema: unknown): number {
  if (!schema || typeof schema !== 'object') return 0;
  const s = schema as Record<string, unknown>;
  const t = typeof s['type'] === 'string' ? (s['type'] as string) : '';
  if (t === 'object' || (s['properties'] && typeof s['properties'] === 'object')) return 3;
  if (t === 'array' || s['items']) return 2;
  if (t && t !== 'null') return 1;
  return 0;
}

/**
 * Clean one JSON Schema node into the legacy-compatible subset. Pure; never
 * throws (an unrecognizable node degrades to `{type:'object', properties:{}}`).
 */
export function cleanSchemaForCcaLegacyParameters(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const s = schema as Record<string, unknown>;

  // `$ref` has no legacy representation — degrade to a description hint.
  const ref = s['$ref'];
  if (typeof ref === 'string' && ref) {
    return {
      type: 'object',
      description: appendHint(
        typeof s['description'] === 'string' ? s['description'] : undefined,
        refHint(ref),
      ),
      properties: {},
    };
  }

  // `anyOf` / `oneOf` → the most-structured alternative + a type hint.
  const alternatives = Array.isArray(s['anyOf'])
    ? (s['anyOf'] as unknown[])
    : Array.isArray(s['oneOf'])
      ? (s['oneOf'] as unknown[])
      : null;
  if (alternatives && alternatives.length > 0) {
    let best = alternatives[0];
    let bestScore = -1;
    const types: string[] = [];
    for (const alternative of alternatives) {
      const score = schemaScore(alternative);
      const normalized = normalizeType((alternative as Record<string, unknown>)?.['type']);
      if (normalized.type) types.push(normalized.type);
      if (score > bestScore) {
        bestScore = score;
        best = alternative;
      }
    }
    const cleaned = cleanSchemaForCcaLegacyParameters(best) as CleanedSchema;
    const typeHint = types.length > 1 ? `Accepts: ${[...new Set(types)].join(' || ')}` : '';
    return {
      ...cleaned,
      description: appendHint(
        appendHint(cleaned.description, typeof s['description'] === 'string' ? s['description'] : undefined),
        typeHint,
      ),
    };
  }

  // `allOf` → merge properties/required/items/enum across branches.
  if (Array.isArray(s['allOf']) && (s['allOf'] as unknown[]).length > 0) {
    const merged: CleanedSchema = {};
    let mergedDescription: string | undefined =
      typeof s['description'] === 'string' ? s['description'] : undefined;
    const required = new Set<string>();
    const properties: Record<string, unknown> = {};
    for (const branch of s['allOf'] as unknown[]) {
      const cleaned = cleanSchemaForCcaLegacyParameters(branch) as CleanedSchema;
      if (cleaned.description) mergedDescription = appendHint(mergedDescription, cleaned.description);
      for (const key of cleaned.required ?? []) required.add(key);
      Object.assign(properties, cleaned.properties ?? {});
      if (cleaned.type && !merged.type) merged.type = cleaned.type;
      if (cleaned.items && !merged.items) merged.items = cleaned.items;
      if (cleaned.enum && !merged.enum) merged.enum = cleaned.enum;
    }
    if (Object.keys(properties).length > 0) {
      merged.type = merged.type ?? 'object';
      merged.properties = properties;
      const validRequired = [...required].filter((key) => key in properties);
      if (validRequired.length > 0) merged.required = validRequired;
    }
    if (mergedDescription) merged.description = mergedDescription;
    return cleanSchemaForCcaLegacyParameters(merged);
  }

  const result: CleanedSchema = {};
  const constraintHints: string[] = [];

  if (typeof s['description'] === 'string') result.description = s['description'];

  for (const key of CONSTRAINT_KEYS) {
    const value = s[key];
    if (value === undefined || value === null || typeof value === 'object') continue;
    constraintHints.push(`${key}: ${String(value)}`);
  }

  // `const` folds into `enum` (no legacy const support).
  if (s['const'] !== undefined && !Array.isArray(s['enum'])) {
    result.enum = [s['const']];
  }

  if (Array.isArray(s['enum'])) {
    const values = (s['enum'] as unknown[]).filter(
      (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
    );
    if (values.length > 0) result.enum = values;
    if (result.enum && result.enum.length > 1 && result.enum.length <= 10) {
      result.description = appendHint(
        result.description,
        `Allowed: ${(result.enum as unknown[]).map(String).join(', ')}`,
      );
    }
  }

  const { type: normalizedType, hint: typeHint } = normalizeType(s['type']);
  if (normalizedType) result.type = normalizedType;
  if (typeHint) result.description = appendHint(result.description, typeHint);

  if (constraintHints.length > 0) {
    result.description = appendHint(result.description, constraintHints.join(', '));
  }

  // Boolean `additionalProperties` is rejected by the legacy form — drop it
  // and note it (a widening: dropping the restriction broadens acceptance).
  if (s['additionalProperties'] === false) {
    result.description = appendHint(result.description, 'No extra properties allowed');
  }

  if (s['properties'] && typeof s['properties'] === 'object' && !Array.isArray(s['properties'])) {
    const properties: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(s['properties'] as Record<string, unknown>)) {
      properties[name] = cleanSchemaForCcaLegacyParameters(property);
    }
    result.type = result.type ?? 'object';
    result.properties = properties;
  }

  if (s['items'] !== undefined) {
    result.type = result.type ?? 'array';
    result.items = cleanSchemaForCcaLegacyParameters(s['items']);
  }

  if (Array.isArray(s['required']) && result.properties) {
    const required = (s['required'] as unknown[]).filter(
      (key): key is string =>
        typeof key === 'string' && !!key && key in (result.properties as Record<string, unknown>),
    );
    if (required.length > 0) result.required = required;
  }

  // Everything else ($schema/$id/$defs/definitions/format/…) is dropped.

  if (!result.type) {
    result.type = result.properties ? 'object' : result.items !== undefined ? 'array' : 'object';
  }
  if (result.type === 'object' && !result.properties) {
    result.properties = {};
  }
  return result;
}

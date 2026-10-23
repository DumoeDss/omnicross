/**
 * ccaLegacySchema — the schema cleaner for the CCA LEGACY `parameters` tool
 * schema form (the Claude family on Antigravity; antigravity-subscription-
 * provider design / spec: legacy `parametersJsonSchema` → `parameters` with
 * the Google-unsupported JSON Schema keywords removed — `$schema` /
 * `additionalProperties` and friends trigger an upstream 400).
 *
 * Projects JSON Schema onto the legacy wire subset. Constraints without a wire
 * representation remain description hints; resolvable local references are
 * expanded before projection, and unresolved/cyclic references fail explicitly:
 *   - `$id` / `$defs` / `definitions` / `format` and other unsupported
 *     keywords are dropped after local references have been resolved,
 *   - nullable unions use `nullable`; general `anyOf` / `oneOf` keep the
 *     most-structured branch and retain the alternatives as prompt constraints,
 *   - `allOf` merges properties/required,
 *   - `const` folds into `enum`, type arrays use a primary type plus hints,
 *     boolean `additionalProperties` is dropped (noted as a hint),
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
  const type = typeof s['type'] === 'string' ? s['type'] : '';
  if (type === 'object' || (s['properties'] && typeof s['properties'] === 'object')) return 3;
  if (type === 'array' || s['items']) return 2;
  return type && type !== 'null' ? 1 : 0;
}

/**
 * Clean one JSON Schema node into the legacy-compatible subset. Local references
 * must resolve without cycles; otherwise sending an empty schema would lose the
 * tool's argument contract.
 */
export function cleanSchemaForCcaLegacyParameters(schema: unknown): Record<string, unknown> {
  return clean(schema, schema, new Set<string>());
}

function clean(schema: unknown, root: unknown, references: Set<string>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const s = schema as Record<string, unknown>;

  const ref = s['$ref'];
  if (typeof ref === 'string' && ref) {
    if (!ref.startsWith('#/') || references.has(ref)) {
      throw new Error(`CCA tool schema cannot represent reference: ${ref}`);
    }
    let target: unknown = root;
    for (const token of ref.slice(2).split('/')) {
      const key = decodeURIComponent(token).replace(/~1/g, '/').replace(/~0/g, '~');
      if (!target || typeof target !== 'object' || !Object.prototype.hasOwnProperty.call(target, key)) {
        throw new Error(`CCA tool schema reference not found: ${ref}`);
      }
      target = (target as Record<string, unknown>)[key];
    }
    references.add(ref);
    try {
      const { $ref: _ref, ...siblings } = s;
      return clean({ allOf: [target, siblings] }, root, references);
    } finally {
      references.delete(ref);
    }
  }

  // General unions remain the existing legacy prompt-constrained projection,
  // not an equivalent JSON Schema validator. Preserve every alternative in the
  // description rather than keeping only its type name.
  const alternatives = Array.isArray(s['anyOf'])
    ? (s['anyOf'] as unknown[])
    : Array.isArray(s['oneOf'])
      ? (s['oneOf'] as unknown[])
      : null;
  if (alternatives && alternatives.length > 0) {
    let best = alternatives.find((alternative) => alternative &&
      typeof alternative === 'object' && (alternative as Record<string, unknown>)['type'] !== 'null') ?? alternatives[0];
    let bestScore = schemaScore(best);
    for (const alternative of alternatives) {
      const score = schemaScore(alternative);
      if (score > bestScore) {
        best = alternative;
        bestScore = score;
      }
    }
    const hasNull = alternatives.some((alternative) => alternative &&
      typeof alternative === 'object' && (alternative as Record<string, unknown>)['type'] === 'null');
    const { anyOf: _anyOf, oneOf: _oneOf, ...siblings } = s;
    const projected = clean({ allOf: [best, siblings] }, root, references) as CleanedSchema;
    if (hasNull) projected.nullable = true;
    if (alternatives.length > (hasNull ? 2 : 1)) {
      projected.description = appendHint(projected.description,
        `${Array.isArray(s['oneOf']) ? 'Exactly one' : 'At least one'} schema must match: ${JSON.stringify(alternatives)}`);
    }
    return projected;
  }

  // `allOf` → merge properties/required/items/enum across branches.
  if (Array.isArray(s['allOf']) && (s['allOf'] as unknown[]).length > 0) {
    const merged: CleanedSchema = {};
    let mergedDescription: string | undefined;
    const required = new Set<string>();
    const properties: Record<string, unknown> = {};
    const { allOf, ...siblings } = s;
    for (const branch of [siblings, ...(allOf as unknown[])]) {
      const cleaned = clean(branch, root, references) as CleanedSchema;
      if (cleaned.description) mergedDescription = appendHint(mergedDescription, cleaned.description);
      for (const key of cleaned.required ?? []) required.add(key);
      const branchRequired = branch && typeof branch === 'object'
        ? (branch as Record<string, unknown>)['required'] : undefined;
      if (Array.isArray(branchRequired)) {
        for (const key of branchRequired) if (typeof key === 'string') required.add(key);
      }
      for (const [name, property] of Object.entries(cleaned.properties ?? {})) {
        properties[name] = Object.prototype.hasOwnProperty.call(properties, name)
          ? clean({ allOf: [properties[name], property] }, root, references)
          : property;
      }
      if (cleaned.type && branch && typeof branch === 'object' &&
          ['type', 'properties', 'items', 'enum', 'const', '$ref', 'anyOf', 'oneOf', 'allOf']
            .some((key) => key in branch)) {
        if (merged.type && merged.type !== cleaned.type) {
          if ([merged.type, cleaned.type].every((type) => type === 'number' || type === 'integer')) {
            merged.type = 'integer';
          } else {
            throw new Error('CCA tool schema cannot represent conflicting allOf types');
          }
        } else {
          merged.type = cleaned.type;
        }
      }
      if (cleaned.items) {
        merged.items = merged.items
          ? clean({ allOf: [merged.items, cleaned.items] }, root, references)
          : cleaned.items;
      }
      if (cleaned.enum) {
        merged.enum = merged.enum ? merged.enum.filter((value) => cleaned.enum!.includes(value)) : cleaned.enum;
        if (merged.enum.length === 0) throw new Error('CCA tool schema has an empty allOf enum intersection');
      }
      if (cleaned.nullable === true) merged.nullable = true;
    }
    if (Object.keys(properties).length > 0) {
      merged.type = merged.type ?? 'object';
      merged.properties = properties;
      const validRequired = [...required].filter((key) => key in properties);
      if (validRequired.length > 0) merged.required = validRequired;
    }
    if (mergedDescription) merged.description = mergedDescription;
    return clean(merged, root, references);
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
  if (s['nullable'] === true || (Array.isArray(s['type']) && s['type'].includes('null'))) {
    result.nullable = true;
  }
  if (!result.type && result.enum?.length) {
    const valueType = typeof result.enum[0];
    if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
      result.type = valueType;
    }
  }
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
      properties[name] = clean(property, root, references);
    }
    result.type = result.type ?? 'object';
    result.properties = properties;
  }

  if (s['items'] !== undefined) {
    result.type = result.type ?? 'array';
    result.items = clean(s['items'], root, references);
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

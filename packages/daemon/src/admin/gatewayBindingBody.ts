import type { OutboundApiServerConfig } from '@omnicross/core/outbound-api';

const ENDPOINTS = new Set(['chat', 'responses', 'messages', 'gemini']);
const TARGET_KINDS = new Set(['account', 'account-group', 'account-pool', 'provider']);
/** `global` is the pre-migration spelling of `next`; accepted, normalized in core. */
const FALLBACKS = new Set(['next', 'fail', 'global']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function validateStringArray(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.some((entry) => !nonBlank(entry))) {
    errors.push(`${path} must be an array of non-empty strings`);
  }
}

/** Strict admin-boundary validation for a present gateway binding segment. */
export function validateGatewayBindingsSegment(
  patch: Partial<OutboundApiServerConfig>,
): string[] {
  if (!Object.prototype.hasOwnProperty.call(patch, 'bindings')) return [];
  const raw = (patch as Record<string, unknown>).bindings;
  if (!Array.isArray(raw)) return ['bindings must be an array'];
  if (raw.length > 1_000) return ['bindings cannot contain more than 1000 entries'];

  const errors: string[] = [];
  const ids = new Set<string>();
  raw.forEach((entry, index) => {
    const path = `bindings[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (!nonBlank(entry.id)) errors.push(`${path}.id is required`);
    else if (ids.has(entry.id.trim())) errors.push(`${path}.id must be unique`);
    else ids.add(entry.id.trim());
    if (!nonBlank(entry.name)) errors.push(`${path}.name is required`);
    if (typeof entry.enabled !== 'boolean') errors.push(`${path}.enabled must be boolean`);
    if (!ENDPOINTS.has(String(entry.endpoint))) errors.push(`${path}.endpoint is invalid`);
    if (!FALLBACKS.has(String(entry.fallback))) {
      errors.push(`${path}.fallback must be next or fail`);
    }
    if (
      entry.priority !== undefined &&
      (typeof entry.priority !== 'number' ||
        !Number.isInteger(entry.priority) ||
        entry.priority < 0 ||
        entry.priority > 10_000)
    ) {
      errors.push(`${path}.priority must be an integer from 0 to 10000`);
    }
    if (entry.apiKeyIds !== undefined) validateStringArray(entry.apiKeyIds, `${path}.apiKeyIds`, errors);
    if (entry.keyScope !== undefined && entry.keyScope !== 'all' && entry.keyScope !== 'selected') {
      errors.push(`${path}.keyScope must be all or selected`);
    }
    if (entry.modelMode !== undefined && entry.modelMode !== 'passthrough' && entry.modelMode !== 'mapped') {
      errors.push(`${path}.modelMode must be passthrough or mapped`);
    }
    if (entry.modelMappings !== undefined) {
      if (!Array.isArray(entry.modelMappings)) {
        errors.push(`${path}.modelMappings must be an array`);
      } else if (entry.modelMappings.length > 100) {
        errors.push(`${path}.modelMappings cannot contain more than 100 entries`);
      } else if (entry.modelMappings.some(
        (mapping) => !isRecord(mapping) || !nonBlank(mapping.source) || !nonBlank(mapping.target),
      )) {
        errors.push(`${path}.modelMappings must contain non-empty source and target strings`);
      }
    }

    if (!isRecord(entry.target) || !TARGET_KINDS.has(String(entry.target.kind))) {
      errors.push(`${path}.target is invalid`);
    } else {
      if (!nonBlank(entry.target.providerId)) errors.push(`${path}.target.providerId is required`);
      if (entry.target.kind === 'account' && !nonBlank(entry.target.accountId)) {
        errors.push(`${path}.target.accountId is required`);
      }
      if (entry.target.kind === 'account-group' && !nonBlank(entry.target.group)) {
        errors.push(`${path}.target.group is required`);
      }
      if (entry.target.kind === 'provider' && entry.target.keyId !== undefined && !nonBlank(entry.target.keyId)) {
        errors.push(`${path}.target.keyId must be a non-empty string`);
      }
    }

    if (entry.modelMap !== undefined) {
      if (!isRecord(entry.modelMap) || Object.values(entry.modelMap).some((value) => typeof value !== 'string')) {
        errors.push(`${path}.modelMap must contain string values`);
      }
    }
    if (entry.models !== undefined) validateStringArray(entry.models, `${path}.models`, errors);
    if (entry.backgroundModelIds !== undefined) {
      validateStringArray(entry.backgroundModelIds, `${path}.backgroundModelIds`, errors);
    }
    for (const field of ['defaultModel', 'backgroundModel'] as const) {
      if (entry[field] !== undefined && typeof entry[field] !== 'string') {
        errors.push(`${path}.${field} must be a string`);
      }
    }
  });
  return errors;
}

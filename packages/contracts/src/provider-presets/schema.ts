/**
 * Provider preset schema — SINGLE SOURCE OF TRUTH for the on-disk JSON shape.
 *
 * The Zod schema (`presetSchema`) is used by the loader (`index.ts`) to validate
 * every `presets/<id>.json` at module initialization, throwing early in dev on a
 * malformed preset. The hand-authored `PresetProviderTemplate` interface (which
 * `extends ProviderTemplate`) remains the TypeScript type and is re-exported here
 * verbatim so every import site of `@omnicross/contracts/provider-presets` is unchanged.
 *
 * Strictness (see design.md D3):
 *  - `apiFormat`  → validated against the `ApiFormat` union (drift-guarded below).
 *  - transformer / feature / icon names → loose `z.string()`, NOT an allowlist
 *    (those names are registered dynamically elsewhere; coupling the schema to
 *    them would create a cross-package validation dependency this refactor avoids).
 */
import { z } from 'zod';

import type {
  ApiFormat,
  CompletionSettings,
  ModelConfig,
  ModelGroup,
  ProviderTemplate,
  TransformerConfig,
} from '../llm-config';

// Re-export the preset types + the API_MODE_IDS const so import sites resolve
// `@omnicross/contracts/provider-presets` ↦ this module's barrel unchanged.
export type {
  ApiMode,
  ApiModeId,
  CodingPlanConfig,
  PresetProviderTemplate,
  ProviderModelMapping,
  ProviderSearchConfig,
  SearchCapability,
} from './types';
export { API_MODE_IDS } from './types';

// ----------------------------------------------------------------------------
// apiFormat enum — mirrors the `ApiFormat` union with a compile-time drift guard.
// ----------------------------------------------------------------------------

const API_FORMATS = [
  'openai',
  'anthropic',
  'google',
  'azure-openai',
  'openai-response',
] as const;

// Drift guard: fails to compile if `API_FORMATS` and the `ApiFormat` union
// diverge in either direction.
type _AssertEnumSubsetOfUnion = (typeof API_FORMATS)[number] extends ApiFormat ? true : never;
type _AssertUnionSubsetOfEnum = ApiFormat extends (typeof API_FORMATS)[number] ? true : never;
const _enumDriftGuard: _AssertEnumSubsetOfUnion & _AssertUnionSubsetOfEnum = true;
void _enumDriftGuard;

// ----------------------------------------------------------------------------
// Sub-schemas
// ----------------------------------------------------------------------------

const searchCapabilitySchema = z.enum([
  'model-param',
  'builtin-tool',
  'mcp',
  'sdk-native',
  'none',
]);

const providerSearchConfigSchema = z
  .object({
    type: searchCapabilitySchema,
    paramName: z.string().optional(),
    paramValue: z.unknown().optional(),
    extraParams: z.record(z.string(), z.unknown()).optional(),
    toolDefinition: z.record(z.string(), z.unknown()).optional(),
    conflictsWithFC: z.boolean().optional(),
    mcpServerId: z.string().optional(),
    applicableModels: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

const apiModeSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    baseUrl: z.string(),
    apiKey: z.string().optional(),
    apiKeyPrefix: z.string().optional(),
    note: z.string().optional(),
  })
  .passthrough();

// ModelConfig / TransformerConfig / CompletionSettings / ModelGroup are kept
// permissive — they are already TypeScript-typed at the consuming end. We only
// assert object/array shape so a grossly malformed preset still fails fast.
const modelConfigSchema = z
  .object({ id: z.string(), name: z.string(), enabled: z.boolean() })
  .passthrough();

const transformerConfigSchema = z.record(z.string(), z.unknown());

// ----------------------------------------------------------------------------
// Preset schema (SSOT) — validates the JSON subset; passthrough preserves any
// other ProviderTemplate field verbatim so the parsed value is assignable to
// PresetProviderTemplate.
// ----------------------------------------------------------------------------

export const presetSchema = z
  .object({
    id: z.string().min(1),
    presetId: z.string().min(1),
    name: z.string().min(1),
    apiFormat: z.enum(API_FORMATS),
    api_base_url: z.string(),
    models: z.array(z.string()),
    apiType: z.string().optional(),
    nameKey: z.string().optional(),
    modelsEndpoint: z.string().optional(),
    apiVersion: z.string().optional(),
    modelConfigs: z.array(modelConfigSchema).optional(),
    modelGroups: z.array(z.record(z.string(), z.unknown())).optional(),
    transformer: transformerConfigSchema.optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
    website: z.string().optional(),
    docsUrl: z.string().optional(),
    defaultSettings: z.record(z.string(), z.unknown()).optional(),
    isSystem: z.boolean().optional(),
    isOfficial: z.boolean().optional(),
    maxConcurrency: z.number().optional(),
    codingPlanBaseUrl: z.string().optional(),
    codingPlanSeparateKey: z.boolean().optional(),
    features: z.array(z.string()).optional(),
    searchConfig: providerSearchConfigSchema.optional(),
    apiModes: z.array(apiModeSchema).optional(),
    // Additive, reserved (design D2). Inert for current consumers.
    revision: z.number().int().positive().optional(),
  })
  .passthrough();

export type ParsedPreset = z.infer<typeof presetSchema>;

// Compile-time assertion that a parsed preset is structurally assignable to the
// hand-authored type (modulo the loose fields validated as records above).
type _ParsedFields = Pick<
  ProviderTemplate,
  'id' | 'name' | 'api_base_url' | 'models' | 'apiFormat'
>;
type _AssertParsedAssignable = ParsedPreset extends _ParsedFields ? true : never;
const _parsedAssignableGuard: _AssertParsedAssignable = true;
void _parsedAssignableGuard;

// Silence "unused import" for type-only names referenced in the doc/guards.
export type _SchemaTypeRefs = ModelConfig | ModelGroup | TransformerConfig | CompletionSettings;

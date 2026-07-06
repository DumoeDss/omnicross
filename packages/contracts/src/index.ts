/**
 * @omnicross/contracts — barrel.
 *
 * Dependency-light, host-agnostic contract types + runtime-value helpers
 * shared by the `@omnicross/*` packages.
 *
 * This barrel is a CONVENIENCE aggregate. The `@omnicross/*` import sites use
 * the SPECIFIC subpaths (`@omnicross/contracts/<module>`) to keep the dependency
 * graph tight; prefer those over importing from the barrel. Where two modules
 * export the same name (e.g. preset re-exports that overlap llm-config), the
 * `export *` aggregation drops the ambiguous name from the barrel — import it
 * from its owning subpath instead.
 */

export * from './account-tokens-types';
export * from './audit-types';
export * from './canonical-models';
export * from './completion-types';
export * from './endpoint-resolver';
export * from './extended-context';
export * from './health-logging-types';
export * from './llm-config';
export * from './mcp-types';
export * from './message-blocks';
export * from './pricing-types';
export * from './provider-presets';
export * from './subscription-types';
export * from './thinking-config';
export * from './usage-stats-types';
export * from './usage-types';
export * from './webhook-types';
export * from './websearch-types';

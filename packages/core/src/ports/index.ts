/**
 * Serving-core host ports.
 *
 * Barrel re-exporting the core-owned port interfaces the serving core
 * depends on instead of concrete host classes, plus named aliases for two edges
 * that are already port-shaped (`UsageRecorderImport`, `OutboundKeyDb`). The host
 * embedder supplies every implementation at bootstrap.
 *
 * The aliases are TYPE re-exports only — they do NOT re-wire those two ports;
 * their existing plumbing, call sites, and behavior are untouched.
 */

export type { CorePaths } from './core-paths';
export type { Logger } from './logger';
export type { PricingStore } from './pricing-store';
export type { ProviderConfigSource } from './provider-config-source';
export type { UsageEventStore } from './usage-event-store';
export type {
  CoreUsageEvent,
  CoreUsageTokenCounts,
  UsageEventSink,
} from './usage-event-sink';
export type { WebSearchBackend } from './web-search-backend';

// ── Named aliases for the already-port-shaped edges (formalize, do NOT rewire) ──

/** The usage-record sink the proxy already injects (structural `record()`). */
export type { UsageRecorderImport as UsageSink } from '../provider-proxy/types';

/** The outbound-key credential store the outbound API already injects. */
export type { OutboundKeyDb as OutboundCredentialStore } from '../outbound-api/types';

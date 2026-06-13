/**
 * Usage module — provider-generic pricing engine + usage-stats recorder.
 *
 * Storage is host-injected via the `PricingStore` / `UsageEventStore` ports
 * (see `../ports`). Consumed via `@omnicross/core` or `@omnicross/core/usage`.
 *
 * @module usage
 */

export type { CostCalculation, PricingEngineOptions } from './pricing-engine';
export { PricingEngine } from './pricing-engine';
export type { UsageRecorderOptions, UsageRecordInput } from './usage-recorder';
export { UsageRecorder } from './usage-recorder';

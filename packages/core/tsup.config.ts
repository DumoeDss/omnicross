import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

// This package's own version — the workspace version (all packages are bumped
// lock-step by scripts/release-version.mjs). Baked into the bundle via `define`
// below so the OpenCodeGo egress identity can build `omnicross/<version>` —
// the same mechanism as the daemon's `__DAEMON_VERSION__`.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

// @omnicross/core is consumed via SUBPATHS. The entry KEY = the subpath consumers
// import (relative to the package root); tsup writes each to dist/<key>.{js,cjs,d.ts}
// so the package.json "./*" exports wildcard resolves every subpath. Directory-index
// subpaths (completion, outbound-api, provider-proxy) flatten to dist/<name>.js.
// splitting:false keeps each entry self-contained; external deps stay external.
export default defineConfig({
  define: {
    __OMNICROSS_VERSION__: JSON.stringify(pkg.version),
  },
  entry: {
    index: 'src/index.ts',
    ApiConverter: 'src/ApiConverter.ts',
    'auth/GeminiCodeAssistProjectResolver': 'src/auth/GeminiCodeAssistProjectResolver.ts',
    completion: 'src/completion/index.ts',
    'image-generation': 'src/image-generation/index.ts',
    'openai-operation': 'src/openai-operation/index.ts',
    'completion/ApiKeyPoolService': 'src/completion/ApiKeyPoolService.ts',
    'completion/BuiltinToolExecutor': 'src/completion/BuiltinToolExecutor.ts',
    'completion/CompletionService': 'src/completion/CompletionService.ts',
    'completion/NativeSearchInjector': 'src/completion/NativeSearchInjector.ts',
    'completion/native-search-types': 'src/completion/native-search-types.ts',
    'completion/openrouter-headers': 'src/completion/openrouter-headers.ts',
    'completion/openrouter-models': 'src/completion/openrouter-models.ts',
    'completion/ProviderSearchInjector': 'src/completion/ProviderSearchInjector.ts',
    'completion/types': 'src/completion/types.ts',
    'completion/url-builder': 'src/completion/url-builder.ts',
    'outbound-api': 'src/outbound-api/index.ts',
    'outbound-api/auditCapture': 'src/outbound-api/auditCapture.ts',
    'outbound-api/auditRedact': 'src/outbound-api/auditRedact.ts',
    'outbound-api/billingCapture': 'src/outbound-api/billingCapture.ts',
    'outbound-api/quotaWarn': 'src/outbound-api/quotaWarn.ts',
    'outbound-api/routeResolver': 'src/outbound-api/routeResolver.ts',
    'outbound-api/subscriptionRegistryPort': 'src/outbound-api/subscriptionRegistryPort.ts',
    'outbound-api/types': 'src/outbound-api/types.ts',
    'pipeline/auditSink': 'src/pipeline/auditSink.ts',
    'pipeline/auditUsageStash': 'src/pipeline/auditUsageStash.ts',
    'pipeline/billingEmit': 'src/pipeline/billingEmit.ts',
    'pipeline/AuthSource': 'src/pipeline/AuthSource.ts',
    'pipeline/AccountAllowanceStore': 'src/pipeline/AccountAllowanceStore.ts',
    'pipeline/AccountAllowanceScheduling': 'src/pipeline/AccountAllowanceScheduling.ts',
    'pipeline/antigravityQuotaFamily': 'src/pipeline/antigravityQuotaFamily.ts',
    'pipeline/AccountRouteActivity': 'src/pipeline/AccountRouteActivity.ts',
    'pipeline/BoundAccountSelectionError': 'src/pipeline/BoundAccountSelectionError.ts',
    'pipeline/executeProviderCall': 'src/pipeline/executeProviderCall.ts',
    'pipeline/LlmConfigProviderAuth': 'src/pipeline/LlmConfigProviderAuth.ts',
    'pipeline/resolveProviderChain': 'src/pipeline/resolveProviderChain.ts',
    'pipeline/resolveSubscriptionChain': 'src/pipeline/resolveSubscriptionChain.ts',
    'pipeline/ServerOverloadCounter': 'src/pipeline/ServerOverloadCounter.ts',
    'pipeline/SubscriptionAccountHealth': 'src/pipeline/SubscriptionAccountHealth.ts',
    'pipeline/SubscriptionAuthSource': 'src/pipeline/SubscriptionAuthSource.ts',
    'pipeline/SubscriptionAuthStrategy': 'src/pipeline/SubscriptionAuthStrategy.ts',
    'pipeline/upstreamFetch': 'src/pipeline/upstreamFetch.ts',
    'pipeline/upstreamTrace': 'src/pipeline/upstreamTrace.ts',
    'pipeline/webhookEmit': 'src/pipeline/webhookEmit.ts',
    ports: 'src/ports/index.ts',
    'ports/gemini-code-assist-resolver': 'src/ports/gemini-code-assist-resolver.ts',
    'ports/pricing-store': 'src/ports/pricing-store.ts',
    'ports/provider-config-source': 'src/ports/provider-config-source.ts',
    'ports/usage-event-store': 'src/ports/usage-event-store.ts',
    'ports/web-search-backend': 'src/ports/web-search-backend.ts',
    'provider-proxy': 'src/provider-proxy/index.ts',
    'provider-proxy/identity/codexCliHeaders': 'src/provider-proxy/identity/codexCliHeaders.ts',
    'provider-proxy/identity/SubscriptionIdentityStore': 'src/provider-proxy/identity/SubscriptionIdentityStore.ts',
    'provider-proxy/identity/fingerprintHeaders': 'src/provider-proxy/identity/fingerprintHeaders.ts',
    // opencodego-egress-identity: the OpenCodeGo outbound identity headers (UA
    // + x-opencode-session). Consumed by the subscriptions auth strategy, the
    // daemon bootstrap setter, and the daemon usage collector — must be a
    // registered subpath or those imports resolve to undefined in dist.
    'provider-proxy/identity/openCodeGoHeaders': 'src/provider-proxy/identity/openCodeGoHeaders.ts',
    'provider-proxy/ingress/providerProxyShared': 'src/provider-proxy/ingress/providerProxyShared.ts',
    'provider-proxy/matchText': 'src/provider-proxy/matchText.ts',
    'provider-proxy/ProviderProxy': 'src/provider-proxy/ProviderProxy.ts',
    'provider-proxy/types': 'src/provider-proxy/types.ts',
    // search-phase1-orchestrator (阶段3): the search runtime — registry,
    // orchestrator, and the one entry protocol frontends and hosts call.
    search: 'src/search/index.ts',
    // search-phase1-api-providers (阶段4): the keyed API search providers. ONE
    // entry for the whole tree — adapters/transport/rotator are internals.
    // (`search/egress.ts` needs no entry of its own: it ships through the bare
    // `search` index above, which is where the HTTP slice imports it from too.)
    'search/api': 'src/search/api/index.ts',
    // search-phase1-http-slice: the keyless HTTP search providers. ONE entry for
    // the whole tree — parsers/transport/trust are internals.
    'search/http': 'src/search/http/index.ts',
    serializeError: 'src/serializeError.ts',
    'sse-parser': 'src/sse-parser.ts',
    transformer: 'src/transformer/index.ts',
    usage: 'src/usage/index.ts',
    'usage/pricing-engine': 'src/usage/pricing-engine.ts',
    'usage/usage-recorder': 'src/usage/usage-recorder.ts',
    'transformer/anthropicBetaInject': 'src/transformer/anthropicBetaInject.ts',
    'transformer/TransformerChainExecutor': 'src/transformer/TransformerChainExecutor.ts',
    'transformer/TransformerService': 'src/transformer/TransformerService.ts',
    'transformer/types': 'src/transformer/types.ts',
    'transformer/transformers': 'src/transformer/transformers/index.ts',
    'transformer/transformers/AnthropicTransformer': 'src/transformer/transformers/AnthropicTransformer.ts',
    // claude-api-protocol-fidelity: the daemon hot-sets the synthetic-ping
    // heartbeat via this module-level setter at applyConfig. Registered here
    // per the "new subpath exports MUST be registered in tsup.config" rule.
    'transformer/transformers/AnthropicOpenAIToAnthropicStream':
      'src/transformer/transformers/AnthropicOpenAIToAnthropicStream.ts',
    'transformer/transformers/GeminiCodeAssistTransformer': 'src/transformer/transformers/GeminiCodeAssistTransformer.ts',
    // antigravity-subscription-provider: the antigravity/hub masquerade identity
    // (UA version hot-probe + per-wire-id request profiles). Consumed by the
    // subscriptions auth strategy, the transformer, and the daemon collectors —
    // must be a registered subpath or those imports resolve to undefined.
    'transformer/transformers/antigravityIdentity': 'src/transformer/transformers/antigravityIdentity.ts',
    'transformer/transformers/AntigravityTransformer': 'src/transformer/transformers/AntigravityTransformer.ts',
    'transformer/transformers/antigravityFailover': 'src/transformer/transformers/antigravityFailover.ts',
    'transformer/transformers/GeminiTransformer': 'src/transformer/transformers/GeminiTransformer.ts',
    'transformer/transformers/OpenAIResponseTransformer': 'src/transformer/transformers/OpenAIResponseTransformer.ts',
    'transformer/transformers/OpenAITransformer': 'src/transformer/transformers/OpenAITransformer.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: false,
  clean: true,
  // ESM code-splitting is REQUIRED for correctness, not an optimization:
  // without it every entry inlines its own copy of shared internal modules,
  // which duplicates MODULE-LEVEL SINGLETONS (e.g. the outbound-api
  // subscriptionRegistryPort slot, shared executors) — a setter reached via
  // one entry becomes invisible to a reader inlined into another entry.
  // esbuild only supports splitting for ESM; the CJS output keeps per-entry
  // inlining (known limitation — every supported runtime here consumes ESM).
  splitting: true,
});

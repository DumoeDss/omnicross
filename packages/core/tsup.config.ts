import { defineConfig } from 'tsup';

// @omnicross/core is consumed via SUBPATHS. The entry KEY = the subpath consumers
// import (relative to the package root); tsup writes each to dist/<key>.{js,cjs,d.ts}
// so the package.json "./*" exports wildcard resolves every subpath. Directory-index
// subpaths (completion, outbound-api, provider-proxy) flatten to dist/<name>.js.
// splitting:false keeps each entry self-contained; external deps stay external.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    ApiConverter: 'src/ApiConverter.ts',
    'auth/GeminiCodeAssistProjectResolver': 'src/auth/GeminiCodeAssistProjectResolver.ts',
    completion: 'src/completion/index.ts',
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
    'outbound-api/routeResolver': 'src/outbound-api/routeResolver.ts',
    'outbound-api/subscriptionRegistryPort': 'src/outbound-api/subscriptionRegistryPort.ts',
    'outbound-api/types': 'src/outbound-api/types.ts',
    'pipeline/AuthSource': 'src/pipeline/AuthSource.ts',
    'pipeline/executeProviderCall': 'src/pipeline/executeProviderCall.ts',
    'pipeline/LlmConfigProviderAuth': 'src/pipeline/LlmConfigProviderAuth.ts',
    'pipeline/resolveProviderChain': 'src/pipeline/resolveProviderChain.ts',
    'pipeline/resolveSubscriptionChain': 'src/pipeline/resolveSubscriptionChain.ts',
    'pipeline/SubscriptionAccountHealth': 'src/pipeline/SubscriptionAccountHealth.ts',
    'pipeline/SubscriptionAuthSource': 'src/pipeline/SubscriptionAuthSource.ts',
    'pipeline/SubscriptionAuthStrategy': 'src/pipeline/SubscriptionAuthStrategy.ts',
    ports: 'src/ports/index.ts',
    'ports/gemini-code-assist-resolver': 'src/ports/gemini-code-assist-resolver.ts',
    'ports/pricing-store': 'src/ports/pricing-store.ts',
    'ports/provider-config-source': 'src/ports/provider-config-source.ts',
    'ports/usage-event-store': 'src/ports/usage-event-store.ts',
    'ports/web-search-backend': 'src/ports/web-search-backend.ts',
    'provider-proxy': 'src/provider-proxy/index.ts',
    'provider-proxy/ingress/providerProxyShared': 'src/provider-proxy/ingress/providerProxyShared.ts',
    'provider-proxy/matchText': 'src/provider-proxy/matchText.ts',
    'provider-proxy/ProviderProxy': 'src/provider-proxy/ProviderProxy.ts',
    'provider-proxy/types': 'src/provider-proxy/types.ts',
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
    'transformer/transformers/GeminiCodeAssistTransformer': 'src/transformer/transformers/GeminiCodeAssistTransformer.ts',
    'transformer/transformers/GeminiTransformer': 'src/transformer/transformers/GeminiTransformer.ts',
    'transformer/transformers/OpenAIResponseTransformer': 'src/transformer/transformers/OpenAIResponseTransformer.ts',
    'transformer/transformers/OpenCodeGoTransformer': 'src/transformer/transformers/OpenCodeGoTransformer.ts',
    'transformer/transformers/ReasoningTransformer': 'src/transformer/transformers/ReasoningTransformer.ts',
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

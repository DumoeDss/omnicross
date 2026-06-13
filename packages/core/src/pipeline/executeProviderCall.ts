/**
 * executeProviderCall — shared provider-request exchange core.
 *
 * Phase 1 of the `provider-request-pipeline` OpenSpec change (design D2/D4/D6).
 *
 * The three consumer paths (the wire-format proxy handler, the host engine
 * adapter, TransformerHandler) each re-implemented the same middle:
 *
 *   executor.executeRequestChain(...) → resolve URL → assemble headers
 *   → fetch → (optionally) executor.executeResponseChain(...)
 *
 * This module owns ONLY that common exchange. Every step that diverges
 * between the three sites is injected via options so each call site keeps
 * its CURRENT behavior verbatim:
 *
 *   - URL building       → `resolveUrl(config)`
 *   - header assembly    → `buildHeaders(config)`
 *   - post-transform body mutation → `prepareBody(requestBody, config)`
 *   - fetch mechanism    → `fetchFn(url, headers, body)`
 *   - endpoint transform → `endpointTransformer` (proxy = Anthropic; others omit)
 *   - response chain     → `runResponseChain` flag + `responseChainRequest`
 *
 * IMPORTANT subtleties preserved verbatim:
 *
 *   1. The response chain's FIRST argument is the REQUEST body, NOT the
 *      mutated `prepareBody` output. Each site passes a DIFFERENT variable
 *      there today (proxy → post-transform `requestBody`; Adapter/Handler →
 *      the pre-transform `unifiedRequest`), so the core does not hard-code
 *      it — `responseChainRequest` is supplied by the caller when
 *      `runResponseChain` is true.
 *
 *   2. The engine adapter and Handler check `response.ok` on the RAW fetch response
 *      BEFORE running the response chain. Those sites therefore set
 *      `runResponseChain: false` (the default) and run `executeResponseChain`
 *      themselves at the call site after their `.ok` gate. The proxy uses
 *      `fetchWithRetry` (no raw `.ok` gate between fetch and the response
 *      chain) so it sets `runResponseChain: true` and lets the core run it.
 *
 * @module pipeline/executeProviderCall
 */

import type { ChainExecutionOptions } from '../transformer/TransformerChainExecutor';
import type { TransformerChainExecutor } from '../transformer/TransformerChainExecutor';
import type {
  LLMProvider as TransformerLLMProvider,
  RequestConfig,
  ResolvedTransformerChain,
  Transformer,
  UnifiedChatRequest,
} from '../transformer/types';

/**
 * Inputs for {@link executeProviderCall}. Everything that differs between
 * the three ingress adapters is injected here; the core owns only the
 * fixed orchestration between `executeRequestChain` and the fetch.
 */
export interface ProviderCallContext {
  /** Shared (stateless) transformer-chain executor. */
  executor: TransformerChainExecutor;
  /**
   * The request to send into the request chain. For the proxy this is the
   * raw Anthropic wire body (decoded by `endpointTransformer`); for the
   * unified ingresses this is a `UnifiedChatRequest`.
   */
  request: UnifiedChatRequest | Record<string, unknown>;
  /** Provider config in transformer runtime shape. */
  provider: TransformerLLMProvider;
  /** Resolved transformer chain (provider + model transformers). */
  chain: ResolvedTransformerChain;
  /**
   * Endpoint transformer — present only for wire-format ingress (the proxy
   * passes `AnthropicTransformer`). Omitted for unified ingresses.
   */
  endpointTransformer?: Transformer;
  /**
   * 1M-context opt-in, threaded straight through to
   * `executeRequestChain`'s `extendedContext` option, exactly as the call
   * sites pass it today.
   */
  extendedContext?: ChainExecutionOptions['extendedContext'];
  /**
   * Build the target URL from the post-request-chain `config`. Each site
   * supplies its CURRENT URL logic:
   *   - proxy:        always `buildProviderApiUrl(...)` (ignores config.url)
   *   - Adapter/Handler: `config.url instanceof URL ? config.url.toString() : buildProviderApiUrl(...)`
   */
  resolveUrl: (config: RequestConfig) => string;
  /**
   * Assemble the outbound headers from the post-request-chain `config`.
   * Each site supplies its CURRENT header logic:
   *   - proxy:        getProviderHeaders + config.headers EXCLUDING AUTH_HEADER_KEYS
   *   - Adapter/Handler: getProviderHeaders + config.headers + OpenRouter app headers
   */
  buildHeaders: (config: RequestConfig) => Record<string, string>;
  /**
   * Post-transform / pre-fetch body mutation seam (design D4). Applied to
   * the request-chain output `requestBody` immediately before fetch. The
   * default is identity. NOTE: the value returned here becomes the fetched
   * body ONLY — the response chain still receives the pre-mutation request
   * (see `responseChainRequest`).
   */
  prepareBody?: (
    requestBody: unknown,
    config: RequestConfig,
  ) => unknown | Promise<unknown>;
  /**
   * The fetch mechanism. Each site supplies its CURRENT mechanism:
   *   - proxy:        `this.deps.errors.fetchWithRetry(url, headers, body, model)`
   *   - Adapter:      `fetch(url, { ..., signal: AbortSignal.timeout(...) })`
   *   - Handler:      `fetch(url, { ... })`
   */
  fetchFn: (
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ) => Promise<Response>;
  /**
   * When `true`, the core runs `executeResponseChain` on the fetched
   * response and returns the TRANSFORMED response. When `false` (default),
   * the core returns the RAW fetched response and the caller runs the
   * response chain itself — this preserves call sites that gate on
   * `response.ok` BEFORE the response chain (Adapter / Handler).
   */
  runResponseChain?: boolean;
  /**
   * The first argument passed to `executeResponseChain` when
   * `runResponseChain` is true. This is REQUIRED in that mode because the
   * sites diverge on which variable they pass (proxy → post-transform
   * `requestBody`; the unified ingresses → the pre-transform request). The
   * core never assumes it equals `prepareBody`'s output.
   */
  responseChainRequest?: UnifiedChatRequest;
}

/**
 * Result of the common exchange.
 *
 * `response` is the TRANSFORMED response when `runResponseChain` was true,
 * otherwise the RAW fetched response. The remaining fields expose the
 * request-chain outputs so callers can run the response chain themselves
 * (when `runResponseChain` is false) with the exact variables they used
 * before, and so the wire-capture / logging hooks keep their inputs.
 */
export interface ProviderCallResult {
  /** Transformed response (runResponseChain=true) or raw response (false). */
  response: Response;
  /** Request-chain output body (pre-`prepareBody`). */
  requestBody: unknown;
  /** Final body actually sent to `fetchFn` (post-`prepareBody`). */
  finalBody: unknown;
  /** Request-chain output config (headers/url/etc.). */
  config: RequestConfig;
  /** The resolved target URL. */
  url: string;
  /** The assembled outbound headers. */
  headers: Record<string, string>;
}

/**
 * Run the common provider-request exchange. See the module + option JSDoc
 * for the precise per-site contract this preserves.
 */
export async function executeProviderCall(
  ctx: ProviderCallContext,
): Promise<ProviderCallResult> {
  const {
    executor,
    request,
    provider,
    chain,
    endpointTransformer,
    extendedContext,
    resolveUrl,
    buildHeaders,
    prepareBody,
    fetchFn,
    runResponseChain = false,
    responseChainRequest,
  } = ctx;

  // 1. Request chain: endpoint.transformRequestOut → provider/model transformRequestIn.
  const { requestBody, config } = await executor.executeRequestChain(
    request,
    provider,
    chain,
    { endpointTransformer, extendedContext },
  );

  // 2. Post-transform / pre-fetch body mutation seam (D4). Default identity.
  const finalBody = prepareBody ? await prepareBody(requestBody, config) : requestBody;

  // 3. Resolve URL + headers from the post-request-chain config (per-site logic).
  const url = resolveUrl(config);
  const headers = buildHeaders(config);

  // 4. Fetch via the injected mechanism.
  const fetched = await fetchFn(url, headers, finalBody);

  // 5. Optionally run the response chain in-core. When false, the caller
  //    runs it itself AFTER its own `response.ok` gate (Adapter / Handler).
  let response = fetched;
  if (runResponseChain) {
    response = await executor.executeResponseChain(
      // Preserve the EXACT first arg each site passed: proxy → requestBody,
      // unified ingresses → their pre-transform request. The caller supplies
      // it via `responseChainRequest`; fall back to `requestBody` (the proxy
      // shape) so the contract is never silently `undefined`.
      (responseChainRequest ?? (requestBody as UnifiedChatRequest)),
      fetched,
      provider,
      chain,
      { endpointTransformer },
    );
  }

  return { response, requestBody, finalBody, config, url, headers };
}

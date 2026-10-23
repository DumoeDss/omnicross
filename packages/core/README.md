# @omnicross/core

The omnicross LLM serving core — provider dispatch, the completion pipeline, the transformer chain, the outbound API server, and the resident provider proxy. Embed it in any Node project, or run it via [`@omnicross/daemon`](https://www.npmjs.com/package/@omnicross/daemon).

Part of the [omnicross](https://github.com/Dumoedss/omnicross) monorepo — see the root README for the full overview.

```bash
npm install @omnicross/core @omnicross/contracts
```

The published core runtime remains supported on Node.js `>=20.9`. The monorepo's
official OpenAI JavaScript SDK contract suite is contributor tooling, uses
`openai@7.8.x`, and requires Node.js 22 or newer. Run it from the repository root
with `npm run test:images-sdk-contract`; the command checks the Node major before
loading the SDK. The SDK is intentionally not a runtime or package-local
development dependency of `@omnicross/core`.

## Provider/session API-key affinity

`ApiKeyPoolService` retains an independent key binding for each provider within a
logical session. A conversation routed from provider A to B and back to A reuses
A's original available key instead of advancing A's weighted round-robin pool.
Explicit `getKeyById(providerId, keyId, sessionId)` bindings follow the same scope.
Cooldowns, failover, and usage key attribution remain provider-local; invalidating
a provider's key cache preserves healthy bindings and rebinds unavailable keys on
their next use. `releaseSession(sessionId)` releases every provider binding for
that session, and `dispose()` clears pool state and its cleanup timer.

### 0.7.0 migration

`reportSuccess` now requires both arguments:
`reportSuccess(providerId: string, sessionId: string): void`. Embedded SDK hosts
must pass the actual resolved provider, just as they do for
`reportError(providerId, sessionId, statusCode)`. There is no session-only overload.
Logical session IDs, upstream `prompt_cache_key`, and session headers are unchanged;
hosts must not prefix the session ID with the provider to obtain affinity.

Hosts that delegate completion work to another execution adapter can retrieve the
same injected resources through `CompletionService.getApiKeyPool()`,
`getUsageRecorder()`, and `getUsageEventSink()`. These read-only accessors return
the existing injection or `null` when none was configured; they do not construct
new pools, recorders, or event sinks.

Affinity avoids unnecessary credential changes; it does not guarantee an upstream
prompt-cache hit. Providers still control cache scope, model compatibility, and
request-prefix matching.

## Explicit thinking controls

Thinking policy is negotiated against the resolved model and API format, including
direct, streaming, transformed, and tool-loop requests. Omitting a thinking policy
preserves provider defaults; it is not equivalent to explicitly requesting `none`.

| Target, when disabling is supported | Explicit-off wire control |
| --- | --- |
| OpenAI Chat Completions | `reasoning_effort: "none"` |
| DeepSeek Chat Completions, such as `deepseek-flash` | `thinking: { type: "disabled" }`, without `reasoning_effort` |
| Kimi K2.5 / K2.6 Chat Completions | `thinking: { type: "disabled" }`, without `reasoning_effort` |
| OpenAI Responses | `reasoning: { effort: "none" }`, without automatic summary |
| Anthropic native thinking | `thinking: { type: "disabled" }`, without an enabled-thinking budget |

Models known not to support disabling reject explicit off before an upstream
request. This includes Kimi K3 and GLM-5.3 variants; selecting a smaller positive
effort is not a substitute for disabling. Protocol fallback alone does not prove
that an unknown model supports native thinking controls.

Reasoning replay follows the actual outgoing controls. Disabled requests suppress
incompatible learned reasoning replay; omission does not silently disable replay
required by default-thinking providers. Native Responses input, opaque continuation
items, and provenance are retained rather than reconstructed for this policy.

## License

[MIT](LICENSE) 

This package adapts third-party work under its own license — see the `NOTICE` file.

# @omnicross/core

The omnicross LLM serving core — provider dispatch, the completion pipeline, the transformer chain, the outbound API server, and the resident provider proxy. Embed it in any Node project, or run it via [`@omnicross/daemon`](https://www.npmjs.com/package/@omnicross/daemon).

Part of the [omnicross](https://github.com/Dumoedss/omnicross) monorepo — see the root README for the full overview.

```bash
npm install @omnicross/core @omnicross/contracts
```

The published core runtime requires Node.js `>=20.10`: Sharp's ESM entry uses
import attributes that Node.js 20.9 cannot parse. CJS and ESM consumers share this
minimum; switching module format is not a compatibility workaround. The monorepo's
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

## Grammar-constrained Responses tools

Responses custom tools with `format: { type: "grammar", syntax: "lark" | "regex",
definition: "..." }` can use OpenAI Chat, Anthropic, and Gemini routes. The relay
retains the exact definition in the tool declaration, uses a required string
`input` envelope on those wires, and restores the custom call's original
name, namespace, and byte-exact input. Named custom choices and custom entries in
`allowed_tools` retain their selection policy.

Remote APIs without grammar sampling cannot guarantee a matching generation.
Omnicross therefore compiles the grammar before contacting the upstream and
validates the complete returned input with llguidance. Invalid declarations
return HTTP 400; nonmatching upstream tool input returns HTTP 502, or a typed
`response.failed` event after streaming has started. Custom input deltas are
buffered until validation succeeds. There is no automatic retry, input rewrite,
or unconstrained fallback. Already-executed history is not revalidated against a
later turn's changed grammar; native Responses routes retain their native payload.

The dialect follows [OpenAI's grammar tools](https://developers.openai.com/api/docs/guides/function-calling#context-free-grammars)
and [llguidance](https://github.com/guidance-ai/llguidance/blob/main/docs/syntax.md):
Rust regex and llguidance Lark, not Python Lark. Ignored interior whitespace does
not implicitly allow trailing whitespace; declare trailing whitespace in the
start rule when required. Model-token terminals are rejected on converted routes
because another model's tokenizer IDs cannot be preserved as text.

The exact-pinned `transformers-llguidance@0.2.1` dependency supplies inline WASM.
No Python/Rust installation, native addon, model download, or runtime network
fetch is required. Its private matcher ABI is isolated in `llguidanceWasm.ts`;
dependency upgrades must recheck EOF acceptance, UTF-8 mapping, disposal, and
packed ESM/CJS behavior.

## License

[MIT](LICENSE) 

This package adapts third-party work under its own license — see the `NOTICE` file.

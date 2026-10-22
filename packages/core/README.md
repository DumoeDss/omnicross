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

## License

[MIT](LICENSE) 

This package adapts third-party work under its own license — see the `NOTICE` file.

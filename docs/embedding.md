# Embedding guide (`@omnicross/daemon/embed`)

The embedding entry runs the provider catalog, key pools, subscription accounts, interactive sign-in and route leases **inside another Node application**, with no daemon process. The host builds its own "Providers" UI on plain functions and hands short-lived route credentials to the CLIs and SDKs it runs.

What the entry does **not** start or write:

- no outbound gateway (8765) and no admin server (8766). The only listener is the loopback provider proxy;
- no files outside `dataDir` (no `~/.omnicross`, no log files, no usage/pricing/audit stores);
- no read of `OMNICROSS_MASTER_KEY` unless you opt in;
- no `sharp` or `jsdom` at import or start. Image generation, search, chatgpt-web, the dashboard and integrations are not part of this entry.

It ships in `@omnicross/daemon` as the `embed` subpath. Import it as **ESM**. The CJS build duplicates module-level singletons.

```ts
import { createEmbeddedHost, HostError } from '@omnicross/daemon/embed';
```

## Lifecycle

```ts
const host = createEmbeddedHost({
  dataDir: '/home/me/.myapp/providers',            // the only directory written
  masterKey: { file: '/home/me/.myapp/providers/master.key', readEnv: false },
  proxy: { host: '127.0.0.1', port: 0 },           // 0 = pick a free port
  oauth: { callbackPageTitle: 'Signed in', callbackPageHint: 'Return to MyApp.' },
  routeLeaseDescriptors: {                          // optional; see "Launch descriptors"
    codex: { providerId: 'myapp', providerName: 'MyApp', tokenEnv: 'MYAPP_ROUTE_TOKEN' },
    claude: { apiKeyPlaceholder: 'myapp' },
  },
  productName: 'MyApp',
  logger,                                           // optional { info, warn, error, debug }; default: discard
});
await host.start();   // binds the proxy, arms the OAuth token refresh sweep
// …
await host.stop();    // releases every lease, cancels pending sign-ins, closes the proxy
```

`dataDir` holds `config.json` (providers and key pools), `tokens.json` (subscription accounts) and, by default, `master.key`. Secrets are encrypted at rest (AES-256-GCM) with the master key. The key file is generated on first use when missing. If `readEnv: true`, `OMNICROSS_MASTER_KEY` takes precedence over the file.

**One host per process.** The runtime uses process-level singletons (proxy, subscription registry, secret box). A second `createEmbeddedHost`, or one in a process that already ran `buildDaemon`, throws `HostError` with `code: 'host_conflict'`. After `stop()`, a new host can be created.

## Errors

Every failure is a `HostError`:

| field | meaning |
|---|---|
| `code` | Stable. Lease failures keep the route-lease codes (`invalid_request`, `runtime_unsupported`, `model_not_configured`, `format_unsupported`, `upstream_not_found`, `upstream_unavailable`, `upstream_exhausted`, `lease_not_found`, `lease_expired`, `idempotency_conflict`, `daemon_not_ready`). Admin failures use `invalid_request`, `not_found`, `conflict`, `gone`, `unavailable`, `upstream_error`, `internal_error`. The host itself uses `host_conflict` and `host_stopped`. |
| `status` | HTTP-style status, for hosts that forward errors over their own API. |
| `retryable`, `retryAfterSeconds` | Set for transient failures such as `upstream_exhausted`. |

Messages never contain key material.

## Route leases

```ts
const lease = await host.leases.create(
  { runtime: 'claude', upstream: { kind: 'provider', providerId: 'anthropic' }, model: 'claude-sonnet-4-5', ttlSeconds: 600 },
  'run-42/stage-1',            // idempotency key: a replay with the same body returns the same live lease
);
// lease = { leaseId, created, runtime, upstream, model, createdAt, expiresAt,
//           launch: { env, extraArgs }, endpoint: { baseUrl, token, wire } }
await host.leases.renew(lease.leaseId, 600);
await host.leases.release(lease.leaseId);
host.leases.capabilities();
```

- `runtime: 'claude' | 'codex'` fills `launch` for the CLI child process (env for Claude Code, env plus `-c` overrides for Codex).
- `runtime: 'endpoint'` launches nothing. Pass `wire: 'anthropic-messages' | 'openai-responses' | 'openai-chat'` and use `endpoint` from an in-process SDK.
- `endpoint` is returned for **every** runtime:
  - `anthropic-messages`: `baseUrl` is the proxy origin (the SDK appends `/v1/messages`);
  - OpenAI wires: `baseUrl` is `<origin>/v1` (the SDK appends `/responses` or `/chat/completions`).
- The proxy accepts the token as `Authorization: Bearer <token>`, `x-api-key: <token>` (the Anthropic SDK default) or `x-goog-api-key`. The first header present wins.
- `upstream` is `{ kind: 'provider', providerId, keyId? }`, `{ kind: 'account', providerId, accountId }`, `{ kind: 'account-group', providerId, group }` or `{ kind: 'account-pool', providerId }`. Subscription upstreams run the built-in preflight (account exists, enabled, has a credential, supports the model, healthy, inside allowance) and work for `claude`, `codex`, `gemini` and `opencodego` accounts.
- The lease freezes the model: the client's `model` field is ignored upstream. The upstream request carries the provider's own credentials, never the route token.

```ts
// pi / Anthropic SDK in-process
import Anthropic from '@anthropic-ai/sdk';
const { endpoint } = await host.leases.create(
  { runtime: 'endpoint', wire: 'anthropic-messages', upstream, model }, key);
const client = new Anthropic({ baseURL: endpoint.baseUrl, apiKey: endpoint.token });
```

### Launch descriptors

By default the CLI launch data uses neutral names: Codex `model_provider="local-proxy"`, token env `LOCAL_PROXY_ROUTE_TOKEN`, Claude `ANTHROPIC_API_KEY=local-proxy`. Pass `routeLeaseDescriptors` to set your own identifiers (`createRouteLeaseDescriptors` is exported for reuse), or a complete `RouteLeaseDescriptorPort`. The proxy authenticates by token only, so these names are cosmetic. They are validated so they cannot break the CLI's config parsing.

## Providers and key pools

```ts
await host.providers.list();                                   // masked: hasApiKey + apiKeyMasked, never the key
await host.providers.create({ id: 'deepseek', apiFormat: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-…' });
await host.providers.update('deepseek', { apiFormat: 'openai', baseUrl: '…', apiKey: '' }); // omitted = keep, null = clear, blank key = keep
await host.providers.reorder(['deepseek', 'anthropic']);
await host.providers.discoverModels('deepseek');               // real GET /models with the provider key
await host.providers.test('deepseek', 'deepseek-chat');        // one real minimal completion (may bill)
await host.providers.remove('deepseek');

await host.providers.keys.add('deepseek', { apiKey: 'sk-…', label: 'backup', weight: 1 });
await host.providers.keys.update('deepseek', keyId, { label: 'primary' });
await host.providers.keys.setEnabled('deepseek', keyId, false);
await host.providers.keys.remove('deepseek', keyId);
await host.providers.keys.refreshQuota('zai', keyId);          // providers with a quota adapter

await host.presets.list();      // curated provider templates
await host.upstreams.list();    // lease targets: providers + subscription pools, declared models, advisory lease support
```

`create` validates the input with the same allowlist the daemon uses. It persists the row, then merges discovered models into it (best effort, about 8 s). `update` follows the daemon's write contract field by field.

## Subscription accounts and sign-in

```ts
await host.accounts.list();     // { accounts: AccountView[], externalCli: { claude, codex } }, never credentials
await host.accounts.patch('claude', accountId, { label: 'Work', enabled: true, priority: 10, group: 'team-a', tags: ['ci'] });
await host.accounts.setActive('claude', accountId);
await host.accounts.batch({ action: 'disable', accounts: [{ providerId: 'claude', accountId }] });
await host.accounts.remove('claude', accountId);
await host.accounts.addManual('opencodego', { authMethod: 'manual', status: 'configured', apiKey: '…', label: 'Go' });
await host.accounts.importExternal('codex');                  // copy the local CLI login (read-only copy)
await host.accounts.refresh('claude');                         // refresh the active account's OAuth token
await host.accounts.test('codex', accountId);                  // live connection test (may bill)
await host.accounts.diagnostics('claude', accountId);
```

Interactive sign-in comes in three kinds. Use `host.oauth.kindOf(providerId)` to tell which one applies:

| kind | providers | flow |
|---|---|---|
| `paste-code` | claude, gemini | `start` → open `authUrl` → the user pastes the code → `complete(providerId, sessionId, code)` |
| `loopback` | codex (`localhost:1455`), antigravity (`127.0.0.1:51121`) | `start` arms a one-shot callback listener in this process → open `authUrl` → poll `status` until `done` / `error` |
| `device-code` | kimi, grok, copilot | `start` returns `userCode` + `verificationUri` → show them → poll `status` |

```ts
const session = await host.oauth.start('codex');  // { sessionId, kind, authUrl, userCode?, verificationUri?, callbackUrl?, expiresAt }
const { state, message } = await host.oauth.status('codex', session.sessionId);
await host.oauth.cancel('codex', session.sessionId);  // frees the loopback port
```

Only one loopback sign-in per provider can run at a time, because the redirect URI fixes the port. A second `start` fails with `conflict`. If the port is held by another process, `status` reports `error` with a message saying so. The browser callback page uses `oauth.callbackPageTitle` / `callbackPageHint`. Sessions live in memory; `stop()` cancels the pending ones. Minted tokens go straight to the encrypted store.

## Health and change notifications

```ts
const health = await host.health();
// { ready, proxyBaseUrl, activeLeases, providers: [{ id, enabled, modelCount, keys: { total, enabled, coolingDown, autoDisabled } }],
//   accounts: [{ providerId, accountId, label, enabled, schedulable, status }] }

const off = host.on('change', (event) => refresh(event.scope)); // { scope: 'providers' | 'accounts', action, providerId? }
```

`change` fires after every successful mutation made through the host, including accounts added by asynchronous sign-ins.

## Stability

The exports of `@omnicross/daemon/embed` are public API. During 0.x, breaking changes to them are listed in `CHANGELOG.md` under **Breaking (embed API)**. Pin an exact version. Everything else in `@omnicross/daemon` keeps its existing (undocumented) stability.

The daemon's `/admin/api` handlers are thin wrappers over the same service layer (`service/providerAdmin`, `service/accountAdmin`, `service/oauthAdmin`), so the two surfaces cannot drift.

## Known limits

- Installing `@omnicross/daemon` still installs its full dependency set (chatgpt-web, the UI assets, the search and image packages). The embed entry just never loads them. A separate, slimmer package is a possible follow-up.
- Identifiers sent to upstreams (the Responses `prompt_cache_key` prefix, the Gemini Code Assist request-id prefix) and the `x-omnicross-count-estimate` response header still use the product name. End users do not see them.
- `providers.test`, `accounts.test` and `discoverModels` make real upstream calls with the stored credentials.

# LogJev decisions in Omnicross

Omnicross exposes one reusable decision client in `@omnicross/core/logjev` and an authenticated `POST /v1/systemone` gateway. Both support native Jev and the user's LogJev logprob bridge. Decisions do not generate text or execute tools.

## Configure a provider

In **LLM Providers → Other**, choose **LogJev** for an OpenAI-compatible model that returns `top_logprobs`, **Jev (TypeSafe)** for the native API, or **Jev (OpenRouter)** to use OpenRouter's Jev models (`typesafe/jev-*` via the native Decisions endpoint). 

The LogJev editor is SELECTOR-shaped: instead of re-entering a key/URL, pick an already-configured provider from 模型服务 (Model Services) plus one of its models — the daemon resolves that row's credentials at call time. The **probe** button sends one minimal completion with the reader's exact logprobs parameters and warns when the selected provider+model does not return `top_logprobs`. Rows that carry their own URL/key/models (legacy) keep working; the provider editor also exposes the decision backend, full/minimal prompt mode, top-k and additional nonsecret model options. Other locales currently use English fallback labels for these new fields.

The same settings can be written through the provider admin API or `config.json`:

```json
{
  "id": "logjev",
  "category": "other",
  "apiFormat": "openai",
  "baseUrl": "https://integrate.api.nvidia.com/v1",
  "apiKey": "$LOGJEV_UPSTREAM_KEY",
  "models": ["your-logprobs-model"],
  "logjev": {
    "kind": "chat",
    "promptMode": "full",
    "topk": 20,
    "readTemperature": 1,
    "concurrency": 4,
    "timeoutMs": 60000,
    "retryDelaysMs": [800, 2000, 5000],
    "extraBody": { "chat_template_kwargs": { "enable_thinking": false } }
  }
}
```

`extraBody` is for model options, never credentials. Model, messages, logprob settings, single-token generation and non-streaming fields remain controlled by the reader. Top-k and thinking options must be supported by the selected upstream. Multimodal support also depends on that model.

For native Jev use `"kind": "jev"` and the full endpoint, e.g. `https://api.typesafe.ai/v1/systemone`. Service roots and `/v1` are accepted for old configurations. With a native OpenRouter provider, the client resolves `/api/alpha/decisions`; an OpenRouter provider in **chat** mode continues using `/chat/completions`.

## Call the gateway

Send an Omnicross **access key**, not the upstream provider key, as `Authorization: Bearer …` to `http://127.0.0.1:8765/v1/systemone` (default port):

```json
{
  "provider": "logjev",
  "model": "jev-latest",
  "state": { "query": "invoice", "snippet": "View payment receipts" },
  "questions": {
    "relevant": { "type": "noul", "instructions": "Does the snippet directly help answer the query?" }
  }
}
```

`provider` optionally selects an enabled Other-category provider. Without it, the gateway prefers `logjev`, then `open-jev`, then the first enabled Other provider. `jev-latest` or an absent model uses the provider's first configured model.

Supply either `state` or `messages`. Messages accept system/user/assistant roles and text, `image_url`, `input_audio` (data + format), or `audio_url` parts. A request can override `prompt_mode`. Legacy `images: [dataURL, …]` remains supported in chat mode, with at most four images. Native callers should use their endpoint's supported multimodal message format. The gateway body limit is 16 MiB; a request accepts at most 128 questions.

## Embed the same implementation

```ts
import { createLogJevClient } from '@omnicross/core/logjev';

const client = createLogJevClient({
  kind: 'chat', // or 'jev' for the native endpoint
  baseUrl: 'https://provider.example/v1',
  apiKey: process.env.LOGJEV_UPSTREAM_KEY,
  model: 'your-logprobs-model',
  concurrency: 4,
  timeoutMs: 5000,
});

const response = await client.evaluate({
  state: { query: 'invoice', snippet: 'View payment receipts' },
  questions: { relevant: { type: 'noul', instructions: 'Is this relevant?' } },
}, { signal });
```

Keep one client per configured provider so its queue bounds concurrent evaluations. `fetch` is injectable for host proxy policy or tests. The package supports Omnicross's Node 20 baseline and has no filesystem or server dependency.

## Evidence and failure behavior

- Chat mode follows LogJev 0.1.1's prompt and probability math: Choice up to 48 labels, Score 2–10 ordinal levels, Noul weighted over digits 1–9. Native Choice accepts up to 255 options and structured instruction objects without applying the chat prompt conversion.
- Sentinel logprobs are ignored; whitespace variants retain the maximum logprob. Missing labels use LogJev's `min(top) - 5` floor. This is an approximation: `logjev.evidence` records observed/total label coverage, and `logjev.calibrated` is false. Do not equate chat confidence with native Jev's confidence.
- Missing logprobs trigger one re-read. No observed allowed labels triggers a firmer prompt once. Persistent missing evidence throws `LogJevError` with `code: 'insufficient_evidence'`; sampled text and fabricated uniform answers are never accepted.
- The deadline covers queueing, HTTP requests and backoff. Cancellation removes queued work and aborts active requests. HTTP 429/500/502/503/504/529 and transport failures use bounded retries.
- `model` preserves the upstream model when known; `requested_model` retains the requested alias. Chat metadata lists all observed model IDs. `usage.reads` counts logical questions for native compatibility; `usage.upstream_requests` counts actual HTTP attempts, including retries. Token usage includes successful re-reads; failed HTTP attempts without usage cannot be priced exactly.
- Malformed native answers fail validation. Upstream response bodies are not reflected in errors. Applications should keep their own deterministic fallback, budgets and side-effect approvals.

## Compatibility and references

Existing `open-jev` provider IDs, keys and `/v1/systemone` clients remain valid. Without explicit settings, legacy OpenRouter rows select native mode only for Jev model names; ordinary LLMs use chat mode. Legacy `jev` rows retain native mode. Disabled rows are never selected.

Prompt and probability logic derives from the user's [LogJev implementation](https://github.com/DumoeDss/logjev). Native concepts: [TypeSafe's building guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one). The logprob emulation is a compatibility bridge, not a claim to reproduce native Jev quality or latency.

# @omnicross/chatgpt-web — EXPERIMENTAL

**Not published. Experimental feature branch — drive the ChatGPT web UI (including
Pro) as a Codex Responses backend, over the user's own Chrome via CDP.**

Unofficial browser automation of chatgpt.com. Use only your own account and obey
the applicable OpenAI terms; account-level enforcement is always possible.

## What it does

```
Codex ── -c model_provider → 127.0.0.1:<port>/v1 (this bridge)
                                   │
                                   ├─ GET  /v1/models         chatgpt-web/* catalog
                                   ├─ POST /v1/responses       parse → compile → browser turn → SSE
                                   └─ POST /v1/responses/compact  v1 replacement history
                                   │
                            CDP ───┘ (your daily Chrome, remote debugging)
                                   └─ Temporary Chat: insert prompt → pick effort → stream answer
```

Models: `chatgpt-web/light|medium|high|extra-high|pro` (slider positions 0–4;
`pro` requires an account that exposes Pro) plus `chatgpt-web/luna|think` for
Luna-only accounts. Every turn opens a fresh temporary chat with the full
compiled Codex context (Codex runs with `disable_response_storage`), so no
server-side conversation state is kept.

## Full harness (local tools, EXPERIMENTAL)

`--harness` attaches the local-tool loop through the official
`openai/tunnel-client`: the bridge downloads/verifies the pinned binary,
spawns its stdio MCP server (`codex_shell`, `codex_apply_patch`) as the
tunnel child, and parks each browser turn on a broker token. When ChatGPT
calls a Codex Native tool, the call relays to Codex as a `function_call` /
`custom_tool_call`; the follow-up request's `function_call_output` unblocks
the MCP response and the SAME browser turn resumes streaming.

One-time setup (all free):

```bash
omnicross chatgpt-web harness setup --tunnel-id <tunnel_…> --runtime-key <sk-…>
# then follow the printed checklist:
#  platform.openai.com → Tunnels: create tunnel + API key
#  ChatGPT → Settings → Connectors (developer mode) → Tunnel connector
#    named exactly "Codex Native2", auth none, permissions: allow all
omnicross chatgpt-web launch --harness --model chatgpt-web/pro
```

Browser-only mode (default, no tunnel) keeps the read-only capability
contract: the model sees the complete task history — including earlier tool
results — but cannot run new local commands, and the prompt contract makes
it state that limitation instead of inventing success.

## Requirements

- Chrome with remote debugging: open `chrome://inspect/#remote-debugging`, enable
  "Allow remote debugging for this browser instance" (restart Chrome if asked) —
  or start Chrome with `--remote-debugging-port=9222`.
- Signed in to chatgpt.com in that Chrome.
- Node >= 22 (native WebSocket) or the optional `ws` package installed.

## Use

Prefer the daemon command (see `omnicross chatgpt-web --help`):

```bash
omnicross chatgpt-web check                 # CDP + login + capability probe
omnicross chatgpt-web check --smoke         # + one real browser turn
omnicross chatgpt-web launch                # bridge + codex wired to it (default: chatgpt-web/high)
omnicross chatgpt-web launch --model chatgpt-web/pro
```

Programmatic:

```ts
import { startChatGptWebBridge } from '@omnicross/chatgpt-web/server';
const bridge = await startChatGptWebBridge({ authToken: '<random>' });
// point a Codex model_providers entry at `${bridge.baseUrl}/v1`
```

## Failure philosophy

UI drift, missing models, expired sessions, and capacity limits all fail with
explicit errors (HTTP status + message). Nothing silently switches models or
transports.

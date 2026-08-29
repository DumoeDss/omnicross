# Omnicross Claude（Anthropic Messages）接口支持审查

> 状态：完成 / 待技术评审
>
> 日期：2026-08-29
>
> 审查基线：omnicross 工作区 `0.1.10`（最近发布 `0.1.9`，最后提交 2026-08-28）
>
> 受众：`@omnicross/core` outbound-api 与 transformer 维护者、`@omnicross/subscriptions` Claude 适配维护者、daemon 维护者
>
> 配套文档：缺失功能的需求文档见《[omnicross-claude-api-requirements.md](omnicross-claude-api-requirements.md)》

---

## 1. 摘要

omnicross 对 Claude/Anthropic 协议的支持**已经覆盖主链路**：`POST /v1/messages` 的流式与非流式、Claude 订阅 OAuth 上游透传、跨协议翻译（Anthropic→OpenAI/Responses/Gemini）、模型种（kind）路由、多账号轮换与限额调度均可用。**同格式（Anthropic→Anthropic）路径保真度高**：请求体逐字节透传、SSE 原样转发、上游错误原样透传。

但对照 Anthropic 官方网关契约（`code.claude.com/docs/en/llm-gateway-protocol`）逐项审查后，发现 **1 个 P0 级路由缺陷、7 个 P1 级协议保真缺口、若干 P2 项**：

- **P0**：`POST /v1/messages/count_tokens` 因端点选择采用子串匹配（`path.includes('/v1/messages')`），会被**当作完整生成请求执行**——不只返回错误形状，还会真实消耗一次上游推理（烧 token、烧订阅额度）。`/v1/messages/batches` 等未来子资源同样会被误执行。
- **P1**：本地错误不是 Anthropic 错误形状（`outbound_api_error` 信封）；`/v1/models` 只有 OpenAI 形状且暴露的是上游模型名而非客户端别名；transform 路径静默丢弃 `top_p/top_k/stop_sequences/metadata` 与 `document`（PDF）等内容块；合成 SSE 的 `message_start` usage 置零、不合成 `ping`（有触发 Claude Code 300 秒字节看门狗误中断的风险）；`anthropic-version` 未按官方要求逐字转发；`stop_reason` 映射不完整（`content_filter`→`stop_sequence`）；Codex 过载可见性未接入 `/v1/messages`→Codex 桥。
- 结论：**"基础中转可用、同格式路径优秀、跨格式路径与外围端点残缺"**。缺口清单与修复需求已整理进配套需求文档。

---

## 2. 审查范围与方法

### 2.1 范围

- **入站面**：omnicross 暴露给 Anthropic 协议客户端（Claude Code CLI、Anthropic SDK）的全部 HTTP 面——outbound API server（默认 `127.0.0.1:8765`）与 resident loopback ProviderProxy（launcher 启动 CLI 时使用）。
- **上游面**：Claude 订阅（OAuth）适配、BYO Anthropic 形态 provider、以及 Anthropic→OpenAI/Responses/Gemini 翻译路径中与协议保真相关的行为。
- **不涉及**：OpenAI/Gemini 入站端点自身的审查（另见 Codex 侧需求文档）、计费/定价正确性、UI。

### 2.2 官方依据

以 Anthropic 官方文档为准绳，社区观察仅作标注：

| 类别 | 来源 |
|---|---|
| 网关契约（最核心） | [LLM gateway protocol reference](https://code.claude.com/docs/en/llm-gateway-protocol) — Anthropic 官方对 `ANTHROPIC_BASE_URL` 端点"必须支持什么"的声明 |
| 端点与消息语义 | [Messages API](https://platform.claude.com/docs/en/api/messages)、[Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)、[Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)、[Models list](https://platform.claude.com/docs/en/api/models-list) |
| 头部与错误 | [Beta headers](https://platform.claude.com/docs/en/api/beta-headers)、[Rate limits](https://platform.claude.com/docs/en/api/rate-limits)、[Errors](https://platform.claude.com/docs/en/api/errors) |
| Claude Code 行为 | [Authentication](https://code.claude.com/docs/en/authentication)、[Env vars](https://code.claude.com/docs/en/env-vars)、[Model config](https://code.claude.com/docs/en/model-config)、[Gateway connect](https://code.claude.com/docs/en/llm-gateway-connect) |

文档域名已迁移：Claude Code 文档在 `code.claude.com/docs`，API 文档在 `platform.claude.com/docs`（旧 `docs.claude.com` 路径 301 过去）。

### 2.3 方法

1. 由官方文档整理"Claude Code 网关契约基准"（§3）。
2. 对 omnicross 代码做全量盘点（入站路由、请求字段、内容块、SSE、错误、上游适配、测试），所有结论落到 file:line。
3. 逐项对比形成矩阵（§5）与分级发现（§6）。P0/P1 关键断言（子串路由、固定 `anthropic-version`、usage 置零、tool_result 图片占位）均经人工二次读码核实。

---

## 3. 官方契约基准（Claude Code 需要网关做什么）

以下均出自官方文档（社区观察项单独标注）。

### 3.1 端点

| 端点 | 方法 | 要求 | 说明 |
|---|---|---|---|
| `/v1/messages` | POST | **必须** | 推理请求实际打到 `/v1/messages?beta=true`——**按路径匹配、不要匹配完整 URL**；流式必须无缓冲转发 |
| `/v1/messages/count_tokens` | POST | 可选 | 唯一的可选端点。缺失时 Claude Code 回退为"通过推理响应的 usage 统计上下文"——即**干净地失败是安全的**；可用时响应 `{"input_tokens": N}` |
| `/v1/models` | GET | 可选 | 网关模型发现（默认关闭，`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` 开启）。请求 `GET /v1/models?limit=1000`，3 秒超时，**任何重定向（含 http→https）都算失败**；读 `data[].id` + 可选 `display_name`；只保留 id 含 `claude`/`anthropic`（不区分大小写）的条目 |
| `/api/hello` | HEAD | 可选探活 | 连接预热探测，**"网关可以拒绝它而不破坏任何功能"** |
| `/api/oauth/usage` | GET | （未记载） | **社区观察**（非官方文档）：Claude Code `/usage` 与 crs 类工具的 5h/周限额数据源；返回 five_hour/seven_day 百分比；429 很凶 |

官方另确认：fast-mode 可用性检查与 WebFetch 域名安全检查**直连 `api.anthropic.com`，不走 base URL**——它们失败不代表网关有问题，也不会出现在网关日志里。

### 3.2 认证与头部

- **认证头**：`ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`；`ANTHROPIC_API_KEY` → `x-api-key`；`apiKeyHelper` 输出**同时**放两个头。网关须接受 Bearer 与/或 x-api-key。
- **`anthropic-version`（当前 `2023-06-01`）**：官方要求**原样转发**。
- **`anthropic-beta`**：官方原话——**"逐字转发该头；不要对单个值做白名单，因为这个集合会随 Claude Code 版本变化。"** beta 头与请求体字段成对出现：剥掉一半、放行另一半 → 硬 400；两边都没有 → 功能静默关闭。检查请求体时**不要改写**（重写/脱敏同样会破坏配对）。
- **客户端附加头**：`x-claude-code-session-id`、`x-claude-code-agent-id`、`x-claude-code-parent-agent-id`、`ANTHROPIC_CUSTOM_HEADERS` 注入的头。`anthropic-*` 与 `x-claude-code-*` 是**开放集合**，新值随版本到来。
- **订阅 OAuth 场景的关键约束**（官方引文）：当开发者用 claude.ai 登录且 `ANTHROPIC_BASE_URL` 已设置而无网关凭证变量时，`anthropic-beta` 头还携带"上游要求的 OAuth 能力标记，剥掉它会导致这些请求 401"（社区观察该标记为 `oauth-2025-04-20`；机制是官方确认的，字符串本身不在官方文档中）。

### 3.3 请求体保真

- **system 数组**：Claude Code 会在首位 system 块前置一个归因块（attribution block）；官方要求**原样转发 system 数组——不得前置、重排、合并条目或降级为纯字符串**（api.anthropic.com 是按位置剥离归因块的，其他上游会收到它）。v2.1.181 起该块对同一会话稳定（对按请求体做 key 的网关缓存安全）。
- **`cache_control`**：挂在 system 块与 messages 条目（含会话中途追加的 `role:"system"` 条目）上，**原样转发**；不要把块形态的 system/消息内容转成纯字符串。剥掉的症状：不报错，但会话按未缓存计费（`input_tokens` 高、usage 无缓存活动）。
- **thinking 块带签名**：**必须原样、按原顺序往返**，否则上游 400 `invalid_request_error`。
- **需透传的请求体字段**（官方列举）：`context_management`、`output_config`（effort / 结构化输出 / 任务预算）、beta 工具 schema 字段（`strict`、`defer_loading`）、`tool_reference` 块、`tools`/`tool_choice`、`stop_sequences`、`metadata.user_id`、`service_tier`、`container`、`inference_geo`。
- **能力拒收恢复**：上游拒绝 thinking 字段/签名/中途 system 消息/`cache_control` 标记时，Claude Code 会重试并在本会话余下部分禁用该能力——**但它按上游错误措辞匹配**，所以网关必须**原样转发错误响应体**；网关自造的信封会破坏恢复，除非带上稳定的 `capability_rejected:` 标记。context-management 与工具 schema 的 400 **不会**被重试。

### 3.4 流式语义

- 事件流：`message_start` → 每内容块 `content_block_start` → 若干 `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`。
- **`message_start` 携带完整 Message 对象**（content 为空）与**初始 usage**（input_tokens、output_tokens）。**`message_delta` 的 usage 是累计值**（官方明确警告），含完整 input/cache_creation/cache_read/output 及可选 server_tool_use 计数。
- delta 类型：`text_delta`、`input_json_delta`（工具参数细粒度流）、`thinking_delta`、`signature_delta`（在 thinking 块 `content_block_stop` 前发出）。
- **ping**：官方"事件流可含任意数量的 ping 事件"。Claude Code 在 `ANTHROPIC_BASE_URL` 连接上对**转发的每一个字节**计数，字节级看门狗默认在流静默 **300 秒**后中断。长思考暂停期间上游 ping 是唯一流量——**剥掉或缓冲 ping 的网关会导致误中断**；从不发 ping 的上游（如 Bedrock 二进制流）翻译时网关必须**自己合成 ping**。
- 流中错误：`event: error` + `data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`。
- **新事件类型随时可能加入**，客户端必须容忍未知事件——网关应透传未知事件而非丢弃。
- **响应必须无缓冲流式转发**："缓冲完整响应再转发的网关会卡住客户端。"

### 3.5 错误语义

- 错误体形状：`{"type":"error","error":{"type":"...","message":"..."}}`（如 `overloaded_error`、`rate_limit_error`、`invalid_request_error`）。
- 429 限流头：`retry-after`（秒；**spend-cap 429 不带它**，改带 `error.details.error_code: "enforced_spend_limit_reached"`）、`anthropic-ratelimit-requests-{limit,remaining,reset}`、`anthropic-ratelimit-tokens-*`、`-input-tokens-*`、`-output-tokens-*`（reset 为 RFC 3339）。
- 限额记账口径：ITPM 计 input + cache_creation、**不计 cache_read**（Haiku 3.5 例外）；usage 的 `input_tokens` 是最后一个缓存断点之后的 token，总输入 = cache_read + cache_creation + input。

### 3.6 模型与别名

- 别名：`sonnet`/`opus`/`haiku`/`best`/`fable`/`default`/`opusplan`；完整 ID 如 `claude-opus-4-8-2026xxxx`。
- **`[1m]` 后缀是官方语法**（`sonnet[1m]`、`claude-opus-4-8[1m]`），选 1M 上下文窗口，配 `context-1m-2025-08-07` beta。
- 背景/小模型：`ANTHROPIC_DEFAULT_HAIKU_MODEL`（`ANTHROPIC_SMALL_FAST_MODEL` 已废弃）、`CLAUDE_CODE_SUBAGENT_MODEL`。
- **对网关重要的行为**：Claude Code 把不认识的模型名（网关自定义别名）当作当前代模型，**照样发 `thinking:{"type":"adaptive"}`**——网关必须放行或正确翻译该字段。
- 模型可用性检查只有可选的 `/v1/models` 发现（§3.1）。

---

## 4. Omnicross 现状实现

### 4.1 两个服务面

1. **Outbound API server**（`packages/core/src/outbound-api/OutboundApiServer.ts:49`，默认 `127.0.0.1:8765`，可开 LAN）：公开稳定入口，命名 API key 鉴权。每请求管线：鉴权 → voucher `/redeem` → 限流 → 端点选择 → 角色检测/路由解析 → 铸造临时路由 → 委派 `routeRequest()`（`outboundApiRouter.ts:325`）。
2. **Resident loopback ProviderProxy**（`provider-proxy/ProviderProxy.ts:88`，127.0.0.1 随机端口）：launcher 启动的 CLI 专用，per-run 不可猜 route token 鉴权（`cli-launcher/src/proxy-env/claude-proxy-env.ts:59-73` 设置 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY=omnicross-proxy` 哨兵）。

两者汇聚到共享分发器 `routeRequest()`（`provider-proxy/providerProxyRouter.ts:77`）。生产 daemon 不注入 `anthropicIngressHandlerFactory`（`daemon/src/bootstrap.ts:526-529`，该分支仅测试用），线上 `/v1/messages` 走内置路径：`anthropicMessagesIngress.ts` → `anthropicMessagesByo.ts`（+ 订阅路由的 `anthropicSubscriptionPlan.ts`）。

### 4.2 路由与端点现状

- `POST` 路径**包含** `/v1/messages` → messages 端点（`outboundApiRouter.ts:206`；resident 侧 `anthropicMessagesIngress.ts:60-65` 同为 `url.includes('/v1/messages')`——注释写明两处刻意保持一致）。查询串已剥离（`?beta=true` 不影响匹配 ✓）；尾斜杠容忍 ✓。
- `GET` 路径以 `/models` 结尾 → 模型列表（`outboundApiRouter.ts:227-232`），**OpenAI 形状**（`{object:'list',data:[{id,object:'model',owned_by:'omnicross'}]}`，287-295 行）。
- `GET|HEAD /health`、`/healthz` 免鉴权探活；`POST /redeem` 凭证兑换（非 Anthropic 协议）。
- 其余路径 → 404 `{"error":{"type":"outbound_api_error","message":"Unsupported: <method> <url>"}}`（`outboundApiRouter.ts:437`）。
- 特例：`/v1/messages/v1/messages` 双拼后缀在 HTTP 入口被折叠（`OutboundApiServer.ts:341-351`，照顾 base URL 已带 `/v1/messages` 的客户端）。
- **没有** `/v1/messages/count_tokens`、`/v1/messages/batches`、`/v1/complete`、`/api/hello`、`/api/oauth/usage` 的任何处理（全库 grep 证实）。

### 4.3 两条执行路径

**(a) 同格式快路径**（上游说 Anthropic wire）：

- BYO：`provider.apiFormat==='anthropic'` 或官方 preset（`anthropicMessagesByo.ts:274-275`）；订阅：`profile.mode==='pass-through'`（Claude 订阅 → `https://api.anthropic.com/v1/messages`）或上游 URL 以 `/v1/messages` 结尾。
- **请求体逐字节透传**，唯一改写是 `body.model`（`resolveSameFormatBody`，`anthropicMessagesByo.ts:360-373`；Claude 订阅的按账号模型重映射 `rewriteBodyModel`，`anthropicSubscriptionPlan.ts:601-610`，parse 失败安全回退原文）。`top_p/top_k/stop_sequences/metadata/context_management/betas/cache_control` 等所有字段原样通过。
- **SSE 原样转发**：无 model 改写/usage 观察时为原始字节管道（`providerProxyShared.ts:334-346`）；有则走逐行转发（单流 TextDecoder、保留事件框架与换行风格、跨 chunk 装行、末行 flush，221-256 行），**只改写携带 model 的事件**（`message_start.message.model` → 客户端原始请求 id，`rewriteSseLine` 128-169 行）。真 Anthropic 流的 ping、细粒度工具流、真实 usage 均原样通过。**事件不删不造**。
- 非流式客户端 × 只支持流式的上游（Codex）：SSE 聚合为单条 Anthropic message JSON（`aggregateAnthropicSseToJsonBody`，`providerProxyShared.ts:371-471`，往返保留 text/tool_use/thinking+signature）。

**(b) 翻译路径**（其他上游格式）：body 解码为内部 Unified 形状再重编码。

- 请求侧**读取/保留**：system（含 cache_control 的块数组）、messages、max_tokens、temperature、stream、tools（函数工具 + 服务端工具分侧信道往返，`AnthropicToolHandling.ts:19-27`、`AnthropicConversion.ts:203-206`、`AnthropicRequestBuilder.ts:184-190`）、tool_choice、thinking（`enabled+budget_tokens`→推理 effort；`adaptive` 读 `output_config.effort`）。
- 请求侧**静默丢弃**：`top_p`、`top_k`、`stop_sequences`、`metadata` 及一切未识别字段（无白名单/黑名单机制——Unified 枢纽是构造式解码器，"没处理"就是"丢掉"）。
- 内容块：user 的 `document`（PDF）、assistant 的 `redacted_thinking`、`search_result`、`container_upload` **不被处理（丢弃）**；`tool_result` 块数组内容被拍平为文本，其中图片块变 `'[image omitted]'`（`AnthropicTypes.ts:117-137`，OpenAI chat wire 不能在 tool 消息带图，代码有注释说明）。
- 响应方向（OpenAI→Anthropic，`AnthropicOpenAIToAnthropicStream.ts`）：**合成** Anthropic SSE——`message_start`（**usage 硬编码 `{input_tokens:0, output_tokens:0}`**，73、130 行）、`content_block_start/delta/stop`（text/thinking/tool_use，细粒度 `input_json_delta` ✓）、`message_delta`（stop_reason + usage，含来自 `cached_tokens` 的 `cache_read_input_tokens`）、`message_stop`、带内 `event:error`（形状为 `{type:'api_error',message}`）。**不合成 ping，无 eager_input**。stop_reason 映射：`stop→end_turn`、`length→max_tokens`、`tool_calls→tool_use`、`content_filter→stop_sequence`（259-264 行）。
- `max_tokens` 缺省取模型注册表上限、否则 128000（`anthropicMaxTokens.ts:41,52`）；推理重编码为 `adaptive`+effort 或旧式 `budget_tokens` 且 temperature 强制 1（`AnthropicRequestBuilder.ts:208-222`）；`tool_choice` `required→any`、`none` 丢弃（193-203 行）。

### 4.4 头部处理现状

- **入站鉴权**：outbound server 接受 `Authorization: Bearer`（或裸值）、`x-api-key`、`x-goog-api-key`（`outboundApiRouter.ts:172-184`）✓；客户端自己的鉴权头被剥除、换成内部 route token（`shimAuthHeader`，315-319 行），外部 key 不出网 ✓。resident 代理只认 `Authorization`/`x-goog-api-key`（`x-api-key` 不是 token 源，但 launcher 场景 `ANTHROPIC_AUTH_TOKEN` 走 Authorization，成立）。
- **`anthropic-beta`（客户端）**：ingress 处捕获（`anthropicMessagesIngress.ts:96-98`）；BYO 同格式与 Claude 订阅路径**合并进基线**（`buildAnthropicBeta`，`claudeCodeHeaders.ts:139-160`：基线 `claude-code-20250219`、`oauth-2025-04-20`、`interleaved-thinking-2025-05-14`、`fine-grained-tool-streaming-2025-05-14`，haiku 减配为 oauth+interleaved-thinking；调用方自己的旗标去重后追加——**无白名单** ✓）。翻译路径不转发（跨 wire 上无意义，但所 gate 的功能会静默 no-op）。
- **`anthropic-version`**：BYO 同格式**固定发 `2025-01-10`**（`completion/header-builder.ts:30`，注释称"extended thinking 需要"——官方当前文档值仍为 `2023-06-01`，且官方要求逐字转发客户端值）；Claude 订阅路径在调用方/指纹都没给时才填 `2023-06-01`（`claudeCodeHeaders.ts:47`、`anthropicSubscriptionPlan.ts:529-532`——即调用方值可透传 ✓）。
- **客户端身份头**：正向白名单 `accept`、`accept-language`、`sec-fetch-mode`、`user-agent`、`x-app`、`anthropic-dangerous-direct-browser-access`、`anthropic-version`、任意 `x-stainless-*`（`claudeCodeHeaders.ts:97-128`），**仅在 Claude 订阅同格式转发**，缺省由 `DEFAULT_CLAUDE_CODE_HEADERS` 补齐（`claude-cli/1.0.119 (external, cli)` 等，63-78 行）；`accept-encoding` 强制 identity（Cloudflare 压缩体损坏防护，87 行）。
- 1M 上下文 beta `context-1m-2025-08-07` 按路由 opt-in 注入（`anthropicBetaInject.ts:49`，仅 BYO 同格式路径）。

### 4.5 Claude 订阅上游适配（`@omnicross/subscriptions`）

- **OAuth 流程**（`oauth/flows/claude.ts:38-57`）：官方 CLI client id `9d1c250a-…`，authorize `https://claude.ai/oauth/authorize`，token `https://platform.claude.com/v1/oauth/token`（2026-06 起旧 `console.anthropic.com` 404，已迁移 ✓）；scopes 含 `user:inference`、`user:sessions:claude_code` 等；PKCE S256 + state；token 端点头模拟 CLI UA/Referer（Cloudflare 前置，否则 403）；refresh 单次性 token、按 key 合并刷新（`JsonSubscriptionCredentialStore.ts:154-162`）；凭证 at-rest 加密（`SecretBox`）；Claude 是 **401 驱动刷新**（无主动提前刷新）。
- **上游端点全集**：`POST api.anthropic.com/v1/messages`（中继本体）；`GET api.anthropic.com/api/oauth/usage`（限额采集，`daemon/src/allowance/ClaudeAllowanceCollector.ts:29`）；`POST platform.claude.com/v1/oauth/token`（换码/刷新）；`GET api.anthropic.com/v1/models`（仅免费健康探测，`probe/ProbeStrategy.ts:45`）。
- **限额**：5h/7d/7d-Sonnet 窗口解析（80-100 行）、5 分钟缓存、per-account 在途合并、401 刷新重试一次、403 标记不支持、setup-token 账号永久不支持、失败保旧快照；`allowance-cache.json` 持久化；调度策略默认**关闭**（`AccountAllowanceScheduling.ts:38-43`，demote 80%/pause 98%）；管理 API `GET /admin/api/accounts/allowances*`、`POST .../refresh`。
- **健康/轮换**（`pipeline/SubscriptionAccountHealth.ts:318-411`）：429 **严格**按权威头 `anthropic-ratelimit-unified-reset`（epoch 秒）冷却，裸 429 不标记（`retry-after` 刻意不用，218-237 行）；529 → 10 分钟过载冷却；403 body 嗅探永久封禁标记；最终 401 → 30 分钟瞬态；2xx 清 rate/overload/transient 但永不清 blocked/quotaExhausted。**Anthropic 错误 body 类型（`overloaded_error` 等）不解析**——一切按状态码/头。`markQuotaExhausted` 是 Codex 专属（Claude 靠 429 冷却 + 98% 暂停表达配额耗尽）。多账号池：per-conversation 粘性亲和、健康/模型门控仅 ≥2 账号启用、allowance 全暂停 → 429；Claude **无模型级 fallback 链**（每请求一次尝试，轮换靠调度）。
- 401 处理：`onUnauthorized` 刷新后**重跑一次**，以最终结果记健康（`anthropicSubscriptionPlan.ts:623-659`）。

### 4.6 用量记账

- 流式 tap 合并 `message_start` 输入 + `message_delta` 输出、流结束记一次（`anthropicMessagesByo.ts:159-180`）；归一化器缓存感知（`recordAnthropicUsage.ts:37-62`，Anthropic 的 `input_tokens` 本就剔除缓存 ✓）；记账用上游真实模型（响应 model 改写不影响账 ✓）。`engineOrigin` 复用 `'codex-ingress'` 占位（15-19 行，已标注）。

### 4.7 测试现状

无 golden-wire fixture 目录；行为级 vitest（内联 mock）：`ProviderProxy.anthropicByo.test.ts`、`ProviderProxy.anthropicSubscription.test.ts`（含 claude 透传 e2e）、`aggregateAnthropicSse.test.ts`、`AnthropicConversion.test.ts`（转换矩阵）、`claudeCodeHeaders.test.ts`、outbound-api 系列与 daemon `boot-smoke`/多账号 failover e2e 等（全清单见两侧盘点，不再罗列）。

---

## 5. 逐项对比矩阵

判定：✅ 符合 · ⚠️ 部分符合/有条件 · ❌ 缺失。判定均针对"Anthropic 协议客户端经 omnicross"的场景；同格式/翻译路径差异分别标注。

| # | 官方要求 | 现状 | 判定 |
|---|---|---|---|
| 1 | `POST /v1/messages`（按路径匹配，容忍 `?beta=true`） | 子串匹配 `includes('/v1/messages')`；查询串剥离 ✓；双拼路径折叠 | ⚠️ 匹配过宽（见 F-1） |
| 2 | 流式无缓冲转发 | 同格式原始字节管道/逐行改写 model；翻译路径逐事件合成，均无整体缓冲 | ✅ |
| 3 | ping 转发（300s 字节看门狗） | 同格式原样通过 ✅；**翻译路径不合成 ping** | ⚠️（F-6） |
| 4 | 未知识别事件透传 | 同格式 raw pipe 天然透传 ✅；翻译路径不存在上游 Anthropic 事件 | ✅ |
| 5 | `message_start` 初始真实 usage；`message_delta` 累计 usage | 同格式原样 ✅；翻译路径 `message_start` 置 0，`message_delta` 带累计 | ⚠️（F-6） |
| 6 | 细粒度工具流（`input_json_delta`） | 同格式透传 ✅；翻译路径合成 `input_json_delta` ✅（无 eager_input） | ✅/⚠️ |
| 7 | `POST /v1/messages/count_tokens`（可选，干净失败安全） | **被当作完整生成执行**：烧一次推理且返回 Message 而非 `{input_tokens}` | ❌（F-1，P0） |
| 8 | `GET /v1/models`（可选发现；Anthropic 形状 `data/has_more/first_id/last_id`；无重定向） | OpenAI 形状；条目为上游模型名（订阅配置下含 claude-*，BYO 第三方名不含 claude/anthropic 会被 CC 过滤掉）；无重定向 ✓、无 `display_name` | ⚠️（F-4） |
| 9 | `HEAD /api/hello` 可安全拒绝 | 404（官方明说可拒绝） | ✅（可不管） |
| 10 | 接受 Bearer 与 x-api-key | outbound 两者皆可 ✓；resident 仅 Bearer/x-goog（launcher 自有约定，不影响外部客户端） | ✅ |
| 11 | `anthropic-version` 逐字转发 | Claude 订阅路径调用方值可透传 ✓；**BYO 同格式固定 `2025-01-10`**（客户端值被覆盖，且非官方文档值） | ⚠️（F-7） |
| 12 | `anthropic-beta` 逐字转发、禁白名单 | 同格式合并基线 + 调用方旗标去重追加（无白名单 ✓，且为 OAuth 场景补 `oauth-2025-04-20` 合理）；翻译路径不转发（跨 wire 无意义，但功能静默 no-op 需文档化） | ⚠️（F-7） |
| 13 | `x-claude-code-*` 开放集合容忍 | 未转发但也不报错（容忍 ✓） | ✅ |
| 14 | system 数组不得重排/合并/降级 | 同格式字节透传 ✅；翻译路径按序解码保留（需测试钉住顺序） | ✅/⚠️ |
| 15 | `cache_control` 透传 | 同格式 ✅；翻译路径丢弃（OpenAI 自动缓存语义不同，可接受但 usage 的 cache_read 已映射回 ✓） | ⚠️ |
| 16 | thinking 签名块原样往返 | 同格式 ✅；翻译路径保留 thinking（跨 wire 签名无意义，可接受） | ✅/⚠️ |
| 17 | 透传 `stop_sequences`/`metadata`/`top_p`/`top_k` 等 | 同格式 ✅；**翻译路径静默丢弃** | ⚠️（F-5） |
| 18 | 内容块全集（`document`/`redacted_thinking`/`search_result`/`container_upload`） | 同格式 ✅；**翻译路径全部丢弃**（PDF 附件内容丢失！） | ⚠️（F-5） |
| 19 | 不认识的自定义模型名也发 `thinking:{"type":"adaptive"}` | 翻译路径解码 `adaptive`+effort ✓；kind 路由对未知 claude 名回退已配置种 ✓ | ✅ |
| 20 | 错误体原样转发（能力拒收恢复按措辞匹配） | **上游错误 verbatim + 真实状态码 ✓**（同格式与翻译路径皆然）；**本地错误非 Anthropic 形状**（`outbound_api_error`/`provider_proxy_error` 信封） | ⚠️（F-3） |
| 21 | Anthropic 错误形状 `{"type":"error","error":{…}}` | 本地错误不符合（Anthropic SDK 无法类型化解析） | ❌（F-3） |
| 22 | 流中 `event:error` 形状 `{"type":"error","error":{…}}` | 翻译路径合成 `{type:'api_error',message}`（旧形状） | ⚠️（F-8） |
| 23 | stop_reason 全集（含 `refusal`、`pause_turn`） | 翻译路径 `content_filter→stop_sequence`（语义错位）；无 refusal/pause_turn | ⚠️（F-8） |
| 24 | 429 带 `retry-after` / ratelimit 头透传 | 上游头 verbatim ✓（同格式）；本地 429（限流/并发/allowance）带 Retry-After ✓ 但错误体形状错 | ⚠️（并入 F-3） |
| 25 | 上游 OAuth 能力 beta（订阅场景不可剥） | Claude 订阅路径基线注入 `oauth-2025-04-20` ✓ | ✅ |

Claude 上游适配专项（非官方契约项，作为网关质量维度）：

| # | 维度 | 现状 | 判定 |
|---|---|---|---|
| U1 | OAuth 流程与官方 CLI 一致（client id、PKCE、平台端点） | ✓（且已迁移到 `platform.claude.com` token 端点） | ✅ |
| U2 | 401 刷新-重试一次、刷新合并、at-rest 加密 | ✓ | ✅ |
| U3 | 429 按 `anthropic-ratelimit-unified-reset` 冷却；529 过载冷却 | ✓（比 `retry-after` 更严格、更对） | ✅ |
| U4 | 上游错误 **body 类型**（`overloaded_error` 等）解析 | ✗ 仅按状态码/头；Anthropic SSE 带内 error 事件不检测 | ⚠️（F-9 邻项） |
| U5 | 限额（5h/7d）采集、缓存、调度、管理 API | ✓（策略默认关） | ✅ |
| U6 | 多账号轮换 + 粘性亲和 + failover e2e | ✓（无模型级 fallback 链——设计使然） | ✅ |
| U7 | usage 记账缓存感知、按上游模型记账 | ✓（`engineOrigin` 占位待修） | ✅/⚠️ |

---

## 6. 发现清单

### 6.1 P0（缺陷：错误行为 + 真实成本）

**F-1 `POST /v1/messages/count_tokens`（及一切 `/v1/messages/*` 子资源）被当作完整生成执行**
-位置：`outboundApiRouter.ts:206`（`path.includes('/v1/messages')`）与 `anthropicMessagesIngress.ts:60-65` 同款匹配；`completion/url-builder.ts:85-106,199-219` 恒构造 `/v1/messages` URL。
- 机理：count_tokens 请求（含 `model/messages/system/tools/thinking`）被选中为 messages 端点 → 正常走 kind 路由与鉴权 → `body.model` 改写后转发到上游 `/v1/messages` → **上游真实执行一次生成**。客户端拿回的是完整 Message JSON 而非 `{"input_tokens":N}`。
- 影响：① 每次 count_tokens 都烧一次推理（BYO=真金白银；订阅=5h 窗口额度，而 CC 上下文统计调用频繁）；② 客户端解析错乱（SDK 期望 `input_tokens` 顶层字段）；③ 官方语义"干净失败可回退"被破坏——**当前行为比 404 更糟**。`/v1/messages/batches` 等未来子资源同理会被误执行。
- 修复方向：精确路由（见需求文档 R1/R2）。**最小止血**：把 `/v1/messages` 匹配收紧为"路径恰为 `/v1/messages`（或以其结尾的根路径）"，子资源返回 Anthropic 形状 404，让 CC 走官方回退。

### 6.2 P1（协议保真缺口，客户端可感知）

**F-2 本地错误不是 Anthropic 错误形状**
- 位置：`outboundApiRouter.ts:106-116`、`providerProxyShared.ts:474-478`；形状 `{"error":{"type":"outbound_api_error"|"provider_proxy_error",…}}`。
- 影响：Anthropic SDK 类型化解析失败；更关键的是官方"能力拒收恢复"按上游**错误措辞**匹配，网关信封会破坏 CC 的 thinking/cache_control 能力降级重试（上游错误本身 verbatim ✓，故仅本地生成错误受影响——鉴权失败、限流、无路由、allowance 429、并发门、502/503 等，恰恰是高频错误）。
- 注：上游错误透传做得对，不要动；需要补的是**本地**错误的 Anthropic 化（`{"type":"error","error":{"type":"…","message":"…"}}`），401/403/429/5xx 映射到 `authentication_error`/`permission_error`/`rate_limit_error`/`api_error`/`overloaded_error`。

**F-3 `/v1/models` 非 Anthropic 形状、暴露上游名而非客户端别名**
- 位置：`outboundApiRouter.ts:227-232,287-295`。
- 影响：① Anthropic SDK `models.list()` 期望 `data/has_more/first_id/last_id`；② CC 网关模型发现（可选功能）按"id 含 claude/anthropic"过滤——BYO 第三方上游名全被滤掉，**而该功能的本意恰是向 CC 广告网关自定义别名**（messages 端点的 kind 名 fable/opus/sonnet/haiku 及其展开并未被广告）；③ 无 `display_name`。
- 方向：按端点/协议返回对应形状；Anthropic 协议下广告 kind 名与配置的 claude 别名（详见需求 R4）。

**F-4 翻译路径静默丢弃请求字段与内容块（含 PDF）**
- 位置：`AnthropicConversion.ts:43-239`（`top_p/top_k/stop_sequences/metadata` 及未识别字段丢弃）；`document`/`redacted_thinking`/`search_result`/`container_upload` 无处理。
- 影响：**`document`（PDF）块丢弃是数据丢失**——Claude Code 的 Read 工具读 PDF 会发 document 块，经翻译路径（如 Codex/Gemini/OpenAI 上游）内容无声消失，模型"看不见"附件；`stop_sequences`/`metadata.user_id` 丢弃改变行为与归因；`top_p/top_k` 丢弃改变采样。同格式路径无此问题。
- 方向：能映射的映射（stop_sequences→OpenAI `stop`；PDF→文本抽取或图片；top_p 可映射），不能映射的**显式拒绝或记审计告警**——不许静默。

**F-5 合成 SSE 的 `message_start` usage 置零、无 ping、错误事件形状旧**
- 位置：`AnthropicOpenAIToAnthropicStream.ts:73,130`（usage 0）；全文无 ping；带内 error 为 `{type:'api_error',message}`（官方现形状 `{"type":"error","error":{…}}`）。
- 影响：① **300 秒字节看门狗风险**：翻译自不产心跳的上游（OpenAI/Responses）时，长推理静默期无任何字节，CC 会误中断流（官方明确要求网关在静默间隙合成 ping）；② CC 的 token 实时显示与上下文统计初期读 `message_start` usage，置 0 造成误读（最终 `message_delta` 累计可部分弥补）；③ 旧错误形状 SDK 解析异常。
- 方向：合成路径补 ping 计时器（如 15-30s 间隔）；`message_start` 尽量预填输入 usage（上游首 chunk 的 prompt_tokens 可得）；error 事件改官方形状。

**F-6 `anthropic-version` 未逐字转发（BYO 同格式固定 `2025-01-10`）**
- 位置：`completion/header-builder.ts:30`。
- 影响：客户端 `anthropic-version` 被覆盖；`2025-01-10` 不是官方文档值（官方仍为 `2023-06-01`），对真 Anthropic/兼容上游存在拒收或行为漂移风险。Claude 订阅路径无此问题（调用方值可透传）。
- 方向：BYO 同格式改为"调用方有则透传，无则默认 `2023-06-01`"；订阅路径现状已符合。

**F-7 `stop_reason` 映射不完整**
- 位置：`AnthropicOpenAIToAnthropicStream.ts:259-264`。
- 影响：`content_filter→stop_sequence` 语义错位（客户端会以为命中了自定义停止序列）；无 `refusal`/`pause_turn` 处理（当前 OpenAI 上游不产这两种，风险低，但形状应预留）。
- 方向：`content_filter→refusal`（或 `end_turn` + 显式告警），映射表补全集并测试钉住。

**F-8 Codex 过载可见性未接入 `/v1/messages`→Codex 桥**
- 位置：`anthropicMessagesByo.ts:190`（`relayResponse` 只传 rewriteModel+usageTap，无 onSseEvent 观察者）；`ServerOverloadCounter` 仅 `/v1/responses` 接线。
- 影响：Anthropic 协议客户端走 Codex 订阅时，"at capacity"（200+SSE `response.failed`）不进健康机/趋势计数，账号不被标记，重复撞墙（与既有 Codex 侧修复同理，桥上漏接）。

### 6.3 P2（缺失的可选能力 / 观察项）

- **F-9 `/api/oauth/usage` 未在出站面代理**：CC 的 `/usage` 与 crs 类工具取不到经 omnicross 的限额视图（omnicross 自己经 admin API 有完整 allowance 面）。可选增强（需求 R9）。
- **F-10 上游 Anthropic 错误 body 类型与 SSE 带内 error 不解析**：健康机全按状态码/头；带内 `event:error`（如 overloaded）不触发过载冷却。对 Anthropic 上游罕见（多用 529 状态，已处理），观察项。
- **F-11 翻译路径 `tool_result` 内图片占位 `'[image omitted]'`**：OpenAI chat/Responses wire 的 tool 消息不能带图，属协议限制；Responses 上游可评估图片支持后升级。
- **F-12 `web_search_tool_result` 渲染为 markdown 文本**（翻译路径响应方向）：可接受的降级，需文档化。
- **F-13 usage 事件 `engineOrigin` 复用 `'codex-ingress'` 占位**：遥测误标（代码已自标注），顺手修。
- **F-14 无 `/v1/messages/batches`、Files API、citations、MCP connector 等扩展面**：CC 不依赖；若目标是"通用 Anthropic 兼容网关"（SDK 用户任意场景）则属长尾，暂列非目标。
- **F-15 resident 代理 `x-api-key` 不作为 token 源**：launcher 约定内自洽；若有第三方客户端直连 resident 端口需知此约定（文档项）。

---

## 7. 正面确认（不要在这些地方回退）

1. **同格式路径的保真纪律**：请求体逐字节透传（仅改 model）、SSE 原样转发、未知事件天然透传、ping 原样通过、上游错误 verbatim + 真实状态码——完全符合官方网关契约的核心要求，这是 omnicross 最大的护城河，任何重构不得破坏。
2. **model 改写的精细实现**：跨 chunk 装行、保留事件框架与换行风格、只动 model 字段、记账仍按上游真实模型。
3. **鉴权边界**：客户端凭证剥除、内部 route token、外部 key 不出网；双认证头接纳。
4. **`anthropic-beta` 合并策略**：无白名单 + 基线注入（`oauth-2025-04-20` 对订阅上游是必要的）——符合官方"禁白名单"要求。
5. **Claude 上游健康语义**：429 严格按 `anthropic-ratelimit-unified-reset`、529 过载冷却、401 刷新重试一次且以最终结果记账。
6. **限额体系**：5h/7d 窗口采集、缓存、调度策略、管理 API、多账号亲和轮换，均有测试。
7. **官方 OAuth 流程还原**：CLI client id、PKCE、平台端点迁移跟進。
8. 双拼路径折叠、`?beta=true` 容忍、尾斜杠容忍等兼容性细节。

---

## 8. 结论

omnicross 的 Claude 接口支持是**"单端点深度中转"**而非**"完整协议网关"**：`/v1/messages` 主链路（尤其同格式路径）质量高，但官方网关契约要求的**外围端点**（count_tokens——现状有害而非仅缺失、models 形状）、**错误协议**、以及**翻译路径的保真度**存在系统性缺口。P0 的 count_tokens 误执行建议立即止血（收紧路由匹配），P1 各项按需求文档的切片逐步补齐。

---

## 9. 附录：本次审查引用的官方资料

| 资料 | 用途 |
|---|---|
| [LLM gateway protocol reference](https://code.claude.com/docs/en/llm-gateway-protocol) | 网关契约基准：端点、头部逐字转发、ping/看门狗、错误透传、能力拒收恢复 |
| [Gateway connect](https://code.claude.com/docs/en/llm-gateway-connect) / [Authentication](https://code.claude.com/docs/en/authentication) / [Env vars](https://code.claude.com/docs/en/env-vars) | 认证头映射、凭证优先级、订阅 OAuth 场景 |
| [Messages API](https://platform.claude.com/docs/en/api/messages) | 请求体字段、thinking 签名往返、错误形状 |
| [Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming) | SSE 事件全集、message_delta 累计 usage、ping |
| [Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) | count_tokens 端点与响应形状 |
| [Models list](https://platform.claude.com/docs/en/api/models-list) / [Beta headers](https://platform.claude.com/docs/en/api/beta-headers) | 模型列表形状、beta 开放集合 |
| [Rate limits](https://platform.claude.com/docs/en/api/rate-limits) / [Errors](https://platform.claude.com/docs/en/api/errors) | 429 头、retry-after、ITPM 记账口径 |
| [Model config](https://code.claude.com/docs/en/model-config) | 别名、`[1m]` 后缀、背景模型、fallbackModel |

社区观察项（官方机制确认、字符串未见于文档）：`claude-code-20250219`、`oauth-2025-04-20`、`fine-grained-tool-streaming-2025-05-14`、`/api/oauth/usage`。

# Omnicross 的 Codex 完整中转协议需求

> 状态：Draft / Ready for technical review
>
> 审计日期：2026-08-29
>
> 审计基线：Omnicross `main`；Codex CLI `0.150.1`
>
> 受众：`@omnicross/core`、`@omnicross/subscriptions`、daemon、CLI integration 与测试维护者

本文中的“必须 / MUST”“应该 / SHOULD”“可以 / MAY”具有需求约束含义。

## 0. Session A 执行契约

本节是可直接交给独立开发 session 的启动合同；若与后文较宽的路线图冲突，以本节对本 Change 的收口为准。

### 0.1 身份与前置条件

| 项目 | 固定值 |
|---|---|
| Rasen Change | `codex-responses-core-profile` |
| 开发分支 | `feat/codex-responses-core-profile` |
| 建议 worktree | `omnicross--codex-responses-core-profile` |
| 集成基线 | 共享 operation dispatch / registry PR 合并后的最新 `origin/main` SHA |

启动前必须确认共享前置 PR 已合并。不得从未合并的本地共享提交、另一个业务分支或陈旧的本地 `main` 建立此分支，也不得把前置分支的提交 SHA 硬编码成长期依赖。

Session 启动顺序固定为：

1. 在 Omnicross 仓库执行 `git fetch origin main`。
2. 解析并记录 `git rev-parse origin/main`；该值是本 session 的 `BASE_SHA`。
3. 确认目标分支和 worktree 路径不存在。
4. 从同一个 `BASE_SHA` 创建上述 worktree 与分支。
5. 在 Change 的 design/evidence 中记录 `BASE_SHA`，以便与 Image session 对账。

### 0.2 本 session 的 P0 范围

必须完成：

- Native Responses Profile：请求字段、input/output item、JSON、SSE 未知事件和原生错误不得被 reduced transformer 静默改写。
- `POST /v1/responses/compact` 的原生 relay，并复用现有 Responses admission、路由、配额、并发、审计和账号选择。
- compact 输出按 OpenAI 官方语义作为**完整的下一轮 canonical context window**返回；不得只挑出 compaction item，也不得裁剪返回的 output。
- 原生 response status、必要响应头、request ID、`Retry-After`、rate-limit 信息和 SSE 时序保真。
- 客户端断开、请求超时与上游取消使用共享 `AbortSignal` 收敛，且释放流、监听器和并发槽。
- `previous_response_id`、stored upstream state 与 provider/account affinity 的安全约束；不能跨账号误续接。
- Reduced profile 的显式白名单和早拒绝：无法保真的字段、item 或 hosted tool 必须在上游调用前返回结构化 unsupported 错误。

明确排除：

- `/v1/images/generations`、`/v1/images/edits` 和 Responses `image_generation` 的本地执行。
- standalone web search、Files、`/responses/input_tokens`、stored/background Responses 附属方法。
- Responses WebSocket。
- 最终 ImageProvider、图片权限/UI、multipart、产物存储或订阅生图私有协议。

### 0.3 文件所有权与并行约束

本 session 拥有：

- `packages/core/src/provider-proxy/ingress/openaiResponsesIngress.ts`
- `packages/core/src/provider-proxy/ingress/providerProxyShared.ts`
- 新增的 compact/native Responses adapter、header relay、affinity 与对应测试文件
- Core profile 所需但不承载图片业务的最小配置/能力测试

本 session 不得修改 `packages/core/src/openai-operation/**`，不得重新定义 operation ID、registry、错误包络或取消契约。它只消费共享前置 Change 已发布的接口。

Compact 实现必须以独立的 `responses.compact` handler/registration contribution 导出；业务代码不得直接占用最终 daemon/app-session bootstrap。若 Image session 也需要同一个 composition 文件，由最终 integrator 统一完成注册。

### 0.4 交付与验收

完成前至少应具备：

- compact full-window round trip、unknown field/item/event、header/error/abort、affinity 和 reduced-profile 早拒绝的 contract/golden tests。
- Core typecheck、直接相关测试及仓库约定的构建检查。
- 一份说明已实现能力、明确未支持能力、`BASE_SHA` 与交给最终 integrator 的 contribution 的 handoff。

## 1. 结论

Omnicross 不需要复制整个 OpenAI Platform。它需要实现一份有版本、有能力声明、有降级边界的 **Codex Responses Profile**。

当前实现已经能服务最基础的 Codex 文本与本地工具循环，但“支持 `POST /v1/responses`”不等于“完整支持 Codex”。完整中转至少分为四层：

1. **核心 Responses wire**：请求字段、input/output item、SSE、错误、usage、取消与未知事件的无损透传。
2. **长会话与传输**：`POST /v1/responses/compact`；可选的 Responses WebSocket；状态和账号亲和。
3. **托管工具**：web search、image generation 等需要上游真正执行的工具；它们不能被普通 Chat Completions 转换器假装支持。
4. **资产与生命周期**：图片输入、可选 Files 子集、图片生成/编辑、后台任务与已存储 Response 的附属方法。

建议的交付优先级是：

- **P0**：核心 Responses Profile + `/responses/compact` + 错误/响应头保真。
- **P1**：Responses `image_generation`、独立 Images API、standalone web search；再按收益实现 WebSocket。
- **P2**：`/responses/input_tokens`、Files 子集、stored/background Responses 方法。
- **非目标**：为了 Codex 而实现完整 Chat Completions、Assistants、Batch、Fine-tuning、Moderations、Realtime/Audio 或全部 OpenAI 管理 API。

## 2. 官方协议基线

### 2.1 Codex custom provider

Codex 自定义 Provider 当前只支持 `wire_api = "responses"`。Provider 还可以分别声明 `supports_websockets` 与 `supports_standalone_web_search`；后者默认关闭且仍属开发中能力。Codex 配置同时提供稳定的 zstd 请求压缩开关，但官方文档只说“在支持时”压缩，没有公开 custom provider 的协商机制。[Custom model providers](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers) [Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)

因此，Omnicross 必须把“协议可用”和“向 Codex 广告该能力”分开：未通过兼容测试的能力保持 `false`，不能只因为路由存在就打开开关。

### 2.2 Responses 与长会话

OpenAI 的 Responses API 支持完整 input/output item、工具调用、图片输入、流式事件、`previous_response_id` 和 `store`。长会话既可在普通 `/responses` 中使用 `context_management` 做服务端压缩，也可显式调用无状态的 `POST /responses/compact`，并把返回的完整 compacted window 原样用于下一轮。[Create a Response](https://developers.openai.com/api/reference/resources/responses/methods/create) [Compaction](https://developers.openai.com/api/docs/guides/compaction) [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)

### 2.3 WebSocket

Responses WebSocket 使用同一个 `/v1/responses` 地址。客户端发送 `response.create`，可使用 `stream_id` 多路复用、`previous_response_id` 增量续接和 `generate: false` 预热；连接最长 60 分钟，单连接最多 16 个活跃 response 和 32 个命名 stream。`stream` 在 WS 中隐含，`background` 不支持。[WebSocket Mode](https://developers.openai.com/api/docs/guides/websocket-mode) [WebSocket events](https://developers.openai.com/api/reference/resources/responses/websocket-events)

### 2.4 托管工具

Responses 的 function/custom tool 只要求模型返回调用项，工具通常由 Codex 本地执行。`web_search`、`image_generation`、file search、code interpreter、computer use 等托管工具则必须由 OpenAI 或兼容上游真正执行。

`image_generation` 仍通过 `POST /responses` 声明，成功结果为 `image_generation_call`，最终图位于 Base64 `result`，流式预览使用 `response.image_generation_call.partial_image`。[Responses Image Generation Tool](https://developers.openai.com/api/docs/guides/tools-image-generation) [Image generation](https://developers.openai.com/api/docs/guides/image-generation)

## 3. 本次代码审计结果

### 3.1 已支持

| 能力 | 现状 | 证据 |
|---|---|---|
| `POST .../responses` | 已支持 HTTP JSON 与 SSE | `packages/core/src/outbound-api/outboundApiRouter.ts:195`、`packages/core/src/provider-proxy/ingress/openaiResponsesIngress.ts:98` |
| `GET .../models` | 已支持 OpenAI list 基本形态 | `packages/core/src/outbound-api/outboundApiRouter.ts:228`、`:427` |
| 同协议 Responses→Responses 原样旁路 | 已存在；只有 endpoint transformer 与唯一 provider transformer 同名时启用 | `packages/core/src/transformer/TransformerChainExecutor.ts:351` |
| function/custom tool 循环 | native passthrough 可无损；跨协议路径已有部分映射 | `packages/core/src/transformer/transformers/OpenAIResponseTransformer.ts` |
| reasoning summary、usage、主要文本/tool-call SSE | native passthrough可保留；跨协议有合成支持 | `OpenAIResponseTransformer.ts`、`providerProxyShared.ts` |
| Codex Provider 显式关闭 WS | 已诚实广告 `supports_websockets = false` | `packages/daemon/src/integrations/configAdapters.ts:62` |

### 3.2 部分支持

| 能力 | 当前行为 | 风险 |
|---|---|---|
| 完整 Responses 请求字段 | native bypass 可保留；一旦进入 Unified Chat 转换，只保留有限字段 | `include`、`context_management`、`previous_response_id`、`service_tier`、`truncation`、`parallel_tool_calls`、hosted tools 等可能丢失 |
| 完整 input item | reasoning 与 agent message 在跨协议 decode 中被主动跳过 | 多轮推理、phase、compaction 和新 item 类型不能跨协议保真 |
| 完整 SSE | native 路径逐行转发未知事件；跨协议只合成显式认识的事件 | `image_generation_call`、`web_search_call`、`tool_search_call`、compaction 等新事件可能消失 |
| 图片输入 | native Responses 上游可透传；跨协议 `flattenContent` 只保留文本 | `input_image`、`input_file` 不能承诺跨协议可用 |
| `previous_response_id` | native 上游可能接受；Omnicross 不拥有状态 | 账号池切换后 ID 可能指向另一个账号的状态空间 |
| 响应头 | body/status 基本保留，但 relay 重建少量响应头 | `Retry-After`、request ID、rate-limit 与诊断头会丢失 |
| 大请求 | 可接收，但两层都整包读入 UTF-8 字符串 | Base64 图片造成重复内存占用，且没有明确 body 上限 |

跨协议损失的直接证据包括：

- `OpenAIResponseTransformer` 的公开请求类型只列出有限顶层字段；`transformRequestOut` 把 Responses 降为 Unified Chat。
- `SKIPPED_INPUT_ITEM_TYPES` 当前包含 `reasoning` 与 `agent_message`（`OpenAIResponseTransformer.ts:513`）。
- outbound 与 resident proxy 都直接 `Buffer.concat(...).toString('utf8')`（`outboundApiRouter.ts:299`、`providerProxyShared.ts:78`）。
- relay 对 SSE 和 JSON 重新设置少量头（`providerProxyShared.ts:303`、`:351`）。

### 3.3 缺失

- `POST /v1/responses/compact`。
- Responses WebSocket Upgrade、连接状态、lane 与 WS 事件代理。
- standalone web search 兼容端点与 Provider capability。
- `POST /v1/images/generations`、`POST /v1/images/edits`。
- 对 Responses `image_generation` 的明确识别、能力检查、订阅上游执行和端到端测试。
- `/v1/files` 的任何兼容子集。
- `POST /v1/responses/input_tokens`。
- stored/background response 的 retrieve、cancel、input_items 与 delete 生命周期。
- `Content-Encoding: zstd` 入站解压。

路由缺口是确定的：公共网关只把 POST 请求分类为 chat、responses、messages 或 Gemini，其他路径统一 404（`outboundApiRouter.ts:195`、`:435`）。

## 4. Codex 所需接口矩阵

| 协议面 | 优先级 | Codex 0.150.1 | Omnicross | 需求结论 |
|---|---:|---|---|---|
| `POST /v1/responses` HTTP/SSE | P0 | 核心 | 部分支持 | 完成 Codex Profile；native 路径 MUST 无损 |
| `POST /v1/responses/compact` | P0 | 当前二进制包含且长会话会使用 | 缺失 | MUST 实现/转发；不可当普通 `/responses` 转换 |
| Responses server-side compaction | P0 | 可由请求字段启用 | native 可透传，跨协议丢失 | native MUST 保留 `context_management` 与 compaction item/event |
| Responses WebSocket | P1 | Provider capability 控制 | 明确关闭 | MAY 后续实现；未完成继续广告 false |
| standalone web search | P1 | capability 控制、实验性 | 未广告、无端点 | 完成真实执行后才设置 true |
| Responses `image_generation` | P1 | ImageGen 的核心内置路径 | 只有理论 native passthrough | MUST 做 native e2e；订阅上游不原生支持时由 broker 执行 |
| `POST /v1/images/generations` | P1 | 非 Codex 核心 wire；SDK/CLI fallback 需要 | 缺失 | 生图产品面 SHOULD 实现 |
| `POST /v1/images/edits` | P1 | 非 Codex 核心 wire；多轮/SDK 编辑需要 | 缺失 | 生图产品面 SHOULD 实现 |
| `POST /v1/responses/input_tokens` | P2 | 本机 0.150.1 未观察到调用 | 缺失 | 为 SDK/未来 Codex兼容实现；不阻塞首个 GA |
| `GET /v1/responses/{id}` | P2 | 普通 Codex 流式路径不依赖 | 缺失 | 仅当支持 stored/background 时实现 |
| `POST /v1/responses/{id}/cancel` | P2 | HTTP Codex 通常断流取消 | 缺失 | background job 出现后实现 |
| `GET /v1/responses/{id}/input_items` | P2 | 普通 Codex 不依赖 | 缺失 | 与 stored response 同一 change |
| `DELETE /v1/responses/{id}` | P2 | 普通 Codex 不依赖 | 缺失 | 与本地持久化/删除语义一起实现 |
| `/v1/files` 最小子集 | P2 条件 | inline image 不要求 | 缺失 | 只有 file_id、编辑引用或 hosted tool 需要时实现 |
| `GET /v1/models` | 辅助 | custom provider 不以它作为完整 capability catalog | 已有基本列表 | 保留；不能代替 Codex `model_catalog_json`/本地 capability |
| Conversations API | 非核心 | Codex 自管 thread，不要求 | 缺失 | 不为 Codex 首期实现 |
| Chat Completions/Assistants/Batch/Realtime | 非核心 | custom provider wire 不调用 | 部分/缺失 | 不纳入“Codex 完整中转”定义 |

## 5. P0：Codex Responses Profile

### 5.1 路由与方法

MUST 支持：

- `POST /v1/responses`。
- `POST /v1/responses/compact`。
- 对 base URL path prefix 采用一致规则，例如 `/v1/responses` 与 `/openai/responses`；不能让 `compact` 因 prefix 拼接被丢到错误 host root。
- route binding、named API key、账号选择、审计与 usage 必须适用于 compact，不得绕过现有安全边界。

`/responses/compact` 是独立 schema：输入是完整 context window，输出对象的 `object` 为 `response.compaction`，`output` 包含可重放 item 和 opaque `compaction.encrypted_content`。MUST 原样返回完整 output，不能只取 compaction item，也不能转换成 Chat message。

### 5.2 Native 与 Reduced 两种 profile

Omnicross MUST 显式区分：

- **Native Responses profile**：上游就是兼容 Responses；未知字段、未知 input/output item、未知 SSE 事件默认透传，只允许做经过测试的 model ID、鉴权、usage side-tap 和敏感头处理。
- **Reduced cross-protocol profile**：上游是 Chat/Anthropic/Gemini；只承诺 text、reasoning summary、function/custom tool 的已测试子集。所有无法保真的字段或 hosted tool 必须在上游调用前返回 `unsupported_capability`，不能静默删除。

Native profile 的旁路不能只是当前 transformer 数组恰好相等时的优化；它应成为经过契约测试的协议保证。新增 transformer、审计或计费 hook 不得意外关闭无损旁路。

### 5.3 请求字段

Native profile MUST 保留至少以下字段，并默认保留未来未知字段：

- `model`、`input`、`instructions`、`tools`、`tool_choice`。
- `stream`、`store`、`previous_response_id`、`conversation`。
- `reasoning`、`text`、`include`、`metadata`。
- `parallel_tool_calls`、`max_output_tokens`、`temperature`、`top_p`。
- `prompt_cache_key`、`prompt_cache_retention`。
- `service_tier`、`truncation`、`context_management`、`background`。

不得把 `store:false` 强制改成 true，也不得在账号池之间转移一个仍引用上游状态的 `previous_response_id`。

### 5.4 item 与工具

Native profile MUST 透明保留：

- message，以及 `input_text`、`output_text`、`input_image`、`input_file` 等 content part。
- reasoning 和 encrypted reasoning。
- function/custom tool call 与 output。
- `tool_search_call` / `tool_search_output`。
- `web_search_call`。
- `image_generation_call`。
- compaction、compaction trigger、context compaction。
- `phase`、namespace、item ID、call ID、status 和未来未知 item。

本地工具与托管工具必须分开：

- shell、apply_patch、function/custom、MCP 和插件工具由 Codex/宿主本地执行；Omnicross只需保真转发调用项。
- web search、image generation 等 hosted tool 必须由 native 上游或 Omnicross broker 真实执行。
- Reduced profile 不得把 hosted tool 简单改名成普通 function，然后返回一个看似成功但没有真实工具结果的 item。

### 5.5 SSE、错误与响应头

MUST：

- 保留 `event:`、`data:`、空行边界、CRLF/LF、未知事件和终端事件。
- 支持 `response.completed`、`response.failed`、`response.incomplete` 与顶层 `error`。
- 客户端断开时向上游传播 abort，停止读取与写入。
- 4xx/5xx JSON 不得伪装成 200 SSE。
- 透传或安全映射 `Retry-After`、`x-request-id`、rate-limit、content-type 和必要的 OpenAI 诊断头。
- 对 429 遵循 `Retry-After`；凭证/额度错误与瞬时容量错误使用不同稳定 code。[Error codes](https://developers.openai.com/api/docs/guides/error-codes)

usage observer MUST 是只读 side tap。解析失败不得改变 relayed bytes；未知 usage 字段可保留，不得伪造为 0。

## 6. 状态、账号池与压缩

### 6.1 默认推荐：stateless full replay

对可能跨订阅账号 failover 的路由，默认 SHOULD 使用 `store:false` 并由 Codex携带完整 input/output history。reasoning、encrypted content、compaction item 与 tool items 都必须进入下一轮。

### 6.2 `previous_response_id`

如果允许增量续接：

- Response ID 必须绑定 upstream provider、账号、租户/key 和会话。
- 账号健康切换不能带着旧账号的 `previous_response_id` 请求新账号。
- 找不到状态时返回可识别的 `previous_response_not_found`；客户端可用完整 history 与 `previous_response_id:null` 重试。
- Omnicross 不得把 upstream Response ID 暴露给另一个 key 或租户。

### 6.3 compaction

- standalone compact 请求必须保持与后续 generation 相同的模型映射和账号选择规则。
- compact output 是下一窗口的 canonical input，必须原样保留所有 item。
- server-side compaction 的 `context_management` 和流中 compaction item/event 在 native profile 中不得被转换器删除。
- compact 调用的 usage、延迟、失败原因和所选账号进入现有 audit/usage，但不得记录 `encrypted_content`。

## 7. P1：托管工具

### 7.1 Image generation

Responses 工具路径 MUST 支持：

```json
{
  "model": "gpt-5.6",
  "tools": [{ "type": "image_generation", "model": "gpt-image-2" }],
  "input": "生成一张透明背景角色立绘"
}
```

并保留：

- `image_generation_call` 的 `id`、`status`、`result`、`revised_prompt`。
- `response.image_generation_call.partial_image`。
- 同一 response 内与 message/reasoning/其他 tool item 的相对顺序。
- 多轮编辑需要的 response/call 引用与租户隔离。

独立 Image API SHOULD 同时实现：

- `POST /v1/images/generations`。
- `POST /v1/images/edits`。
- 非流式 Base64、流式 partial、透明背景、尺寸/格式/质量、mask、多参考图、取消与有界缓存。

Responses 工具和 Images API MUST 共用内部 ImageProvider/ImageOrchestrator；不能维护两套订阅私有协议。

### 7.2 Web search

standalone web search 只有在以下条件全部满足后才能广告：

- 已按当前 Codex 版本验证兼容 endpoint、请求 schema、响应 item 与错误语义。
- 能执行 live/indexed 模式和 allowed domains，而不是仅忽略配置。
- web result 被视为不可信输入，并保留来源/citation 所需字段。
- workspace/managed restrictions 仍生效。

官方 Codex 文档目前没有在公开页给出 standalone endpoint 的完整 wire schema。因此该 change MUST 先以当前 Codex 的可重复 capture/golden fixture 锁定协议，再实现；不能根据名称猜出一个 `/search` 路由。[Codex web search](https://learn.chatgpt.com/docs/web-search#search-with-a-custom-model-provider)

## 8. P1：Responses WebSocket

实现 WS 时 MUST：

- 在 HTTP server 注册 Upgrade，仅接受已鉴权的 `/v1/responses`。
- 透传 `response.create` 和所有 server events；保留 `stream_id`。
- 同 lane FIFO，不同 lane 可并行；实现明确的每连接上限与 backpressure。
- 支持连接内 `previous_response_id` 状态亲和；同一 WS 连接不能中途换账号。
- 处理 `previous_response_not_found`、stream limit、connection limit 与 60 分钟重连。
- WS 与 HTTP compact 协同：compact 仍走 HTTP，返回 window 后通过新的 WS `response.create` 使用。
- 实现完成并通过 current Codex e2e 后，才把 `supports_websockets` 改为 true。

WebSocket 是性能/长工具链增强，不应阻塞 HTTP P0；当前广告 false 是正确行为。

## 9. P2：附属 API

### 9.1 Input token count

`POST /v1/responses/input_tokens` 接受与 create 相近的 input/instructions/tools/model 上下文，返回：

```json
{ "object": "response.input_tokens", "input_tokens": 123 }
```

它对预算控制和 SDK 兼容有价值，但本机 Codex 0.150.1 未观察到该字面 endpoint 调用，因此不阻塞首个 Codex GA。[Get input token counts](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count)

### 9.2 Stored/background Responses

只有当 Omnicross 决定支持 `store:true` 或 `background:true` 时，才一起实现：

- retrieve response。
- cancel response。
- list input items。
- delete response。
- 资源归属、TTL、跨 key 404、取消幂等和清理任务。

如果不实现，capability 与文档必须明确“streaming/stateless profile only”，并在收到 background/storage-only 行为时早拒绝。

### 9.3 Files

Codex 的 inline/local image 不要求完整 Files API。以下任一需求出现时再实现最小子集：

- `input_file.file_id` 或 `input_image.file_id`。
- Images edits 的 file reference。
- file search/code interpreter 的托管资产。

最小子集必须包含 create/retrieve/content/delete、租户隔离、不可猜测 ID、MIME/尺寸/字节上限、TTL 和日志脱敏。不要为了 `file_id` 兼容直接透传另一个账号创建的 upstream ID。

## 10. 传输与资源安全

### 10.1 请求压缩

本机 Codex 0.150.1 的实测结果：使用 custom provider 时，57 KB 的 `/v1/responses` 请求仍是普通 `application/json`，即使显式设置 `features.enable_request_compression=true`，也没有 `Content-Encoding: zstd`。因此 zstd 不是当前 Omnicross custom-provider P0 阻塞项。

但如果未来支持 `openai_base_url` 透明重定向、Codex 改变 custom-provider 行为，或实测收到 zstd，则 MUST：

- 在认证后、JSON 解析前有界解压。
- 仅接受声明的编码；未知编码返回 415。
- 同时限制压缩字节、解压字节和压缩比，防止解压炸弹。
- 移除/重算 `Content-Encoding`、`Content-Length` 后再 replay。

### 10.2 大图片与请求体

- 为 JSON 和 multipart 分别设置可配置上限。
- Base64 图片不得在 audit、普通日志、异常对象或 telemetry 中出现。
- 避免 outbound 读一次、replay 后 ingress 再复制一次的多份完整字符串。
- multipart 流式落入受控临时存储；校验真实 MIME、像素与压缩炸弹。
- 客户端断开、超时或上游失败后必须回收临时产物。

## 11. 模型与能力发现

`GET /v1/models` 继续提供 SDK 兼容列表，但它只有 `id/object/owned_by`，不能表达 Codex 所需的 context window、reasoning、verbosity、image detail、tool 和 compaction capability。

Omnicross integration SHOULD：

- 为受管 Codex 配置生成或引用版本化 `model_catalog_json`，或使用官方支持的明确配置覆盖。
- 将 `supports_websockets`、`supports_standalone_web_search` 只设置为真实 e2e 通过的值。
- 为管理 API 提供只读 capability document，区分 native、reduced、hosted-tool、images、storage 和 websocket。
- 不发明 Codex 不认识的 `supports_image_generation` TOML 字段；生图以真实 Responses e2e 与模型 catalog 能力验收。

## 12. 错误、审计与可观测性

MUST 区分：

- 入站 key 无效。
- 上游登录失效/需刷新。
- 订阅或 API usage limit。
- 瞬时 rate limit 与 server overload。
- unsupported capability / unsupported profile。
- previous response/account affinity 失效。
- upstream protocol changed。
- client cancelled / timeout。

指标至少包括 endpoint family、transport、profile、provider/account 的脱敏 ID、model、stream、tool types、queue wait、TTFT、总时长、input/output/cache/reasoning token、compact 次数、WS reconnect 和稳定 error code。

不得记录 access/refresh token、Cookie、Authorization、encrypted reasoning、compaction encrypted content、图片 Base64、file bytes 或完整敏感 prompt。

## 13. 建议 Changes

### Change A：`codex-responses-core-profile`

- 为 endpoint family 建立路由，不再只匹配 path 尾部 `/responses`。
- 实现 `/responses/compact` native relay。
- 把 native passthrough 固化为 contract；为未知字段/item/event 增加 golden tests。
- 补 response header、abort、错误和 body-limit 语义。
- 明确 reduced profile 的支持白名单与早拒绝。

退出条件：长会话能够 compact 后继续；native Responses fixture 字节/语义无损；现有文本回归全绿。

### Change B：`codex-hosted-tools-and-images`

- ImageProvider/ImageOrchestrator。
- Responses `image_generation` 与 partial events。
- `/images/generations`、`/images/edits`。
- capability、产物引用、并发、取消、usage/audit、安全限制。
- 本期不实现 standalone web search；它保持为后续独立 Change。

退出条件：当前 Codex `$imagegen` 与 OpenAI JS/Python SDK image smoke 通过；未实现的 web search capability 保持关闭。

### Change C：`codex-responses-websocket`

- Upgrade/auth、WS relay、lane/connection state、backpressure、重连与 account affinity。
- current Codex HTTP/WS 等价性与工具循环 benchmark。

退出条件：开启 `supports_websockets=true` 后，长工具链正确且相对 HTTP 有可测收益。

### Change D：`openai-response-resources`

- `/responses/input_tokens`。
- 按产品决定的 stored/background methods。
- 按实际调用方需要实现 Files 最小子集。

退出条件：对应 SDK contract tests 通过；未实现的完整 OpenAI API 仍明确返回 unsupported。

A 与 B 可以先冻结共同 contracts 后并行；C 独立于 Images，但依赖 A 的 Responses 事件与状态模型；D 不阻塞 Codex 主路径。

## 14. 验收标准

- **AC-01**：当前 Codex 通过 Omnicross 完成普通文本、reasoning、function/custom tool 多轮循环。
- **AC-02**：`/responses/compact` 返回完整 canonical compacted window，下一轮原样使用其 output 可继续任务；不得只保留 compaction item。
- **AC-03**：native profile 对未知顶层字段、item 与 SSE event 不删除、不改名。
- **AC-04**：reduced profile 收到无法保真的 hosted tool 或 item 时，在调用上游前返回结构化 unsupported 错误。
- **AC-05**：429/5xx、`Retry-After`、request ID 与 response.failed/incomplete 对 Codex 可见。
- **AC-06**：断开客户端会中止上游流和计费中的未完成工作，且不泄漏并发槽。
- **AC-07**：`store:false` full replay 在账号 failover 后继续；stateful response ID 不跨账号误用。
- **AC-08**：Responses `image_generation` 返回真实 `image_generation_call.result`，partial event 可渲染。
- **AC-09**：Images generation/edit 的 SDK contract、透明背景、mask、取消和错误路径通过。
- **AC-10**：web search 未实现时 capability 为 false；实现后 live/current Codex e2e 与来源字段通过。
- **AC-11**：WS 未实现时保持 false；实现后同 lane FIFO、跨 lane 并行、重连/限制错误通过。
- **AC-12**：大图片、恶意压缩、坏 SSE、HTML 错误页与未知 upstream schema 不导致假 200、OOM 或秘密泄漏。
- **AC-13**：已有 Chat、Messages、Responses、Gemini、账号池、usage 和 UI 测试不回归。

## 15. 审计证据与不确定性

### 15.1 本机 Codex 0.150.1 探针

使用隔离的临时 `CODEX_HOME` 和 localhost custom provider 捕获首个请求：

- 方法/路径：`POST /v1/responses`。
- body：约 57 KB JSON。
- `Content-Type: application/json`。
- 无 `Content-Encoding`；显式打开 request compression 后仍无 zstd。

对安装二进制的只读字符串检查能看到 `/responses/compact`、Responses WebSocket、`supports_websockets` 与 `supports_standalone_web_search`；未看到 `/responses/input_tokens`。字符串缺失不是严格证明，因此 input_tokens 仅据此降为 P2，而不是判定 Codex 永远不会调用。

### 15.2 官方文档未锁定的部分

- standalone web search 的公开 Codex 页面没有完整 wire schema；实现前需要 current-version capture。
- 官方 custom-provider 文档没有 image-generation capability 开关；是否在某个 Codex surface 自动暴露 ImageGen 必须 e2e 验证。
- ChatGPT/Codex 订阅上游不是公开稳定 API，不能从公开 OpenAI Platform API 文档推断 entitlement、额度、保留策略或私有路径长期不变。

## 16. 官方资料

- [Codex custom model providers](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)
- [Codex web search](https://learn.chatgpt.com/docs/web-search#search-with-a-custom-model-provider)
- [Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)
- [Compaction guide](https://developers.openai.com/api/docs/guides/compaction)
- [Responses compact](https://developers.openai.com/api/reference/resources/responses/methods/compact)
- [Responses input token count](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count)
- [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [Responses WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
- [Responses WebSocket events](https://developers.openai.com/api/reference/resources/responses/websocket-events)
- [Using tools](https://developers.openai.com/api/docs/guides/tools)
- [Web search tool](https://developers.openai.com/api/docs/guides/tools-web-search)
- [Responses image generation tool](https://developers.openai.com/api/docs/guides/tools-image-generation)
- [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
- [Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
- [Files API](https://developers.openai.com/api/reference/resources/files)
- [Error codes](https://developers.openai.com/api/docs/guides/error-codes)

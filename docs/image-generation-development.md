# Omnicross 生图功能开发文档

本文说明 Omnicross 0.2.0 中图片生成、参考图编辑和 Responses 图片工具的实现。内容以当前源码为准，面向维护者、协议适配器开发者和需要排查图片链路的贡献者。

面向最终用户的安装、配置和调用方式见 [生图功能使用文档](./image-generation-usage.md)。

## 1. 当前能力边界

Omnicross 对外提供三种图片入口，但它们最终复用同一个图片运行时、账号选择器、执行队列和订阅上游适配器。

| 入口 | 用途 | 当前状态 |
| --- | --- | --- |
| `POST /v1/images/generations` | OpenAI Images 风格文生图 | 已实现 |
| `POST /v1/images/edits` | OpenAI Images 风格参考图编辑 | 已实现单参考图编辑 |
| `POST /v1/responses` + `image_generation` | Responses 托管图片工具 | 已实现生成与图片状态编排 |

当前生产适配器的保守能力上限如下：

- 模型由 `images.models` 路由表决定（默认表：`gpt-image-2`、`gpt-image-2-5` → Codex 订阅；五个 gemini image 模型 → Antigravity 订阅）。
- 单次最多输出一张图片。
- 编辑最多接受一张参考图。
- 参考图支持 PNG、JPEG 和 WebP，单文件最大 50 MiB。
- 不支持 mask、多参考图和上游图片流式输出。
- 远程图片 URL 默认关闭；启用时必须注入经过验证的远程解析器。
- 实际可用的质量、尺寸、输出格式等选项还要经过适配器、账号和上游证据三层取交集，不能仅凭配置开关对外宣称支持。

## 2. 整体架构

```text
Codex 内置 image_gen ─┬─ POST /v1/images/generations ─┐
                     └─ POST /v1/images/edits ───────┤
OpenAI SDK / CLI ─────┴───────────────────────────────┤
                                                     ├─ Images 请求归一化
Responses API ─ POST /v1/responses ─ Hosted mediator ┤
                                                     └─ ImageOrchestrator
                                                          │
                                                          ├─ 能力证据
                                                          ├─ 账号选择与公平队列
                                                          └─ CodexSubscriptionImageProvider
                                                               ├─ generate → Codex Responses 上游
                                                               └─ edit → Codex Images Edits 上游
```

主要模块边界：

- `@omnicross/contracts` 定义 provider-neutral 的请求、能力、事件和错误类型。
- `@omnicross/core` 负责公共 API 解析、资源限制、统一编排、Responses 图片工具和输出映射。
- `@omnicross/subscriptions` 负责 Codex 订阅账号认证、私有上游协议和响应解码。
- `@omnicross/daemon` 负责运行时装配、配置热切换、私有存储、能力证据、doctor 和管理 UI 数据。
- `@omnicross/ui` 只展示配置、能力证据和资源状态，不通过轮询触发生图。

## 3. 公共 Images API

### 3.1 请求入口与权限

外部请求先经过 Outbound API 的命名 key 验证。图片端点使用独立的 `images` 权限，而不是把图片请求伪装成文本路由。

- `/v1/images/generations` 被分类为 `images.generate`。
- `/v1/images/edits` 被分类为 `images.edit`。
- Responses 请求若声明 `image_generation`，除了 `responses` 权限，还必须具备 `images` 权限。
- 通过认证后，外部 Bearer key 会被移除；图片运行时只接收可信的 `apiKeyId`、租户标识和服务端配置。

Codex 持久集成创建或绑定的 key 会同时具备 `responses` 和 `images` 权限。

### 3.2 请求归一化

公共层把 OpenAI Images 请求转换为 `NormalizedImageRequest<ImageAsset>`，订阅适配器不直接接触 HTTP、multipart 或用户提供的路径。

生成请求只接受 JSON。编辑请求支持：

- OpenAI SDK 使用的 `multipart/form-data`；
- JSON `image` 或 `images`；
- Base64 data URL；
- 同一租户下由 Omnicross 保留的 `file_id` 引用；
- 远程 URL，但仅在加固解析器已显式启用时可用。

解析阶段完成以下工作：

1. 对请求体、字段数、part 数、单文件、总输入和像素数实施有限上界。
2. 把上传内容写入请求级私有临时资源，不在业务对象中保留任意文件路径。
3. 用 `sharp` 验证容器、MIME、尺寸、像素数和完整解码。
4. 校验 mask 与首张参考图的尺寸兼容性。
5. 归一化模型、质量、尺寸、背景、输出格式、压缩、审核和流式选项。
6. 在任何上游调用前拒绝未知字段和不支持的组合。

公共解析器可以表达比当前订阅适配器更广的 Images 协议；最终仍由能力检查拒绝当前上游不能兑现的多图、mask、流式等请求。

### 3.3 统一编排

`ImageOrchestrator` 是 Images API 和 Responses 图片工具的共同执行核心。它负责：

- 从 `ImageProviderRegistry` 获取 provider lease；
- 在调用上游前执行能力检查；
- 统一处理 `accepted`、`partial_image`、`completed` 和 `failed` 事件；
- 校验最终图片数量、格式、尺寸、透明度和独立可解码性；
- 传播取消信号并保证 provider、队列和临时资源最终释放；
- 生成只含安全元数据的遥测；
- 按策略保留完成图片，并在失败或取消时回滚未完成的引用。

## 4. 订阅上游分流

文生图和参考图编辑不是同一个上游请求。

### 4.1 文生图

文生图由 `buildCandidateCodexImageRequest()` 构造一个 Codex Responses 请求：

- 上游地址：`https://chatgpt.com/backend-api/codex/responses`
- carrier model：`gpt-5.6-luna`（可由 `images.codex.carrierModel` 覆盖）
- 图片工具模型：`gpt-image-2`（可由 `images.codex.imageModel` 覆盖，`gpt-image-2-5` 上线只需配置变更）
- `tools` 中声明 `type: "image_generation"`
- `tool_choice` 强制选择图片工具
- 上游使用 SSE，Omnicross 收集最终 `image_generation_call.result`

上游 SSE 可以包含 partial image，但当前公共能力不把这些 partial 直接广告为可用流式图片。最终产物必须通过 Base64、容器和完整像素解码校验后才能进入 `completed`。

### 4.2 参考图编辑

编辑请求走独立的 Images Edits 上游：

- 上游地址：`https://chatgpt.com/backend-api/codex/images/edits`
- 请求格式：JSON
- 参考图格式：`data:<mime>;base64,<bytes>`
- 响应格式：Images API 风格的 `data[].b64_json`

当前请求形状为：

```json
{
  "images": [
    { "image_url": "data:image/png;base64,<redacted>" }
  ],
  "prompt": "将角色整理为三视图",
  "background": "auto",
  "model": "gpt-image-2",
  "quality": "auto",
  "size": "auto"
}
```

适配器在编码前再次执行生产能力限制：必须恰好一张图片、不得包含 mask，图片 MIME 必须为 PNG/JPEG/WebP，读取上限为 50 MiB。编码完成后会清零临时字节缓冲区。

### 4.3 上游响应完整性

`privateWireResponse.ts` 同时支持：

- Responses JSON/SSE 中的 `image_generation_call.result`；
- Images API JSON 中的 `data[].b64_json`。

返回图片要依次通过：

1. 严格 Base64 字符集、padding 和重编码一致性检查；
2. 50 MiB 解码大小限制；
3. PNG IEND、JPEG EOI 或 WebP RIFF 长度完整性检查；
4. `sharp` 元数据读取；
5. 最大 8,294,400 像素限制；
6. 完整 raw pixel decode，而不是只信任图片头。

任何不一致都映射为 `upstream_protocol_changed`，不会把截断或伪造的图片当作成功结果。

## 5. Responses 图片工具

`POST /v1/responses` 的 native profile 可以声明：

```json
{
  "tools": [
    { "type": "image_generation" }
  ],
  "tool_choice": { "type": "image_generation" }
}
```

Responses ingress 先检查请求中是否存在图片工具、强制图片选择、显式 `image_generation_call` 或已授权的上一轮图片状态。随后：

1. 为该请求获取固定代次的图片运行时 lease。
2. 验证 `tool_choice` 与模型返回的工具选择一致。
3. 让主模型产生图片调用和 prompt。
4. 通过同一个 `ImageOrchestrator` 执行图片调用。
5. 用本地生成的 `ig_*` 调用项替换内部选择项。
6. 将完成图片和调用状态保存到租户隔离的 reference/state store。
7. 在响应成功提交后记录 `response_id` 与图片调用关系。

状态存储支持安全解析上一轮 `response_id` 和显式图片调用 ID，但当前 provider 能力仍保守广告 `multiTurnEdit: false`；不要据此承诺任意多轮、多图编辑语义。

## 6. 能力证据与 bootstrap

图片能力由三层证据取交集：

1. **adapter**：本地实现能够表达什么；
2. **account**：当前选中账号是否有资格；
3. **upstream**：已观察到的上游协议是否能兑现对应能力。

配置 `images.enabled = true` 只表示允许启动图片运行时，不等价于账号一定有生图资格。UI 因此分别显示“已配置”和“实际状态”。

首次没有持久证据时，适配器允许一次真实请求 bootstrap。真实上游拒绝仍会被映射为稳定错误，不会因为文本 Responses 成功或仅出现模型名就升级图片能力。

显式运行 `doctor images --live` 时，verifier 会：

1. 发送一张最小低质量 PNG 生成请求；
2. 将生成结果作为输入，再发送一次编辑请求；
3. 只有两步都成功，才写入当前账号的能力证据。

证据存储为 `codex-image-capability-evidence.v2.json`，source version 为 `codex-image-live-verifier-v2`。账号原始 ID 不落盘，而是使用 daemon 私有 salt 做 HMAC。证据带 TTL、revision 和严格 schema；过期、损坏、账号不匹配或协议版本不匹配时会 fail closed。

当前 v2 证据还有一个已知的客户端兼容性限制：live verifier 只验证并持久化 `quality: low`，因此持久证据的 `qualityLevels` 只有 `low`；Codex 内置 imagegen 默认提交的 `quality: auto` 会在 `ImageOrchestrator` 的本地能力检查中被拒绝。此时的 `unsupported_capability` 不表示生成或编辑上游未接通。修复证据模型前，应使用显式设置 `quality: low` 的 CLI 或直接 Images API 验证链路，不能把 `auto` 自动等同于已验证的 `low`。

## 7. 账号、队列、超时和重试

图片运行时从 Codex 订阅账号策略中选择账号，可以指定固定账号、账号组或账号池回退策略。

执行调度器的关键行为：

- 默认每个账号同时执行 1 个图片任务；
- 默认最多等待 20 个任务；
- 默认排队超时 120 秒；
- 默认生成超时 180 秒；
- 同一账号下按租户轮转，避免单个 API key 长期占满队列；
- 调度器只保存经过 HMAC 的账号和租户标识。

普通 5xx、超时或传输失败不会盲目重复可能已经被上游接受的生图任务。唯一的自动重试路径是收到第一次 401 后：调用账号策略刷新凭证，并且仅在仍选择同一账号时重发一次。遥测只记录 `retryCount` 和 `authRefreshCount`。

## 8. 存储与生命周期

daemon 在配置文件同级的私有应用数据目录下管理图片根目录，分为：

- 临时请求资源；
- 完成图片 artifact/reference；
- Responses 图片调用状态；
- 能力证据；
- storage mount manifest。

路径解析器拒绝不安全的根目录，启动时会清理过期临时资源、核对 mount 状态并隔离损坏 manifest。配置切换采用 generation-pinned runtime：新请求进入新代次，旧请求在原代次完成，最后再释放旧 scheduler、store 和 evidence view。

## 9. 安全与可观测性

图片路径的安全原则：

- 请求正文、响应正文和 Base64 图片在共享上游 trace 中强制脱敏。
- audit 不捕获图片请求正文，也不记录 Authorization、Cookie 或图片内容。
- 原始订阅账号 ID 不进入日志、调度状态或能力证据文件。
- 对外只暴露随机、租户隔离的图片 reference ID，不暴露 provider 私有引用。
- 同租户的过期引用返回 410；不存在和跨租户引用统一表现为 404，避免枚举。
- 临时资源、队列 grant、provider lease 和存储 lease 都在 `finally` 路径释放。

Codex 自定义 provider 中的 `X-OpenAI-Actor-Authorization` 只用于满足当前 Codex 客户端的 `image_gen` 工具可见性判断。Omnicross 服务端不把它当认证凭证、图片能力证据或 edit 分流依据；真正的本地授权始终来自 Omnicross Bearer key。

## 10. 配置模型

图片服务默认关闭。模型→provider 由 `models` 路由表决定（默认表钉 `gpt-image-2`、`gpt-image-2-5` → `codex-subscription`，`gemini-2.5/3.1-flash-image(-preview)` 与 `gemini-3-pro-image-preview` → `antigravity-subscription`），`defaultModel` 兜底、`aliases` 别名归一，`codex.imageModel`/`codex.carrierModel` 覆盖 Codex 私有线路模型（默认钉现常量）。旧配置的 `provider`/`modelAliases` 在读取时容忍迁移为等价路由表，不重写用户文件；管理 API 写入执行严格校验（路由目标必须是注册 provider，`defaultModel`/别名目标必须在表内）。

完整配置由 [`imagesServerConfig.ts`](../packages/core/src/outbound-api/imagesServerConfig.ts) 定义并验证，主要分段包括：

- `models`/`defaultModel`/`aliases`/`codex`：路由与 Codex 线路覆盖；
- `account`：账号、分组和 strict/pool 回退；
- `queue`：并发、等待数量和超时；
- `temporary`：请求级临时资源预算；
- `limits`：HTTP、文件、像素、输出和远程读取限制；
- `references`：artifact、状态、TTL、容量和可选存储根；
- `remote`：远程 URL 解析开关；
- `evidenceTtlMs`：能力证据逻辑 TTL。

管理 API 对写入执行严格字段和范围校验，daemon 启动读取则采用容错归一化和硬上限钳制。远程读取或自定义存储根还要通过 daemon 层的组合与文件系统验证。

## 11. 稳定错误

图片错误使用固定 code 和安全消息，常见映射如下：

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `invalid_image_request` | 字段、组合、尺寸或引用格式错误 |
| 400 | `unsupported_model` | 非 `gpt-image-2` 或未配置的 alias |
| 401 | `invalid_api_key` | 本地 Omnicross key 无效 |
| 403 | `insufficient_permissions` | Responses key 缺少图片权限 |
| 413 | `image_too_large` | 文件、总请求、像素或输出超限 |
| 415 | `unsupported_image_type` | 图片容器或 MIME 不支持 |
| 422 | `unsupported_capability` | 当前能力证据不支持该选项、mask 或多图 |
| 429 | `upstream_rate_limited` | 上游限流 |
| 429 | `subscription_usage_limit_reached` | 订阅图片额度已用尽 |
| 429 | `image_queue_full` | 本地图片队列已满 |
| 502 | `upstream_protocol_changed` | 上游响应不符合已验证协议 |
| 504 | `image_generation_timeout` | 上游生成超时 |

对外错误不会包含 prompt、图片内容、账号 ID、上游原始错误体或凭证。

## 12. 关键源码

- 公共类型：[`image-generation-types.ts`](../packages/contracts/src/image-generation-types.ts)
- Images API：[`openai-images/`](../packages/core/src/image-generation/openai-images/)
- 统一编排：[`ImageOrchestrator.ts`](../packages/core/src/image-generation/ImageOrchestrator.ts)
- Responses 图片工具：[`responses/`](../packages/core/src/image-generation/responses/)
- Responses mediator：[`nativeResponsesHostedImageMediator.ts`](../packages/core/src/provider-proxy/responses/hosted-image/nativeResponsesHostedImageMediator.ts)
- 订阅 provider：[`CodexSubscriptionImageProvider.ts`](../packages/subscriptions/src/image-generation/CodexSubscriptionImageProvider.ts)
- 上游请求：[`privateWireRequest.ts`](../packages/subscriptions/src/image-generation/privateWireRequest.ts)
- 上游响应：[`privateWireResponse.ts`](../packages/subscriptions/src/image-generation/privateWireResponse.ts)
- live verifier：[`CodexImageLiveVerifier.ts`](../packages/subscriptions/src/image-generation/CodexImageLiveVerifier.ts)
- daemon 装配：[`ImageRuntimeGenerationFactory.ts`](../packages/daemon/src/image-generation/ImageRuntimeGenerationFactory.ts)
- 能力证据：[`FileCodexImageCapabilityEvidenceSource.ts`](../packages/daemon/src/image-generation/FileCodexImageCapabilityEvidenceSource.ts)
- doctor：[`ImageDoctorService.ts`](../packages/daemon/src/image-generation/ImageDoctorService.ts)
- UI：[`ImagesSection.tsx`](../packages/ui/src/features/api-service/ImagesSection.tsx)

## 13. 修改与测试建议

扩展图片能力时，应先修改 provider-neutral capability，再扩展协议适配器，最后更新 live verifier 和持久证据版本。不能只放宽公共解析器，否则请求会在更晚阶段失败；也不能只修改 capability 常量而没有真实上游验证。

常用验证命令：

```powershell
npm test -- packages/core/src/image-generation packages/subscriptions/src/image-generation packages/daemon/src/image-generation
npm run test:images-sdk-contract
npm run typecheck -w @omnicross/core
npm run typecheck -w @omnicross/subscriptions
npm run typecheck -w @omnicross/daemon
```

涉及 Codex 集成时还应覆盖：

- `configAdapters` 生成与恢复；
- key 的 `responses`/`images` 最小权限；
- Codex 内置工具的 generate/edit 两条端点；
- CLI 回退脚本通过 `OPENAI_BASE_URL` 访问 Images API；
- 请求/响应正文和账号标识不会出现在 trace、audit 或错误中。

## 14. 多 provider 运行时（multi-provider-image-generation）

### 14.1 装配与按模型路由

`ImageRuntimeGenerationFactory` 按路由表涉及的 provider 集合逐个装配（各自的 authStrategy、evidence source、scheduler 身份按 `provider:account` 隔离）；请求模型先经 `defaultModel`/`aliases` 归一再查表，表外模型在编排前返回 `unsupported_model`，不做跨 provider 重路由。某 provider 没有登录账号只影响路由到它的模型，不拖垮其它 provider。

### 14.2 Antigravity 图像 wire

`packages/subscriptions/src/image-generation/AntigravitySubscriptionImageProvider.ts` 走 antigravity 身份（同账号 project 握手、401 刷新重试一次），自构非流式 CCA `generateContent`（`responseModalities: ['TEXT','IMAGE']`，`size` 精确约分为 aspectRatio，无精确比例则省略 imageConfig），不走 transformer 链。能力声明 PNG-only、单参考图、无 mask/多图；非 PNG 实际格式按 `upstream_protocol_changed` 暴露。证据默认 `Unknown…` source（entitlement-unknown + protocol-unverified → bootstrap-eligible，同 Codex 先例）。

### 14.3 会话内嵌图 v1

共享 gemini 解析器（`gemini.stream.ts`）保留 `inlineData`：非流式 `message.images`、流式 `delta.images`（data URL 数组，一 chunk 多图合并）；纯文本流量输出字节等价。请求侧 `buildRequestBody` 对 gemini 系 `-image` 模型注入 `responseModalities: ['TEXT','IMAGE']`（未显式携带时）。OpenAI Chat 面透出 images；Anthropic Messages 面诚实丢弃并记有界计数（`anthropicImageDrop.ts`）；Responses 面 `image_generation_call` 输出映射为后续工作。

### 14.4 观测与 doctor

`GET /v1/models` 的图像模型 = 路由键 × 各自 provider 的新鲜能力证据交集（`inspectCapability.routedModels`）：一个 provider 证据失效只从列表里去掉它的模型，不会让整个列表失败。`omnicross doctor images` 的账号检查按 provider 分行（Codex / Antigravity），未路由的 provider 仅提示；live 验证仍只覆盖 Codex 线路，Antigravity 侧无独立 verifier（首次真实请求即 bootstrap）。

### 14.5 验证边界

Antigravity 图像 provider 只有离线证据与单元测试覆盖（信封快照对照 antigravity change 冻结形态、size→aspectRatio 矩阵、错误分类、账号绑定）。在真实订阅上完成实机验证（三模型真实出图、会话内嵌图客户端实测）之前，不宣称线上可用。

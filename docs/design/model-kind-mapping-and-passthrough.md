# Omnicross 中转接口：模型「种」映射 + 客户端模型名透传（调研 / 设计文档）

> 状态：**已实现并本地落地**（branch `feat/model-kind-mapping`，typecheck 0 / vitest 全绿，仅 5 个预存 OAuth 环境测试红；push/PR/合并待 operator）。原调研设计见下文。
> 适用范围：`packages/core` 的 outbound-api-server（对外中转服务）+ `packages/daemon`（admin API）+ `packages/ui`（API Service 设置页）。
> 相关参考实现：`E:/AI/ChatAI/Agents/VibeCodingProjects/elftia/_others/claude-relay-service`

---

## 1. 背景与问题

Omnicross 的对外中转服务（outbound-api-server）为 Claude Code / Codex 等 CLI 提供「原生协议」端点，把 CLI 的请求翻译并转发到用户配置的任意上游 LLM Provider。当前存在两个问题：

### 问题 1：没有「模型名映射」，客户端看到的是上游模型的原名
Claude Code CLI 请求中转端点后，**响应里回传的 `model` 字段是配置的上游 Provider 的原始模型名**（例如 `deepseek-v3`、`glm-4.7`），而不是 `claude-opus-…` / `claude-sonnet-…` / `claude-haiku-…`。这导致 CLI「看到的」不是 Claude 系列模型名。

- 上游模型名进入响应的位置（transform 路径）：
  - Claude Code：`AnthropicResponseConversion.ts:71` → `model: anthropicResponse.model || 'unknown'`
  - Codex：`OpenAIResponseTransformer.ts:390 / 443` → `model: data.model || 'unknown'`
- verbatim 路径（same-format，上游本身是 anthropic 协议）：`relayResponse()` 逐字节转发，`model` 就是上游返回的名字。

### 问题 2：现有映射按「角色」而非「模型种」，且需精确写全名
当前是**按角色**（default / background / vision）配置，每个角色配一个 `providerId,modelId`。参考项目 `claude-relay-service` 的映射则是**按完整模型名精确匹配**（见 §3），两者都无法满足「用户只配 opus/sonnet/haiku/fable 四个模型种、其余靠版本号透传」的诉求。

### 目标
1. 用户只需配置 **fable / opus / sonnet / haiku** 四个「模型种」的映射（Claude Code 端点）。
2. 请求进来时，从客户端发来的模型 id（通常带版本号，如 `claude-opus-4-8-2026xxxx`）中**按 token 提取模型种**（`opus`），路由到该种配置的上游 Provider+模型。
3. **响应里的 `model` 字段透传客户端原始请求的模型名**（`claude-opus-4-8-2026xxxx`），让 CLI 看到 Claude 名（含版本）。
4. CLI 升级后出现新版本 id（`claude-opus-5-…`）**无需重新配置**——`opus` 种不变。
5. **移除「视觉辅助模型」配置**。
6. **Codex 端点同理处理**（详见已定方案）。

---

## 2. 当前架构（已核实，含文件:行号）

### 2.1 服务与四端点
- 独立 HTTP 监听器：`packages/core/src/outbound-api/OutboundApiServer.ts`（默认 `127.0.0.1`，可选 LAN）。
- 四个端点 ↔ 四个入站解析器（`OutboundEndpoint = 'chat' | 'responses' | 'messages' | 'gemini'`）：
  - `messages` = **Claude Code**（Anthropic Messages，`/v1/messages`）
  - `responses` = **Codex**（OpenAI Responses，`.../responses`）
  - `chat` = 通用 OpenAI Chat Completions
  - `gemini` = Gemini CLI（generateContent）

### 2.2 每请求管线
`packages/core/src/outbound-api/outboundApiRouter.ts` → `handleOutboundRequest()`：
1. 鉴权（命名 API key）→ 2. 限流 → 3. 端点选择（`selectEndpoint`）→
4. 读 body、**检测角色**（`detectRequestRole`）、**解析路由**（`resolveRoute`）→
5. 在共享 route map 上铸造 route，委派给 `routeRequest()`（复用入站解析器 + transformer）。

### 2.3 角色检测（将被「模型种检测」取代/并存）
`packages/core/src/outbound-api/roleDetection.ts`：
- 优先级 **vision > background > default**。
- vision：body 里带图片内容（`hasVisionContent`，各协议分支）。
- background：请求模型 id 命中 `backgroundModelIds` 覆盖表，或命中小模型 token（`BACKGROUND_TIER_TOKENS = {haiku, mini, flash, small, lite, nano, 8b}`，token 边界匹配）。
- 其余为 default。

### 2.4 路由解析（选模型 + 定 Provider）
`packages/core/src/outbound-api/routeResolver.ts`：
- `pickModelRefForRole()`：vision→`visionModel`（未配则回退 default）；background→`backgroundModel`；default→`defaultModel`。
- `parseModelRef("providerId,modelId")` → `{providerId, modelId}`。
- BYO vs subscription 门控，最终产出 `RouteContext { model: modelId, … }`。

### 2.5 请求侧「换模型」
- Claude Code：`anthropicMessagesByo.ts:93-95` → `anthropicBody.model = route.model`
- Codex：`openaiResponsesIngress.ts:91-95` → `responsesBody.model = route.model`
- ⚠️ **verbatim（same-format）路径的隐患**：`anthropicMessagesByo.ts` 的 `runSameFormatFetch()` 用 `body: rawBody`（**原始字节**）请求上游 → 上游收到的是**客户端原始模型名**，而非解析后的上游模型。对「上游是第三方 anthropic 协议中转」的场景，这本身就是个潜在不一致（详见 §5.4）。

### 2.6 响应侧（问题根源）
`providerProxyShared.ts:91` `relayResponse()` 是**两条路径共同的唯一出口**：
- 流式：逐 chunk 透传上游字节。
- 非流式：读取文本原样写回。
→ 目前 **不改写 `model`**，故客户端看到上游模型名。

### 2.7 配置结构与持久化
`packages/core/src/outbound-api/types.ts`：
```ts
interface EndpointRoutingConfig {
  endpoint: OutboundEndpoint;
  defaultModel: ModelRef;        // "providerId,modelId"
  backgroundModel: ModelRef;
  visionModel?: ModelRef;        // 待移除
  useSubscription: boolean;
  backgroundModelIds?: string[];
}
```
- 持久化：`apiServerConfig.ts`，settings key = `'outboundApiServer.config'`；`normalizeServerConfig()` / `defaultServerConfig()` / `mergeServerConfig()`。
- Daemon 读写：`admin/adminApi.ts` `handleServer()`（GET/PUT，`mergeServerConfig` 整体替换 endpoints），`handleStatus()` 投影 `model: e.defaultModel`（**line 1712 需改**）。
- UI 编辑器：`packages/ui/src/features/api-service/EndpointRoutingCard.tsx`（三个模型选择器 + backgroundModelIds）。
- UI 侧类型镜像：`packages/ui/src/daemon/types-server.ts`、`daemon/types.ts`；适配器 `serverConfigAdapter.ts`（通用，大概率不动）。

---

## 3. 参考实现 claude-relay-service（已核实）

- 映射存于账户的 `supportedModels`（对象格式 `{ "claude-opus-4-20250514": "…", "opus": "…" }`）。
  - `ccrAccountService.js:597-641`、`claudeConsoleAccountService.js`。
- 匹配逻辑 `getMappedModel()` / `isModelSupported()`：**先精确匹配 key，再大小写不敏感匹配整串**，**没有前缀/家族匹配**。故若 key 写 `opus`，只有客户端**恰好发 `opus`** 才命中；而 CLI 发的是带版本号的 `claude-opus-4-…`，不会命中 → 必须把完整版本名写进映射表。
- 响应侧：`ccrRelayService.js`、`claudeConsoleRelayService.js` **均逐字节转发，不改写 `model`**。

**结论**：参考项目印证了用户的判断——只能整串精确匹配、且响应不透传。我们要做的正是它缺的两点：**按种（token）匹配** + **响应透传原始请求名**。

---

## 4. 已定设计决策

| 议题 | 决策 |
| --- | --- |
| Claude Code(messages) 模型种 | `fable` / `opus` / `sonnet` / `haiku` 四种 |
| Codex(responses) 模型种 | **两档：`codex`（主，匹配 `*-codex` 或 `gpt-*`）+ `mini`（小/后台，匹配 `*-mini`）** |
| 改造范围 | **仅 messages + responses 改为「模型种映射」**；`chat` / `gemini` **维持 default/background 现状，仅删除视觉字段** |
| 视觉辅助模型 | **全局移除**（含类型、配置、UI、i18n、vision 角色/检测） |
| 响应透传 | 响应 `model` 透传客户端**原始请求模型 id**（覆盖 transform + verbatim 两路径）|

---

## 5. 提议方案

### 5.1 配置结构（异构：kind-mapped vs role-based）
`messages` / `responses` 使用 `modelMap`；`chat` / `gemini` 保留 `defaultModel` / `backgroundModel`；`visionModel` 删除。

```ts
export type OutboundEndpoint = 'chat' | 'responses' | 'messages' | 'gemini';

/** 每个「模型种映射」端点的规范种别（SSOT，供检测与 UI 共用）。 */
export const ENDPOINT_MODEL_KINDS = {
  messages: ['fable', 'opus', 'sonnet', 'haiku'],
  responses: ['codex', 'mini'],
} as const;

export interface EndpointRoutingConfig {
  endpoint: OutboundEndpoint;
  /** kind-mapped 端点（messages/responses）：种 → "providerId,modelId"。 */
  modelMap?: Record<string, ModelRef>;
  /** role-based 端点（chat/gemini）保留。 */
  defaultModel?: ModelRef;
  backgroundModel?: ModelRef;
  useSubscription: boolean;
  /** 仍供 chat/gemini 的 background token 检测覆盖使用。 */
  backgroundModelIds?: string[];
}
```
> 备选：把 chat/gemini 也统一成 `modelMap`（种 = `default`/`background`），全端点单一机制、类型更干净。但用户已选「chat/gemini 维持现状」，故本方案保留其 `defaultModel`/`backgroundModel` 字段以最小化改动。评审可翻转。

### 5.2 模型种检测（新增 `kindDetection.ts`）
从客户端请求模型 id 提取「种」，**版本无关**：
- 复用 `normalizeModelId()` + token 切分（沿用 `roleDetection` 的 `/[-._:/\s]+/` + token 边界匹配思路）。
- **messages**：token 命中 `{fable, opus, sonnet, haiku}` 的第一个即为该种。
  - 无命中回退：按优先级选**已配置**的种（`sonnet → opus → haiku → fable`）；全空 → `503`（信息明确：`endpoint 'messages' has no model configured for kind '<k>'`）。
- **responses**：命中 `mini`（或 `BACKGROUND_TIER_TOKENS` 里的小模型 token）→ `mini`；否则 `codex`。`mini` 未配则回退 `codex`；`codex` 未配 → `503`。
- **chat / gemini**：**不走 kind 检测**，沿用现有 `roleDetection`（去掉 vision 分支）。

### 5.3 路由解析改造（`routeResolver.ts` + `outboundApiRouter.ts`）
- kind-mapped 端点：`pickModelRefForKind(config, kind)` 取 `config.modelMap[kind]`。
- role-based 端点：保留 `pickModelRefForRole`（去 vision）。
- **透传关键**：把客户端**原始请求模型 id** 一路带到响应侧。方案：`RouteContext` 增加 `requestedModel?: string`（在 router 侧从解析 body 时取），或在 ingress handler 本地捕获（handler 在 `body.model = route.model` 之前就有原始值）。推荐**在 ingress handler 本地捕获**，无需扩 RouteContext。

### 5.4 请求侧
- kind-mapped：`body.model = route.model`（解析后的上游模型），同现状。
- ⚠️ **修 verbatim 潜在不一致（§2.5）**：`anthropicMessagesByo.ts` 的 same-format 路径应把 body 的 `model` 改写为解析后的上游模型后再转发（重新序列化，而非原样 `rawBody`），否则第三方 anthropic 协议上游会收到客户端的 `claude-opus-…` 而非映射目标。**注意**：此路径同时承载「上游就是真 Anthropic、就该发 claude 名」的场景——需谨慎：仅在 route 有明确映射目标模型时改写。评审确认。

### 5.5 响应侧透传（核心，单一出口 `relayResponse`）
给 `relayResponse()` 增加可选 `rewriteModel?: string`；两 ingress 传入捕获到的原始请求模型：
- **非流式 JSON**：解析 → 置顶层 `model`（Anthropic）/ `response.model`（Responses）→ 重序列化。
- **流式 SSE**：轻量逐行扫描，仅改写首个携带 model 的事件：
  - Anthropic：`event: message_start` 的 `data.message.model`。
  - Responses：`response.created` / `response.in_progress` / `response.completed` 的 `data.response.model`。
  - 实现要点：只替换 `model` 字段值、不破坏分块边界（按 SSE 行解析、保留原样透传其余）；一旦改写过即进入「直通」以降低开销。
- 覆盖 transform 路径与 verbatim 路径（都经 `relayResponse`）。
- chat/gemini：本次不接透传（保持现状），但 `relayResponse` 的新参数是可选的、零回归。

### 5.6 视觉移除清单
- `types.ts`：删 `visionModel`；`RequestRole` 去掉 `'vision'`。
- `roleDetection.ts`：删 `hasVisionContent` 及各协议 vision 检测、vision 分支（保留 background/default 供 chat/gemini）。
- `routeResolver.ts`：`pickModelRefForRole` 去 vision 回退。
- `apiServerConfig.ts`：`defaultEndpointConfig` / `normalizeServerConfig` / `mergeServerConfig` 去 vision，加 `modelMap`。
- UI `EndpointRoutingCard.tsx`：删视觉选择器；messages/responses 渲染「种映射」多选择器，chat/gemini 保留 default/background。
- i18n：删 `apiService.endpoint.visionModel` / `noVisionModel`；新增种标签（`fable/opus/sonnet/haiku/codex/mini`）与端点说明。**波及 en/zh + ~30 语言文件**。

---

## 6. 各端点最终行为

| 端点 | 机制 | 种/角色 | 检测 | 响应透传 |
| --- | --- | --- | --- | --- |
| `messages`（Claude Code）| kind-map | fable/opus/sonnet/haiku | token 提取种 | ✅ 原始请求名 |
| `responses`（Codex）| kind-map | codex/mini | `mini` token→mini，否则 codex | ✅ 原始请求名 |
| `chat` | role（现状）| default/background | 现有 role 检测（去 vision）| ❌（维持现状）|
| `gemini` | role（现状）| default/background | 现有 role 检测（去 vision）| ❌（维持现状）|

---

## 7. 变更文件清单（预估）

**core**
- `outbound-api/types.ts`（schema、RequestRole、kind SSOT）
- `outbound-api/apiServerConfig.ts`（default/normalize/merge + 旧配置迁移）
- `outbound-api/kindDetection.ts`（**新增**）
- `outbound-api/roleDetection.ts`（删 vision）
- `outbound-api/routeResolver.ts`（按种/角色选模型；透传原始模型）
- `outbound-api/outboundApiRouter.ts`（按端点选检测器 + 传原始模型）
- `outbound-api/index.ts`（导出）
- `provider-proxy/ingress/anthropicMessagesByo.ts`（捕获原始模型、传 rewriteModel、verbatim body 修正）
- `provider-proxy/ingress/openaiResponsesIngress.ts`（同上）
- `provider-proxy/ingress/providerProxyShared.ts`（`relayResponse` 增 `rewriteModel`：JSON + SSE 改写）

**daemon**
- `admin/adminApi.ts`（`handleStatus` 的 `model: e.defaultModel` 投影改为对 modelMap 端点做汇总；`handleServer` 通用不动）

**ui**
- `features/api-service/EndpointRoutingCard.tsx`（种映射编辑器 + 删视觉）
- `features/api-service/hooks/useApiService.ts`（模型选项/校验，视需要）
- `daemon/types-server.ts`、`daemon/types.ts`（类型镜像）
- `daemon/serverConfigAdapter.ts`（复核，多半不改）
- `i18n/en.json`、`i18n/zh.json` +（约 30 个语言文件）

**tests**
- `outbound-api/__tests__/roleDetection.test.ts`（改：删 vision）
- `outbound-api/__tests__/kindDetection.test.ts`（**新增**）
- `outbound-api/__tests__/routeResolver*.test.ts`、`outboundApiRouter.test.ts`、`OutboundApiServer.test.ts`（适配）
- 新增：`relayResponse` 的 model 改写（JSON + SSE，两协议）单测

---

## 8. 待评审的开放点 / 风险

1. **旧配置迁移**：`normalizeServerConfig` 需把已持久化的 `{defaultModel, backgroundModel, visionModel}` 迁到新结构。messages 建议 `defaultModel→sonnet`、`backgroundModel→haiku`（opus/fable 留空）；responses 建议 `defaultModel→codex`、`backgroundModel→mini`；vision 丢弃。是否要迁移、还是清空让用户重配？（dev 阶段清空亦可）
2. **未配置种的回退策略**（§5.2）：回退到已配置种 vs 直接 `503`。影响「haiku 槽空时 Claude Code 后台探针」的体验。
3. **SSE 改写健壮性**：必须只改 `model` 值、不破坏分块与事件边界；需覆盖两协议的多种事件形态。计划加针对性单测。
4. **verbatim 请求 body 模型改写**（§5.4）：修正潜在不一致时，勿误伤「真 Anthropic 上游本就该收 claude 名」的场景——需以「route 是否有明确映射目标」为条件。
5. **i18n 覆盖面**：~32 语言文件；缺失键回退 en。
6. **响应 `model` 与用量记账**：`recordAnthropicNonStreamUsage` / `recordResponsesNonStreamUsage` 目前用 `plan.resolvedModel`（上游真实模型）记账——**应保持用上游模型记账**，仅对外响应透传；两者不要混淆。

---

## 9. 建议实施顺序（获批后）
1. core 契约与检测（types / kindDetection / roleDetection 去 vision / apiServerConfig）。
2. 路由与透传（routeResolver / outboundApiRouter / 两 ingress / relayResponse）。
3. daemon status 投影。
4. UI 编辑器 + i18n。
5. 单测/集测；`vitest` 全绿；`typecheck`。
6. 手工端到端：Claude Code 指向 messages 端点验证种路由 + 响应显示 claude 名；Codex 指向 responses 端点验证 codex/mini + 透传。

---

## 10. 升级 / 破坏性变更提示（RELEASE NOTE）

> **BREAKING（按既定决策"不做迁移"）**：本次将 outbound-api-server 的每端点配置从"角色制（default/background/vision）"改为"模型种制"。**不做旧配置迁移**——升级后 `messages`/`responses` 端点的旧 `defaultModel`/`backgroundModel` 会被丢弃、`visionModel` 移除，`modelMap` 从空开始。

对已有运营者的影响：
- 升级后若 outbound server 处于启用态，但 `messages`（fable/opus/sonnet/haiku）或 `responses`（codex/mini）的模型种映射未配置完整，**服务器会拒绝绑定该端口**（daemon boot 侧被 try/catch 兜住，非致命——其余 daemon 正常启动，仅 outbound 不绑定），并在 admin UI 顶部提示"接口服务无法启动：缺少模型映射配置"。
- 运营者需在 admin 面板重新为这两个端点各模型种选择 `providerId,modelId`，保存后服务器方可绑定。
- `chat`/`gemini` 端点仍为 default/background（仅移除了 vision 字段），不受种制影响。

## 11. 落地实现摘要（与设计的差异）

- **模型种检测**：`outbound-api/kindDetection.ts`（新增，纯函数）。token 边界匹配（非子串）；`gpt-5-codex-mini`→`mini`（mini 优先），`:tag`/publisher 前缀/`[1m]` 经 `normalizeModelId` 归一。
- **透传**：`RouteContext.requestedModel`（仅 outbound `resolveRoute` 对种制端点打戳；resident-proxy 内部流量不打戳 → 字节不变）。`relayResponse(res, resp, isStream, rewriteModel?)` 改写响应 `model`：非流 JSON + 流式 SSE **每一个**携带 model 的事件（Anthropic `message_start.message.model`；Responses `response.{created,in_progress,completed,failed,incomplete}.model`），跨 chunk 装行、末行 flush、framing 字节不变；`rewriteModel` 缺省时字节等价。用量记账仍用上游真实模型。
- **启动闸门**：`validateServerModelConfig`（core，纯函数）；`OutboundApiServer.applyConfig` 在启用且不完整时 `stop()` 后 `throw OutboundApiConfigError`（既拒绝绑定、也拆掉已绑定的旧监听）；daemon `start.ts` boot try/catch 非致命；admin `handleServer` PUT 预校验 → 200 `{server, error:{code:'incomplete-model-config', missing}}` 且在运行中转为不完整时 `stop()`。
- **verbatim 修正**：same-format 路径仅当 `resolvedModel !== 客户端原始 model` 时按解析模型重序列化 body，否则原样透传（保留 server-tool `type`）。
- **UI**：`EndpointRoutingCard` 对 messages/responses 渲染每模型种一个选择器（`endpointKinds.ts` 本地镜像 `ENDPOINT_MODEL_KINDS`，因 `@omnicross/ui` 无 core 运行时依赖——已加同步注释 + 钉住测试）；chat/gemini 保留 default/background；视觉选择器移除。i18n 31 语言：删 `visionModel`/`noVisionModel`，加 `kind.*`/`kindMapLabel`/`cannotStart`/`missingKind`（en/zh/ja 全译，其余英文回退）。
- **已知约定限制**（非缺陷）：UI 侧 `ENDPOINT_MODEL_KINDS` 镜像无法自动感知 core 侧"新增模型种"（ui 无 core 依赖）；已加注释 + 钉测，新增种时需手工同步 UI 镜像。

> 三层拆分（core → serving ∥ surface）经 opsx auto-decompose 编排：契约层 → 服务层 ∥ 界面层；author≠verifier 全程严格；3 轮 review-cycle 清零 Blocker/Major。

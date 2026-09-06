# Omnicross Google CCA 订阅 Provider 需求（google-antigravity 立项 + google-gemini-cli 补全）

> 状态：立项评估文档（未实施）。依据 `omnicross-oh-my-pi-provider-research.md` §2.6/§6 与
> 参考实现源码（调研对象 `packages/ai/src/{providers,registry/oauth,usage}` + `packages/catalog/src/{wire,discovery}`）。
> 本文档回答调研遗留的开放问题「omnicross 现有 gemini OAuth 走的是哪条 wire」，并给出两档实施切分。

## 1. 摘要

Google 侧存在两条共享同一私有 wire（Cloud Code Assist，下称 **CCA**）的订阅路径：

| 路径 | 价值 | omnicross 现状 | 建议切分 |
| --- | --- | --- | --- |
| **google-gemini-cli** | 免费档即用，Gemini 2.5~3.1 全系（1M ctx） | **主体已存在**：现有 `gemini` 订阅 provider 就是它（同 client `681255809395-…`、同 CCA wire、同 project 握手），缺 quota 采集与客户端伪装头 | **P0 小 change**（预计 ≤400 行） |
| **google-antigravity** | 一个 Google 账号同时解锁 Claude Opus/Sonnet 4.x + Gemini 2.5~3.8 + gpt-oss-120b（19 静态模型 + 动态发现）；quota 是全家最富（rolling 5h + weekly 双桶，按 Google/Anthropic/OpenAI 计数器族拆分） | 无。需独立 OAuth client、双端点、完整客户端伪装、两条模型路由 | **P1 独立大 change**（预计 ~3000 行级，迄今最大单 provider） |

**关键发现（回答调研 §2.6 开放问题）**：omnicross 的 `gemini` 订阅 provider 已经骑在 CCA wire 上——
`GeminiCodeAssistTransformer`（CAGenerateContentRequest 信封 + `v1internal:streamGenerateContent?alt=sse`
URL + `.response` 剥壳）与 `GeminiCodeAssistProjectResolver`（`:loadCodeAssist`/`:onboardUser`/LRO 握手 +
free-tier `project=undefined` 语义 + `GOOGLE_CLOUD_PROJECT` 种子）与参考实现同源。因此 antigravity 的
CCA 编解码**不是从零开始**：信封骨架可参数化复用，antigravity 特有部分是外层路由与伪装。

## 2. 背景与现状

### 2.1 已有能力（可直接复用）

- **CCA 信封层**：`packages/core/src/transformer/transformers/GeminiCodeAssistTransformer.ts`（293 行）——
  `model`/`project`/`user_prompt_id` 顶层 + 标准 generateContent 体嵌套于 `request`；版本段冒号方法 URL；
  SSE `data:` 逐 chunk 剥 `.response`。antigravity 的差异是外层字段（见 §4.3），内层一致。
- **project 握手**：`packages/core/src/auth/GeminiCodeAssistProjectResolver.ts`（284 行），含 LRO 轮询与
  硬失败不缓存语义。
- **gemini OAuth**：`packages/subscriptions/src/oauth/flows/gemini.ts` 用的就是 gemini-cli 公开 client
  `681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j`（scope `cloud-platform`）。
- **订阅 provider 框架**：OAuthBearerAuthStrategy、JsonSubscriptionCredentialStore、TokenRefreshScheduler、
  多账号调度、allowance 框架（Claude/Codex/Copilot/Grok/Kimi/OpenCodeGo 六个 collector 先例）、
  CLI `omnicross login` + admin 设备码端点 + UI 卡片全链（调研 §1 触点清单，四轮落地已跑熟）。

### 2.2 当前缺口

gemini（= google-gemini-cli 主体）：
- 无 GeminiAllowanceCollector——`v1internal:retrieveUserQuota`（按模型桶 `remainingFraction(0-1)` +
  `resetTime` + `currentTier` free/legacy/standard）未接。
- 不发 `User-Agent: GeminiCLI/<ver>` + `Client-Metadata: ideType=…,pluginType=GEMINI` 伪装头
  （参考实现用它解锁更高限额）。
- 登录走 OOB code-paste（`urn:ietf:wg:oauth:2.0:oob`）+ PKCE；参考实现是 loopback
  `127.0.0.1:8085/oauth2callback` + 粘贴兜底。现状可用，是否对齐属体验优化（见 §7）。

antigravity：全部缺失（§4）。

## 3. 目标与非目标

### 3.1 目标

- **G1（P0）**：gemini 订阅账号获得 quota 面板（retrieveUserQuota → allowance 窗口）+ GeminiCLI 伪装头。
- **G2（P1）**：新增订阅 provider `antigravity`：Google 账号登录后，Claude/Gemini/gpt-oss 三族模型
  对 Claude Code / Codex CLI 客户端可路由可用，quota 双桶入 allowance 调度。
- **G3**：与现有四轮 provider 相同的完整链路（CLI 登录、admin OAuth、UI 卡片、31 locale、多账号、
  allowance 调度白名单）。

### 3.2 非目标

- 不做 Antigravity 的 IDE/agent 产品功能（plan 文件、checkpoints 等）——只取模型推理通道。
- 不做 gRPC 路径——CCA 是 REST+SSE。
- 不承诺 sandbox 端点语义完全复刻（v1 只做生产端点 + failover 开关，见 §7）。
- 不做 Vertex（`gemini-vertex` BYO 预设已覆盖 API-key 面）。

## 4. antigravity 协议基线（冻结自参考实现）

### 4.1 OAuth（authorization-code + client_secret，无 PKCE）

- client：`1071006060591-tmhsin2h21lcre235vtolojoh4g403ep.apps.googleusercontent.com`
  （secret 随参考实现 KDL base64 内置，公开分发）。
- authorize `https://accounts.google.com/o/oauth2/v2/auth`，`access_type=offline` + `prompt=consent`；
  scopes：`cloud-platform` + `userinfo.email` + `userinfo.profile` + `cclog` + `experimentsandconfigs`。
- 回调 loopback `127.0.0.1:51121/oauth-callback`（端口与 codex 1455/gemini-cli 8085 一样是客户端固定约定）。
- token `https://oauth2.googleapis.com/token`（form）；userinfo `oauth2/v1/userinfo` 取 email 作 accountId。
- 刷新后须重跑 project 握手 hook（projectId 是刷新产物的一部分）。

### 4.2 端点与伪装

- 推理端点：`https://daily-cloudcode-pa.googleapis.com`（注意是 **daily-** 前缀，非 gemini-cli 的
  `cloudcode-pa`）；failover `https://daily-cloudcode-pa.sandbox.googleapis.com`。
- UA：`antigravity/hub/<version> (aidev_client; os_type=darwin; arch=arm64; cl=963137146)`。
  **后端按版本 gate 新模型**：版本从官方 electron-builder 更新 manifest 在线热探测
  （`antigravity-hub-auto-updater-…run.app/manifest/latest-arm64-mac.yml`，5s 超时，进程内缓存，
  失败回落钉死的 2.8.0）；os/arch 钉参考客户端值（与宿主平台无关）；`cl` 后端不校验。
  env 逃生舱 `ANTIGRAVITY_VERSION/_CL/_OS/_ARCH`。
- 信封外层：`requestId`/`sessionId` + `labels.model_enum`（不透明遥测 token，Anthropic 系 id 可省）。

### 4.3 两条模型路由（关键工程量）

同一 CCA 信封内按后端族分两套参数化：

- **Gemini 路由**：effort 变体模型 id（如 `gemini-3.5-flash-low` ↔ `-extra-low` ↔ 基础 id）——
  逻辑模型→wire 变体的路由映射；`generationConfig.maxOutputTokens` 按 per-wire-id profile 钉死
  （Claude 系上限 64000，Gemini 系 65535/65536）；**forced-tool 指令注入**（一段提示词资产，改变
  工具调用行为的保真要求）；VALIDATED 工具模式。
- **Claude 路由**：`anthropic-beta` 头集 + legacy parameters schema；无 model_enum label；
  thinking 变体（`claude-opus-4-6-thinking`）是独立 wire id。
- gpt-oss 路由同 Gemini 形态（OpenAI 计数器族仅影响 quota 拆分）。

### 4.4 quota（与 omnicross allowance 同构度最高）

- 主：`v1internal:retrieveUserQuotaSummary` → rolling **5h + weekly 双桶**，按计数器族
  （Google/Anthropic/OpenAI）拆分，字段 `remainingFraction`/`remainingAmount`/`disabled`/`resetTime`。
  → 直接映射 `thirty-day`/`weekly` 之外的 `five-hour` + `weekly` 窗口语义。
- 回退：`v1internal:fetchAvailableModels` 每模型 `quotaInfo`（daily/weekly）。
- 模型目录：19 静态 + `fetchAvailableModels` 动态发现（denylist：`chat_20706`、`chat_23310`、
  `gemini-2.5-pro`）；displayName/supportsImages/supportsThinking/thinkingBudget/maxTokens 元数据可入
  canonical 注册表。

## 5. 实施切分

### 5.1 P0：gemini quota 补全（先行，小）——**已完成（2026-09-07）**

1. ~~`GeminiAllowanceCollector`~~ ✅ `retrieveUserQuota` 归一（buckets → 按模型 model-family 窗，
   remainingFraction → 百分比、resetTime → resetsAt、去重钳位）；复用共享
   `GeminiCodeAssistProjectResolver`（与推理路径同实例，握手失败降级为无 project 探测）。
2. ~~伪装头~~ ✅ `GeminiCodeAssistTransformer` 注入 `GeminiCLI/<ver>` UA + `Client-Metadata`
   （`GEMINI_CLI_VERSION` env 逃生舱），admin refresh 路由 + UI 卡片刷新接线同轮完成。
3. ~~allowance 调度白名单放行~~ ——**按设计不适用**：调度器的 worst-window 规则针对账号级 5h/周窗，
   gemini 是按模型分桶的 fraction，硬套会误杀（`AccountAllowanceScheduling` 注释已有此结论）；
   gemini 配额保持 display-only，antigravity 若做（quotaSummary 是账号级双桶）再评估放行。

### 5.2 P1：antigravity 独立 provider（主体立项）

按调研 §1 触点清单，新增量集中在：

| 模块 | 内容 | 估算 |
| --- | --- | --- |
| OAuth flow | 授权码 + loopback 51121 + 刷新后 project hook（loopback 基建已有 codex 先例） | ~300 行 |
| 编码/transformer | CCA 信封参数化复用 + 双路由（effort 变体、wire profiles、forced-tool 注入、anthropic-beta/legacy schema、VALIDATED 模式） | ~800–1200 行 |
| 端点层 | daily-cloudcode-pa + sandbox failover、UA 版本热探测 | ~150 行 |
| quota collector | quotaSummary 双桶 + fetchAvailableModels 回退 | ~250 行 |
| 模型目录 | canonical 注册（19 静态 + 变体）+ 动态发现 | ~200 行 |
| 接线 | registry/auth/store/refresh/调度/CLI/admin/UI/i18n×31 | ~400 行 |
| 测试 | 参照四轮先例（flow/transformer/collector/接线四层） | ~800 行 |

合计 ~3000 行级，约为 grok/copilot 单家的 1.5–2 倍；**必须独立 change，不可与 P0 混合**。

### 5.3 顺序建议

P0 先行（半天级，独立可发）；P1 立项后按「OAuth+目录+单路由（Gemini）→ Claude 路由 → quota+调度 →
接线+动态发现」四步走，每步全量测试通过再进下一步（沿用四轮落地的节奏）。

## 6. 验收标准（P1 草案）

- AC-1 登录：`omnicross login antigravity` + admin UI 设备码路径均落盘加密凭据（email accountId、
  projectId、刷新后 hook 重跑）。
- AC-2 路由：Claude 系模型对 anthropic-messages 客户端同格式可用；Gemini/gpt-oss 系对
  openai 面可用；effort/thinking 变体映射正确（canonical thinkingLevels 驱动，零 per-provider 分支）。
- AC-3 quota：5h+weekly 双桶入 allowance 快照，worst-window 调度生效；`disabled` 桶阻塞对应族模型。
- AC-4 伪装：UA 版本探测失败回落钉死值不阻塞登录；`labels`/requestId/sessionId 信封齐全
  （对照参考实现抓包断言）。
- AC-5 维护性：版本/env 逃生舱、denylist、静态+动态目录冲突时静态优先并记录。
- AC-6 全链：多账号、UI 卡片、31 locale、全量测试 + build + typecheck 干净。

## 7. 开放问题（立项评审拍板）

1. sandbox failover v1 是否做（参考实现有 production→sandbox 切换；也可先只留开关默认关）。
2. gemini 登录 UX 是否对齐参考实现的 loopback 8085（现状 OOB 可用，属优化）。
3. forced-tool 注入的提示词资产是否随上游版本漂移需要 pin 策略（维护负担评估）。
4. antigravity 与 gemini 的 UI 关系：独立卡片（推荐，凭据域不同）还是同卡片双档。
5. Google 风控对中继形态流量（多客户端共享 UA/无 IDE 行为特征）的容忍度——参考实现已在生产验证，
   但 omnicross 流量画像可能不同；首次实机验证时需准备降级路径（伪装头全开仍异常即停）。

# oh-my-pi Provider 全量调研：可集成进 omnicross 的评估

- 日期：2026-09-05
- 调研对象：`E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\_others\oh-my-pi`（下文相对路径均以此为根；TypeScript+Bun monorepo，LLM 接入层在 `packages/ai`，登录规则声明源在 `packages/catalog/src/compat/rules/auth/*.kdl`，共 81 个 KDL、~85 个登录入口）
- 对照仓库：omnicross（本仓库）
- 方法：16 个并行 agent 源码精读 + 3 个独立核查 agent 对全部结论做源码级事实校验（两轮合计 ~400 项抽核，仅少量模型清单类修正，已全部采纳）。纯静态调研，未发起任何网络请求。

## 0. 执行摘要

oh-my-pi 的"登录"分三个层次，不要被 `registry/oauth/` 目录名误导：

1. **真 OAuth/设备码订阅账号**（约 20 个）：anthropic、openai-codex、google-gemini-cli、google-antigravity、kimi-code、xai-oauth、zai-coding-plan、github-copilot、gitlab-duo(-agent)、cursor、devin、openrouter、kilo、perplexity、xiaomi（token-plan 变体）、alibaba-token-plan 等。
2. **API-key 粘贴型订阅**（约 50 个 KDL）：zhipu-coding-plan、minimax-code、cline-pass、opencode-go/zen、umans、synthetic、coreweave、moonshot 等——"登录"只是打开控制台页 + 粘 key + 一次真实请求校验。
3. **纯 API-key/传输层**：azure、bedrock、vertex、ollama 本地等，与账号订阅无关。

核心发现：

- **Z.AI 的"登录"产物就是一把普通 API key。** OAuth 授权码流程（无 PKCE，`chat.z.ai` 授权 → `zcode.z.ai` 换短时 token → 4 步 biz API 铸 key）最终铸造出 `<apiKey>.<secretKey>`（49 字符，与 dashboard 手建 key 同构）。omnicross 现有 `zhipu`/`zhipu-bigmodel` 预设消费的就是同形 key，**推理路径零新增**。
- **Z.AI 额度接口用同一把 key 即可查（裸 Authorization，无 Bearer 前缀）**：`GET https://api.z.ai/api/monitor/usage/quota/limit` 一次返回 5h + 周双窗口的 credits/requests/tokens 用量、百分比、重置时间、套餐档位（lite/pro/max）。这意味着 omnicross **不需要先做 OAuth 就能给现有 zhipu key 加上 5h/周限额显示**——这是全部调研中性价比最高的一项。
- oh-my-pi 有 19 个账号级用量适配器（`packages/ai/src/usage/`），其中与 omnicross 现有 allowance（5h/周窗口 + 百分比 + resetsAt）**同构**的：zai、kimi、alibaba-token-plan、google-antigravity、devin、cline-pass、opencode-go、umans、xai-oauth、openai-codex。allowance 适配器可以批量复用 `AccountAllowanceStore` 的快照模型。
- 对 omnicross 已有三家（claude/codex/gemini），oh-my-pi 提供了多处可直接借鉴的修正与增强（见 §3），其中 **Anthropic 周限额字段已迁移（旧 `seven_day_opus/sonnet` 自 2026-07 起永久 null，须改读 `limits[].kind=weekly_scoped`）** 是现网正确性问题。
- 集成的主要难点不在 OAuth 本身（多为标准 PKCE/设备码/loopback），而在：native scheme 回调（Z.AI loopback 被服务端封死，仅认 `zcode://`）、私有额度接口无契约、客户端指纹依赖（Claude Code 指纹链、Kimi X-Msh-\* 头、Cursor/Devin 的 Connect+proto 私有协议）。

### 集成优先级建议

| 优先级 | 事项 | 理由 |
| --- | --- | --- |
| P0 | 用现有 zhipu key 接 Z.AI quota/limit 额度显示 | 无需登录流，同 key 即查，5h/周窗口与现有 allowance 同构 |
| P0 | Codex 主动轮询 `/backend-api/wham/usage`；Claude 改读 `weekly_scoped` + `anthropic-ratelimit-unified-*` 响应头 | 修正现网行为，抄 oh-my-pi 现成实现 |
| P1 | Kimi Code（device-code OAuth + 5h/7d 用量）；MiniMax Token Plan（preset + usage）；Z.AI OAuth 登录流（自动铸 key，手动粘贴 code 兜底） | 三家均为 CN 友好订阅，接入模式 omnicross 已有全部基建 |
| P2 | google-antigravity、google-gemini-cli、xAI SuperGrok、GitHub Copilot（三家 device-code 一类）；cline-pass / opencode-go(+zen) / umans / synthetic 的 preset+usage；alibaba-token-plan（接受 Cookie 运维） | 价值明确、成本中等；antigravity 一个账号解锁 Claude+Gemini+GPT-OSS |
| P3 | Cursor、Devin（Connect+proto 私有协议）、GitLab Duo agent（WS 私有协议）、Perplexity 订阅搜索 | 协议工程量大或语义与网关中继冲突，除非有明确需求 |

## 1. omnicross 侧：新增一个订阅 Provider 的接触点清单

以 `packages/subscriptions/src/oauth/flows/codex.ts` 为模板（三个纯函数：`generateAuthParams` / `exchangeCodeForTokens` / `refreshAccessToken`，网络一律走 `oauth/fetchPort.ts` 的 `postForm`/`postJson`），需要动的位置：

| 接触点 | 文件 | 动作 |
| --- | --- | --- |
| flow 模块 | `packages/subscriptions/src/oauth/flows/<new>.ts` | 新建（OAuth 型）；纯 api-key 型可走 `StaticBearerAuthStrategy` 先例（opencodego） |
| barrel | `packages/subscriptions/src/oauth/index.ts` | 加一行 export |
| 类型 | `packages/contracts/src/subscription-types.ts` | `SubscriptionProviderId` 联合加 id |
| 存储 | `packages/contracts/src/account-tokens-types.ts` | 新 TokenConfig + `AccountTokensConfig` 顶层镜像块/账号数组/activeId |
| store | `packages/daemon/src/ports/JsonSubscriptionCredentialStore.ts` | `refresh<New>Token()` + by-id 分支（read-merge 写回 + SecretBox） |
| AuthStrategy | `packages/subscriptions/src/auth/OAuthBearerAuthStrategy.ts` | OAuthProviderKey union 扩表（或新策略类） |
| 注册 | `packages/subscriptions/src/SubscriptionAccountService.ts`、`SubscriptionProviderRegistry.ts` | DISPLAY_NAMES、strategies、dispatch profile（upstream URL + transformer 链） |
| 调度 | `packages/subscriptions/src/scheduler/accountSelection.ts` | ACCOUNTS_KEY/ACTIVE_KEY 各加一行 |
| CLI 登录 | `packages/daemon/src/commands/login.ts` | PROVIDERS + login 分支（loopback 用 `awaitLoopbackCode`，粘贴用 `promptPaste`） |
| 桌面 UI 登录 | `packages/daemon/src/admin/accountsOAuth.ts` | code-paste 型进 `OAUTH_HTTP_PROVIDERS` 即得二阶段接口；loopback 型仿 `accountsCodexOAuth.ts` |
| 后台刷新 | `packages/daemon/src/TokenRefreshScheduler.ts` | OAUTH_PROVIDERS 元组加 id |
| 路由/目录 | `packages/core/src/outbound-api/subscriptionSupport.ts`、`packages/contracts/src/subscription-model-catalog.ts` | 静态目录与模型 catalog 各加 id |
| 额度（可选） | `packages/core/src/pipeline/AccountAllowanceScheduling.ts`（provider 白名单）、`daemon/allowance/*`（主动 Collector）、`admin/accountAllowanceApi.ts` + UI `AccountAllowance.tsx`（supportsAllowance） | 三处白名单/开关都要放行，否则默认 'provider-unsupported' |

无需改动：调度器/健康表/断路器/RefreshMutex/会话亲和对全部 provider 通用；`setSubscriptionProviderRegistry` 自动把 registry 镜像进 core outbound slot。

opencodego 是"非 OAuth、静态凭据订阅 provider"的现成先例（StaticBearerAuthStrategy + manual authMethod），也是 dispatch profile 扩展能力的天花板示范（modelMapper/per-model URL/按 wire shape 选 transformer/断路器）——凡是"一把 key + 多模型多 wire 上游"形态（cline-pass、umans、synthetic、kilo 等）都可逐条照抄。

## 2. Provider 详细评估

每节：登录方式 → 推理接入 → 额度 API → 集成判定。证据文件以 `omp:` 前缀缩写（相对 oh-my-pi 根）。

### 2.1 Z.AI / GLM Coding Plan（zai-coding-plan → store-as "zai"）——本调研首选目标

**登录**（真 OAuth 授权码，无 PKCE；`omp:packages/catalog/src/compat/rules/auth/zai-coding-plan.kdl`、`omp:packages/ai/src/registry/oauth/zai.ts`）：

1. authorize `https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg&response_type=code&redirect_uri=zcode://zai-auth/callback&state=<hex>`（无 PKCE、无 scope）
2. token `POST https://zcode.z.ai/api/v1/oauth/token`，JSON body `{provider:"zai", code, redirect_uri, state}` → envelope `{code:0, data:{zai:{access_token}, user:{email,id}}}`
3. biz login `POST https://api.z.ai/api/auth/z/login {token}` → biz token（1h，不落盘）
4. `GET /api/biz/customer/getCustomerInfo` 取默认 org/project
5. `GET+POST /api/biz/v1/organization/<org>/projects/<proj>/api_keys` 找/建名为 `oh-my-pi` 的 key
6. `GET .../api_keys/copy/<apiKey>` 取全量 secretKey（列表值是掩码）→ 最终 `access = apiKey.secretKey`（49 字符持久 key），expires=never，无 refresh

**回调难点**：Z.AI 服务端 allowlist 拒绝该 client 的一切 loopback redirect_uri，仅认 `zcode://zai-auth/callback`（#10745）。oh-my-pi 用 napi 原生模块临时注册桌面 scheme、失败降级为**手动粘贴 redirect URL / code**。omnicross 无 Rust native 依赖必要——直接做粘贴兜底即可（oh-my-pi 同样保留此路径）。

**推理**：双 wire 按模型路由，默认 anthropic-messages `https://api.z.ai/api/anthropic`（Claude Code 中继零转换）；glm-5.3-flash 走 openai-chat `https://api.z.ai/api/coding/paas/v4`。**必须走 coding 端点**——PAYG `/api/paas/v4` 会 bypass plan quota 或 401。目录 16 个 glm 模型，GLM-5.2/5.3/5.3-flash 钉 1M context（`omp:packages/catalog/src/compat/rules/classes/glm.kdl:67-74`）。

**额度**（`omp:packages/ai/src/usage/zai.ts`；**oauth 或粘贴的 key 都能查，裸 Authorization 无 Bearer 前缀**）：

- `GET https://api.z.ai/api/monitor/usage/quota/limit` → `{success, data:{limits[], level}}`
  - `limits[]` 项：`type`（TIME_LIMIT=requests / TOKENS_LIMIT=tokens / CREDIT_LIMIT=credits）、`usage`=上限、`currentValue`=已用、`percentage`（服务端取整，宜自算）、`remaining`、`nextResetTime`（秒/毫秒双兼容）、`unit`（3=小时/4=天/5=月/6=周）、`number`（窗口数，如 5h 的 5）、`usageDetails[]`（modelCode+usage）
  - `level` = 套餐档位 lite/pro/max；GLM Coding Plan 典型形态 12k credits/5h + 60k credits/周
  - Zread 功能配额识别：usageDetails 同时含 search-prime/web-reader/zread 三码
- `GET /api/monitor/usage/model-usage?startTime=...&endTime=...`（近 7 天按模型，格式 `YYYY-MM-DD+HH:mm:ss`）
- oh-my-pi 调度默认 primary=5h、secondary=周窗——与 omnicross allowance 完全同构

**判定：高价值、低成本。** 分两步走：P0 只做 quota 适配器（现有 zhipu key 直接可用，注意把 zhipu 预设 base 从 PAYG 切到 coding 端点后才能正确计量）；P1 做登录流自动化（免 PKCE + 粘贴兜底 + 6 步 mint 链，省去用户去控制台建 key）。风险：biz API 是私有接口无契约（oh-my-pi 留了 `ZAI_*` env 覆盖口）；minted key 的服务端有效期代码未声明。

**姊妹条目**：`zhipu-coding-plan.kdl`（bigmodel.cn 控制台粘 key，validate `https://open.bigmodel.cn/api/coding/paas/v4` + glm-5.1，placeholder `<id>.<secret>`）与 `zai.kdl`（API-key 路径 validate 同上 `api.z.ai/api/coding/paas/v4` + glm-5.2）——佐证国内/海外两侧 `id.secret` key 与 omnicross zhipu 预设同构。

### 2.2 Kimi Code（月之暗面订阅，provider id: kimi-code）

- **登录**：RFC 8628 设备码（`POST https://auth.kimi.com/api/oauth/device_authorization`，client_id `17e5f671-d194-4dfb-9706-5516cb48c098`，无 PKCE/secret/scope；轮询同 host `/api/oauth/token`，`authorization_pending`/`slow_down` 标准语义）。refresh_token 轮换，60s skew 预刷新。
- **指纹**：全套 `X-Msh-*` 设备指纹头（Platform/Version/Device-Name/Device-Model/Os-Version/Device-Id）+ 持久化 `{agentDir}/kimi-device-id`（0600）。缺失时的服务端拒绝行为未在代码中体现（动态发现仅带 2 条头，暗示非全部硬性）——接入前需实测。
- **推理**：同 base 双 wire——openai-chat `https://api.kimi.com/coding/v1/chat/completions` 与 anthropic-messages `https://api.kimi.com/coding/v1/messages`（base 剥 /v1 后拼），按模型 discovery 的 `protocol` 字段分流，缺省 anthropic。Claude Code 中继默认走 anthropic 面最顺。内置目录 7 模型（kimi-for-coding(-highspeed)、k3、k3-256k、kimi-k2、kimi-k2-turbo-preview、kimi-k2.5）+ `/coding/v1/models` 动态发现。wire 细节：MFJS 工具 schema、max_tokens 必带（按 TPM 计）、thinking 模型回放 reasoning_content、K3 仅 effort=max。
- **额度**：`GET https://api.kimi.com/coding/v1/usages`（Bearer OAuth token + 指纹头）→ `{usage, limits[]}`，行级 used/limit/remaining + reset 多键名兼容解析；窗口归一化 300 分钟→"5h"、整天→"Nd"；调度 primary=5h / secondary=7d（与 Anthropic crs 同构）。
- **附加**：同一凭证可调 `POST /coding/v1/search`（Kimi 网页搜索）。
- **判定：高价值、低成本中。** omnicross 需新增：device-code flow（无回调服务器，比 Claude flow 简单）、指纹头模块 + 持久 device id、preset（anthropic 面）、usage 适配器。多账号天然支持。

### 2.3 MiniMax Token Plan（minimax-code 国际 / minimax-code-cn）

- **登录**：无 OAuth。订阅页（platform.minimax.io / platform.minimaxi.com）给 `sk-...` key，粘贴后 `POST {base}/v1/chat/completions`（model=MiniMax-M3, 1-token 探针）校验。
- **推理**：openai-chat `https://api.minimax.io/v1` / `https://api.minimaxi.com/v1`；另有 anthropic 兼容面 `https://api.minimax.io/anthropic`、`https://api.minimaxi.com/anthropic`（普通 minimax/minimax-cn provider 下；与 Token Plan key 是否同一体系代码未说明，需实测——若兼容则 Claude 中继零转换）。M2→M3 共 9 个内置模型（M2.1 的高速版名是 `MiniMax-M2.1-lightning`）。
- **额度**（仅国际站有实现，`omp:packages/ai/src/usage/minimax-code.ts`）：`GET /v1/token_plan/remains`（Bearer 同 key）→ `{base_resp:{status_code}, model_remains:[...]}`。要点：**HTTP 恒 200，`base_resp.status_code===0` 才是成功信号**；每桶双窗（滚动 interval 归一化为 5h/3h + weekly）；剩余是 0-100 百分比（无绝对 token 数），另有请求次数计数；status 枚举 1 正常/2 耗尽/3 无限；全 0 total + 双 status=3 的桶是"模型不在套餐内"占位，须过滤；`"general"` 桶是计划级共享配额（映射到账号级 scope）。
- **判定：高价值、低成本。** preset 两个（intl/cn）+ api-key 登录 + usage 适配器；难度最低的一家（无 OAuth/签名/回调/私有协议），工作量集中在 allowance 的百分比+次数口径适配。

### 2.4 xAI Grok（xai API-key + xai-oauth SuperGrok 设备码）

- **登录**：`xai-oauth` 为 RFC 8628 设备码（client_id `b1a00492-073a-47ea-816f-4c329264a828`，来自 hermes-agent 逆向的 Grok CLI 公共 client，存在被 xAI 撤销的外部风险）；device `POST https://auth.x.ai/oauth2/device/code`，token endpoint 经 OIDC discovery（`https://auth.x.ai/.well-known/openid-configuration`）取得并钉死 `*.x.ai` 域；userinfo `https://auth.x.ai/oauth2/userinfo` 补 email/sub。scopes：`openid profile email offline_access grok-cli:access api:access`。
- **推理**：openai-responses，`https://api.x.ai/v1`，OAuth access token 直接 Bearer（订阅 token 与付费 key 在推理端点上同构）。方言点：加密 reasoning item 重放、reasoning.effort 映射与一批模型必须 omit-effort、拒 reasoning.summary、`x-grok-conv-id` 缓存会话头。
- **额度**：`GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`（注意 billing 域是 grok.com 不是 x.ai；必须带 `X-XAI-Token-Auth: xai-grok-cli` 头；**拒收 API key**，仅 OAuth bearer）→ 周信用 `creditUsagePercent` + `currentPeriod{start,end}` + 按产品 `productUsage`；unified 计费账号回退 `GET /v1/billing`（月度 `monthlyLimit/used/billingPeriodEnd`）。只接受 OAuth 凭证。
- **判定：中。** omnicross 已有 grok.json API-key 预设（openai-chat）；订阅路径增量 = 设备码登录 + responses 方言（若中继透传客户端请求则成本可控）+ billing 适配器（双形态探测 + unified 推断逻辑值得照抄）。设备码 flow 本身是全表最简。

### 2.5 阿里：alibaba-coding-plan / alibaba-token-plan

**coding-plan**（Qwen Coding 套餐）：非 OAuth——交互选区（国际 `https://coding-intl.dashscope.aliyuncs.com/v1` / 中国 `https://coding.dashscope.aliyuncs.com/v1`）+ 粘 key + chat-completions 探针（qwen3.5-plus）。openai-chat wire，内置 12 模型（qwen3.5-3.7 系、qwen3-coder-plus/next、qwen3-max、glm-4.7、glm-5、kimi-k2.5、MiniMax-M2.5——单 key 多家族）。**无任何账号级 usage API**。omnicross 已有 dashscope 预设指向 `compatible-mode/v1`，与 coding-plan 的 `/v1` 路径差异需实测。方言：qwen thinking（顶层 `enable_thinking:false` 关思考、`reasoning_content` 字段、`max_completion_tokens`）。

**token-plan**（QwenCloud Token Plan）：同为粘 key（`sk-sp-...`），但区域互锁（国际/中国 key 不通用，#6682），端点 `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`（中国 cn-beijing），`/models` 动态发现为权威目录（qwen3.8 旗舰 + glm-5.2 + deepseek-v4-pro）。**额度是两个 plan 中唯一有的**：5h + 7d 双窗百分比 + 重置时间（与 allowance 同构），但走阿里云控制台私有网关两步调用（先 session 拿 sec_token——国际 JSON `home.qwencloud.com/tool/user/info.json`、中国从控制台 HTML 正则抠 `SEC_TOKEN`；再 POST `cs-data.qwencloud.com/data/api.json`，需浏览器 UA + CSRF 头 + 用户手动贴的会话 Cookie，失效返回 `ConsoleNeedLogin`）。
**判定：coding-plan 低成本中低价值（额度为零）；token-plan 额度价值高但要接受"Cookie 手动供给 + 会话失效重贴 + 私有接口随时变"的运维现实。**

### 2.6 Google：google-gemini-cli / google-antigravity

两路径共享同一套 CCA wire（自定义 Cloud Code Assist REST+SSE `v1internal:streamGenerateContent`，非 gRPC）与同一 OAuth 形态（Google authorization-code + client_secret、无 PKCE、loopback http、`oauth2.googleapis.com` 刷新），凭据 base64 内置于 KDL（Gemini CLI 公开 client `681255809395-...`；Antigravity 专属 client `1071006060591-...`）。

**gemini-cli**：loopback `127.0.0.1:8085/oauth2callback` + 粘贴兜底；登录后必须 `v1internal:loadCodeAssist` 发现/`onboardUser` 开通 project（LRO 最长 2 分钟）；**非 free-tier（含 legacy-tier）要求 `GOOGLE_CLOUD_PROJECT` env**。quota：`v1internal:retrieveUserQuota` 按模型桶返回 `remainingFraction(0-1) + resetTime`，另有 `currentTier`（free/legacy/standard）。免费档即可用，Gemini 2.5~3.1 全系（1M ctx），伪装头 `User-Agent: GeminiCLI/<ver>` + `Client-Metadata`。
**判定：中。** 主要成本是 anthropic-messages→CCA 双向翻译器（omnicross 全新的一块）+ projectId 供应；omnicross 现有 gemini OAuth 走的是哪条 wire 需先对照（若已同源则大半可复用）。

**antigravity**：价值最高也最难。一个 Google 账号订阅同时解锁 **Claude Opus/Sonnet 4.x（后端 Anthropic 译制）+ Gemini 2.5~3.8 + gpt-oss-120b**（19 静态模型 + 动态发现）。quota 是全家最富：`v1internal:retrieveUserQuotaSummary` 直接给 **rolling 5h + weekly 双桶**（按 Google/Anthropic/OpenAI 计数器族拆分、remainingFraction/remainingAmount/disabled/resetTime），旧回退 `fetchAvailableModels` 每模型 daily/weekly quotaInfo——与 omnicross allowance 同构度最高。代价：完整复刻 antigravity/hub 客户端伪装（UA 版本从官方 manifest 在线热探测、requestId/sessionId/labels 信封、Claude 路由 `anthropic-beta` 头 + legacy parameters schema、强制 VALIDATED 工具模式、Gemini 路由 forced-tool 指令注入、production→sandbox 端点 failover）。版本 gating 是持续维护负担。
**判定：高价值、高成本。** 建议作为独立 change 立项评估。

### 2.7 GitHub Copilot / GitLab Duo

**Copilot**：device-code（client_id `Ov23ctDVkRmgkPke0Mmm`，scope `read:user`，轮询 `github.com/login/oauth/access_token`，间隔 ×1.2 递增）拿长期 `ghu_` 令牌——**无 refresh 网络调用，ghu_ 直接当 Bearer 用**（本 fork 无 ghu→u2i 换链，注释明确 "long-lived; no JWT exchange needed"；若上游策略收紧需自行补 `copilot_internal/v2/token` 换链层）。推理 `https://api.githubcopilot.com`（GHE 为 `copilot-api.<domain>`）按模型走三种 wire（anthropic-messages / openai-completions / openai-responses）；需镜像 Copilot CLI 身份头（Editor-Version、Copilot-Integration-Id 等）+ 每请求动态头 `X-Initiator`/`X-Interaction-Type`（影响 premium 计费：agent=0）；anthropic 分支剥离全部 anthropic-beta；登录后批量 `POST /models/{id}/policy {"state":"enabled"}` 启用策略模型。quota：`GET https://api.github.com/copilot_internal/user` → `quota_snapshots.premium_interactions {entitlement, remaining, percent_remaining}` + `quota_reset_date`（月度窗，无 5h 窗）。
**判定：中。** 44 模型（含 1M ctx Claude/GPT/Gemini/Grok），device-code 简单，成本在头镜像与三 wire 路由；surface-gate 403 是按模型策略而非凭据问题，账号轮换逻辑须豁免。

**GitLab Duo（非 agent 的 duo-chat 路径）**：oauth-code + PKCE（client `da4edff2...`，loopback `localhost:8080/callback`，GitLab 校验 redirect URI 漂移即拒 #2424；可 `GITLAB_TOKEN` PAT 完全绕过）→ `POST /api/v4/ai/third_party_agents/direct_access` 换 25 分钟短时 direct-access 令牌 → `cloud.gitlab.com/ai/v1/proxy/{anthropic,openai}` 标准 wire（duo-chat-* 别名映射上游 id）。无额度 API。**duo-agent 路径**（VS Code app + `vscode://` 手动粘贴 + REST+WebSocket 私有 DWS/LangGraph 协议 + checkpoint 重建）：不建议（oh-my-pi 该单文件 3134 行，工程量与脆弱度远超一个 gateway preset 的合理范围）。
**判定：duo-chat 低-中（有 Duo 订阅才有意义）；duo-agent 不做。**

### 2.8 OpenAI Codex（对照借鉴，omnicross 已有）

OAuth 与 omnicross 完全同源（同 client_id `app_EMoamEEZ73f0CkXaXp7hrann`、同 loopback 1455 PKCE），无需新流。可借鉴五点（按价值排序）：

1. **主动限额轮询** `GET https://chatgpt.com/backend-api/wham/usage`（Bearer + `ChatGPT-Account-Id` 头）→ `{plan_type, rate_limit:{primary_window(5h), secondary_window(周), allowed, limit_reached}, additional_rate_limits（Spark 独立计量表）, rate_limit_reset_credits}`。omnicross 目前 Codex 只在 egress 被动观察响应头；接入后零流量也能显示窗口，且 `reset_at` 是绝对时间戳（omnicross 现用 now+reset_after_seconds 有时钟偏差累积）。
2. **头名分歧需实机核对**：oh-my-pi 读 `x-codex-{primary,secondary}-reset-at`（绝对秒），omnicross 读 `x-codex-{primary,secondary}-reset-after-seconds`（相对秒）——两边互不读对方的头（已核查属实）。建议 omnicross 两者都读（reset-at 优先），并在 upstream-trace 确认服务器实际下发哪组。
3. **结构化错误解析**：oh-my-pi 读 error body 的 `error.code`（usage_limit_reached / usage_not_included / rate_limit_exceeded）+ `error.resets_at` + `plan_type`；omnicross `codexUsageLimitDetection` 靠英文文案 marker + "try again at" 正则（本地化即失效）。改读 error.code 更稳（注意已知坑：Codex 过载是 200+SSE `response.failed`，解析须覆盖 SSE 事件内载荷）。
4. **无头 device-code 登录**：`POST auth.openai.com/api/accounts/deviceauth/usercode` → 用户在 `auth.openai.com/codex/device` 输码 → 轮询 `.../deviceauth/token`（403/404=pending）拿 authorization_code 再走标准 token 端点。omnicross 没有；端口 1455 被占或 SSH 场景的唯一替代（浏览器流 URI 被 OpenAI 锁死不可换端口）。实现成本低。
5. **限额重置券**（可选增值）：`GET /wham/rate-limit-reset-credits` + `POST .../consume`（幂等 `redeem_request_id`），额度来自 `/wham/usage` 的 `rate_limit_reset_credits.available_count`；配合池级调度（oh-my-pi 的 codex-auto-reset：blocked 即时兑换 + sweep 挽救快过期积分）。

推理 wire 若要完整复刻需 /codex/responses 路径 + 十余个 x-codex-\* 头 + originator/version pin + 剔除采样参数；但 omnicross 作为中继只需透传客户端已构造好的请求 + Bearer/chatgpt-account-id 换绑（与同格式透传护城河一致），工作量集中在限额适配器。

### 2.9 Anthropic Claude（对照借鉴，omnicross 已有）

骨架一致（同 PKCE OAuth + `/api/oauth/usage`）。omnicross 可直接借鉴：

1. **现网正确性**：旧 `seven_day_opus`/`seven_day_sonnet` 自 2026-07-02 起永久 null，按模型族周额只应从 `usage.limits[].kind=weekly_scoped` 读——若 omnicross 仍读旧字段，周限额显示已失真。
2. **实时限额**：解析每次推理响应头 `anthropic-ratelimit-unified-{5h,7d,7d_oi}-{utilization(0-1),reset(秒)}` 免轮询更新（Codex 式被动捕获的 Claude 版）。
3. **超额信用**：`extra_usage`/`spend` 美元小额字段（`{amount_minor, exponent, currency, limit}`）。
4. **grant 硬寿命**：refresh grant 30 天 TTL（`ANTHROPIC_OAUTH_GRANT_TTL_MS`），轮换不延期，过期 `invalid_grant` 只能重登——账号管理需要到期预警。
5. **usage 端点 429 不可重试**（按 IP 限流）。
6. **指纹加固清单**（若被上游风控再考虑）：`claude-cli/2.1.257` UA + 全套 X-Stainless-\*、refresh 专用 UA `anthropic-sdk-typescript/{sdk} userOAuthProvider` + `anthropic-beta: oauth-2025-04-20`、system[0] billing header + xxHash64 cch attestation（Bun 专属 API，Node 需换实现）、metadata.user_id 须 CC 形状、`context-1m-2025-08-07` 刻意永不发送（OAuth 无长上下文余额会硬 429）。指纹常量需随上游 Claude Code 版本维护。

### 2.10 Cursor / Devin（Connect+proto 私有协议）

两者都不是 gRPC 原生，而是 **Connect 协议**（`application/connect+proto`，5 字节帧 = 1B flags + 4B 大端长度，end-stream JSON trailers），手写 Node 客户端 + 自研 protobuf codec（运行时 schema 是手工维护的生成码，非 protoc 产物）。

**Cursor**：单条 HTTP/2 流上的 `agent.v1.AgentService/Run`（**强制 h2**，HTTP/1.1 被 ALB 464 拒；ALPN 被剥的代理直接失败）。登录：浏览器打开 `cursor.com/loginDeepControl?challenge=<PKCE>&uuid=...` → 轮询 `api2.cursor.sh/auth/poll?uuid&verifier`（404 退避重试）→ `{accessToken, refreshToken}`；刷新 `POST /auth/exchange_user_api_key`。本质是**服务端编排的 agent 回路**：服务端在同一条流里反向下发 exec 工具帧要求客户端本地执行（原生集合仅 bash/read/write/delete/ls/grep/todo），并有 conversationState 有状态缓存/毒化轮换、5s 心跳、模型 id effort 规范化（裸 slug 报 528384）。**网关无法把它无状态中继为一次 completion**——要么实现完整本地 exec 桥与 Claude Code/Codex CLI 工具回路双向对接，要么接受异步移交语义。quota：`GET /auth/usage`（月度美元池）+ `cursor.com/api/usage-summary`（WorkosCursorSessionToken Cookie，auto/api 双百分比池）。
**判定：P3。** 协议形态与 omnicross 中继语义根本冲突。

**Devin**（实为 Codeium Cascade 的 devin-cli 通道，`server.codeium.com`）：HTTP/1.1 + gzip Connect 帧，每回合三段握手 `GetUserJwt`（session token 换 userJwt，可带 customApiServerUrl 重定向）→（router 类模型）`AssignModel` → `GetChatMessage` 一次性流式 completion——**语义对网关中继友好得多**。凭据放 protobuf `Metadata.apiKey`（`devin-session-token$` 前缀），身份元组（ideType=chisel/ideVersion pin）被后端门控，失效即静默空目录。登录是标准 loopback PKCE（`app.devin.ai/auth/cli/continue`，127.0.0.1:59653/callback，无 client_id，JSON body token 交换，无刷新）。quota：单个 `GetUserStatus` RPC 给信用点三桶（prompt/flow/flex）+ **日/周百分比窗口 + resetAtUnix** + email/org——与 allowance 同构度最高的一家 proto 系。成本：protobuf 消息集（exa/\* 子树 33 个 .proto + 手工 codec 2650 行）+ 每回合前置 RPC + 会话级 cascadeId。
**判定：P3（有 Devin 订阅且明确需要时再评估；工程量集中在 proto 层）。**

### 2.11 API-key 型订阅聚合与长尾

| Provider | 登录 | 推理 wire | 额度 API | 判定 |
| --- | --- | --- | --- | --- |
| cline-pass（Cline 订阅网关） | dashboard 粘 key + `/users/me` 校验 | openai-chat `api.cline.bot/api/v1`，18 模型（kimi-k3/glm-5.3/deepseek-v4/free 档），wire id 加 `cline-pass/` 前缀，**必须带 Cline 身份头集**（HTTP-Referer/X-Title/X-CLIENT-TYPE 等，缺失 403） | `/users/me/plan/usage-limits`：5h/周/月 三窗百分比 + resetsAt（同 key 可查） | 中：preset + 身份头 + usage 适配器；403 是 surface-gate 不是凭据问题，轮换须豁免 |
| opencode-go / opencode-zen（OpenCode Go/Zen 订阅） | `opencode.ai/auth` 控制台粘 key（omnicross 已有 opencodego 订阅 provider，GO/ZEN 双半） | 多 wire：`/zen/go/v1`（openai-chat+responses）与 `/zen/go`（anthropic），zen 半再 +gemini | `GET /zen/go/v1/usage`：rolling(5h)/weekly/monthly 三窗百分比 + resetsAt，401/403 须 throw 标记凭据 | 中：主要增量是给**已有** OpenCodeGo 账号补 usage 适配器；oh-my-pi 的排序策略值得抄——monthly 窗口 display-only（控制台 Use balance 兜底开启时月耗尽仍可用，硬阻塞会错杀可用 key），rolling+weekly 做主/次排序 |
| umans（Umans AI Coding Plan） | `app.umans.ai/billing` 粘 key + anthropic-messages 真实补全校验 | **anthropic-messages** `api.code.umans.ai`（Claude Code 直接可吃），11 模型 | `/v1/usage`：软上限（weighted，永不 exhausted 只 warn@0.9）+ 突发硬上限（raw 计数，可 exhausted）双层 + 滚动 5h FIFO（resets_at 是 tick 倒计时非硬重置）+ 并发上限 | 中：双层额度模型很适合 allowance/调度；注意 raw 判耗尽会误伤仍有 weighted 余量的账号（oh-my-pi #7858 踩过） |
| synthetic（synthetic.new） | dashboard 粘 key + models 端点校验 | openai-chat `api.synthetic.new/openai/v1`，hf: 命名 11 模型 | `/v2/quotas`：5h 滚动请求数（tick 回复制 regen %/tick）+ 周度美元积分（$ 口径，nextRegenAt） | 中低：美元单位适合 omnicross 终身消费 rollup；该适配器 401 不 throw，当健康探针需自行加判定 |
| xiaomi（MiMo + token-plan 变体） | 控制台粘 key；`tp-` 前缀 key 按 SGP→AMS→CN 三区域探测 | openai-chat `api.xiaomimimo.com/v1`（GLM 同款 reasoning_content 协议、max_completion_tokens） | 无 | 低：一个 preset 即可；omnicross 已有 xiaomi-mimo 预设 |
| kilo（Kilo Gateway 聚合） | **私有** device-auth（POST `api.kilo.ai/api/device-auth/codes` → 网页输码 → GET 轮询 202/403/410 语义；非 RFC 8628），token 一年有效 | openai-chat `api.kilo.ai/api/gateway`，545 模型（~anthropic/claude-\*-latest 别名 + vendor/model 全目录） | 无 | 低中：聚合网关（类 openrouter 扩展），60 行登录器 + preset；无额度是短板 |
| coreweave（经 WandB） | wandb.ai/settings 粘 key + models 探针（**必须 `OpenAI-Project: <team>/<proj>` 头**，来自 env） | openai-chat `api.inference.wandb.ai/v1`，38 开源模型（DeepSeek-V4/GLM-5.x/Kimi） | 无 | 低 |
| cloudflare-ai-gateway（BYOK 聚合） | 交互收三字段（token `cfut_`/account/gateway）序列化 JSON 存储 | 混合：`/anthropic`（anthropic 直通）+ `/openai`（responses 直通）+ `/compat`，按路由切鉴权头（cf-aig-authorization vs x-api-key），模型 id 点号替换 | 无 | 低中：对"同格式透传"护城河是加分项（/anthropic 路由 Anthropic 格式直通） |
| perplexity（订阅会话） | macOS 偷原生 App JWT 或 网页 CSRF+邮箱 OTP（+TOTP），私有会话协议 | 订阅路径是私有 SSE `perplexity_ask`（JWT 走 **Cookie** 非 Bearer——带 Bearer 会被静默降级免费 turbo）+ 伪造 iOS UA 过 Cloudflare | 无 | 低：仅当想把 Pro 订阅变成搜索上游才有意义；Windows 偷 token 捷径不可用；refresh 实际靠 Socket.IO（未实现） |
| openrouter | **oauth-code + PKCE**（`openrouter.ai/auth` → `/api/v1/auth/keys` 换**永久 key**；纯 KDL 声明，无手写模块），或 sk-or- 粘贴 | openai-chat（omnicross 已有 preset） | 无 | 低：omnicross 已有 preset；登录自动化（浏览器授权→自动落 key）是可选便利项 |
| moonshot / 其他 ~50 个 api-key KDL | 粘贴 + 探针 | 标准 openai-chat / anthropic | 无 | 等价于 omnicross 现有 30 个 preset 模式，按需补目录即可 |

## 3. 不新增 Provider 也能直接借鉴的实现清单

1. **Claude 周限额字段迁移**（§2.9-1，现网正确性）+ `anthropic-ratelimit-unified-*` 响应头实时更新 + extra_usage/spend 显示。
2. **Codex `/wham/usage` 主动轮询**（零流量可见）+ 双头名兼容（reset-at 优先）+ error.code 结构化解析（替代英文文案正则）+ device-code 无头登录 + reset credits。
3. **Z.AI quota/limit 适配器**（现有 zhipu key 即查；注意裸 Authorization、percentage 服务端取整宜自算、unit 枚举、level 档位）。
4. **allowance 口径扩展**：oh-my-pi 的 UsageUnit 有 percent / requests / tokens / credits / usd 五类，resetLabel 有硬重置 / tick 增量回复 / regen 三类——omnicross allowance UI 若要吃下 MiniMax（百分比+次数）、synthetic（美元+regen）、umans（软/硬双层）需要先在快照契约（`account-allowance-types.ts` 的 AllowanceWindow）扩展口径字段。
5. **凭据健康探测约定**：cline-pass/opencode-go/umans 的 usage 端点按"401/403 必须 throw 以标记凭据不健康"设计，可直接对齐 omnicross 的账号健康/轮换；surface-gate 403（cline-pass）与策略 403（copilot）必须豁免轮换。
6. **多设备账号池参考**：oh-my-pi 的 auth-broker（127.0.0.1:8765，REST+SSE 快照、AES-256-GCM 磁盘缓存、refresh token 永不出 broker 主机、`__remote__` sentinel）+ auth-gateway（127.0.0.1:4000 三 wire 翻译、passthrough 刻意移除、deterministic prompt_cache_key 兼 session 亲和）是"凭据集中托管 + 多端镜像 + 按机器归属用量"的完整参考实现——若 omnicross 未来做多设备共享账号池可对照其协议设计。
7. **刷新调度常量**：60s skew 预刷新（omnicross 现为 5min lead window，两者都合理）、跨进程刷新租约 15s、usage 缓存 5min TTL + 24h last-good、AUTH_RETRY 上限 64 + attemptedKeys 去重——语义与 omnicross 的 inFlightRefreshes/RefreshMutex 对齐良好，可互相印证。

## 4. 风险与未验证项

- **逆向凭据随时可能失效**：Z.AI client（loopback 已被封过一次 #10745）、xAI client（hermes-agent 逆向）、Kimi X-Msh-\* 指纹、Claude Code 指纹链（版本常量需随上游维护）、Cursor/Devin 的 CLI 版本 pin（Cursor 推理 `cli-2026.07.23-e383d2b` 与发现 `cli-2026.02.13-41ac335` 两个都要带）。oh-my-pi 的普遍做法是 env 覆盖口（`ZAI_OAUTH_*`、`KIMI_CODE_OAUTH_HOST`、`GITLAB_CLIENT_ID` 等），omnicross 接入时应保留同等逃生舱。
- **私有额度接口无契约**：zai quota/biz、alibaba-token-plan 控制台网关、MiniMax token_plan、Antigravity v1internal 等，字段可能随服务端变化；适配器须防御式解码 + last-good 缓存（oh-my-pi 的 24h last-good 模式值得照抄）。
- **未验证项**（静态调研无法回答，接入前需实机探测）：Kimi 指纹头缺失时的拒绝行为；MiniMax 普通平台 key 与 Token Plan key、以及 anthropic 兼容面对 Token Plan key 的兼容性；minted Z.AI key 的服务端有效期；zai 周窗口 unit=6 是自然周还是滚动 7 天；omnicross dashscope 预设的 `/compatible-mode/v1` 与 coding-plan `/v1` 是否等价；Codex reset-at 头名的实际下发集合。
- **协议型 Provider 的维护成本**：Cursor（4555 行 agent.proto）、Devin（33 个 exa proto + 2650 行手写 codec）的字段号与版本 pin 漂移是持续负担。

## 5. 附：关键源文件索引（oh-my-pi 根相对路径）

- 登录规则声明：`packages/catalog/src/compat/rules/auth/*.kdl`（81 个；全量名册 `packages/catalog/src/compat/auth-ids.ts`）
- 登录引擎：`packages/ai/src/registry/engine/{api-key,oauth-code,device-code,refresh,common}.ts`；hook 接线 `packages/ai/src/registry/hooks/`
- 手写登录流：`packages/ai/src/registry/oauth/{zai,kimi,xai-oauth,alibaba-*,xiaomi,kilo,coreweave,perplexity,cloudflare-ai-gateway,google-*,anthropic*,openai-codex,github-copilot,gitlab-duo,cursor}.ts`
- 用量适配器：`packages/ai/src/usage/`（19 个 provider 适配器 + shared）
- 凭据存储：`packages/ai/src/auth/sqlite-credential-store.ts`、`auth-storage.ts`（7355 行）；多机共享 `packages/ai/src/auth-broker/`、翻译网关 `packages/ai/src/auth-gateway/`
- 模型目录：`packages/catalog/src/models.json`；wire 兼容规则 `packages/catalog/src/compat/rules/providers/*.kdl`
- 私有协议：`packages/ai/src/providers/cursor/`（agent.proto 4555 行）、`packages/ai/src/providers/devin/`（exa/* 33 proto）；运行时 codec `packages/catalog/src/discovery/{cursor-proto,devin-proto}.ts`

## 6. 实施状态（2026-09-06 更新）

第一轮落地（工作区未提交，全仓 4048 测试通过）：

**P0 全部完成**
- Codex：`/backend-api/wham/usage` 主动轮询（新 `CodexAllowanceCollector`，服务/管理 API/UI 刷新改走免探测端点，删除确认框与 Luna 探针）；`x-codex-*-reset-at` 绝对秒双读（优先于相对秒）；结构化 `error.code`（usage_limit_reached/usage_not_included/rate_limit_exceeded + `resets_at`）解析替代英文文案正则，SSE `response.failed` 内的 usage-limit 也标记账号。
- Claude：`limits[].kind=weekly_scoped`（旧 `seven_day_sonnet` 已永久 null）；`anthropic-ratelimit-unified-{5h,7d,7d_oi}-*` 响应头被动合并进快照（`recordClaudeHeaders`，保留 usage API 的 scoped 行）。
- Z.AI：新建 BYO provider-key quota 子系统（`ProviderKeyQuotaService` + 4 适配器：zai/minimax-token-plan/umans/synthetic；5 分钟读穿缓存；admin keys 视图内嵌 quota + 每键刷新端点；UI 密钥行进度条）。现有 zhipu/zhipu-bigmodel coding-plan key 即得 5h/周窗口（裸 Authorization；绝对值 meter 优先于服务端取整 percentage；同窗多 meter 取最紧）。

**P1 完成（z.ai 登录流按要求跳过）**
- Kimi Code 全链路：设备码 OAuth flow（RFC 8628，pending/slow_down 语义、slow_down 间隔在下次等待前生效）+ `X-Msh-*` 指纹头（每账号持久 deviceId）+ 刷新轮换 + 多账号调度 + anthropic 面 dispatch（`api.kimi.com/coding/v1/messages` 同格式直通）+ `/coding/v1/usages` 限额（5h 归一 + 7d 聚合）+ CLI `omnicross login kimi` + admin 设备码登录（start 返回验证 URL+code，轮询 status）+ UI 卡片/内联登录/手填 token + 31 locale i18n。
- MiniMax Token Plan 预设（openai 面 intl/CN 同一端点，M2→M3 九模型，canonical 注册），key 自动获得 quota 面板。

**P2 完成（便宜项）**
- opencodego 限额：`{go}/v1/usage` 主动采集（rolling+weekly；monthly 刻意不报——控制台 Use balance 兜底会使月耗尽 key 仍可用，worst-window 调度会误杀）；scheduling 白名单放行。
- umans 预设（anthropic 面）+ quota 适配（硬上限 raw 计数为准，软上限 weighted 只作回退）。
- synthetic 预设（openai 面）+ quota 适配（5h 请求数 tick 回复 + 周美元积分）。

**P2 未做（后续）**：google-gemini-cli/antigravity（需 CCA wire 翻译器，独立 change）、kilo（与 openrouter 重叠）、alibaba-token-plan（Cookie 运维型）、GitLab Duo、Cursor/Devin（P3）。

**第二轮落地（2026-09-06 下午）**

- **cline-pass 完成**（原卡点「预设 schema 无自定义请求头能力」已解决）：新建通用 `extraHeaders` 基建——contracts 上 `PresetProviderTemplate.extraHeaders` + `LLMProvider.extraHeaders`；core `getProviderHeaders` 合并点（`mergeExtraHeaders`，支持 `{{platform}}` 占位符、保留名集合 `EXTRA_HEADER_RESERVED_NAMES` 在合并点二次强制，auth/content 头永不可覆盖）；daemon 侧 config 加载守卫 + admin 写网关三态写契约 + GET 视图 round-trip + preset-map/MappablePreset/admin presets 投影 + discover-models/test-model 探测合并 + ProviderKeyQuota 配额探测合并；UI 侧 DaemonPresetView/adapter/表单（模板预填创建路径带上，编辑路径 omit-keeps）。cline-pass 预设 18 模型（付费档 wire id 带 `cline-pass/` 前缀、free 档原样直通）+ 配额适配器（`/api/v1/users/me/plan/usage-limits` 三窗百分比：5h/周/月；同 Bearer key + 行身份头）。
- **opencode-zen BYO 预设判定不做**：oh-my-pi 目录 34 个 opencode 模型全在 go 半（`/zen/go/v1`），zen 半无静态清单（纯动态发现）；且 go 半按模型分 chat/responses/anthropic 三种 wire，单 apiFormat 的 BYO 预设表达不了——订阅 provider（已存在、双半多 wire、带 usage collector）才是正确载体，BYO 预设只会产出残缺目录。
- SuperGrok 契约已从源码复核（`packages/ai/src/registry/oauth/xai-oauth.ts` + `usage/xai-oauth.ts`）：设备码 client `b1a00492-073a-47ea-816f-4c329264a828`，token endpoint 经 OIDC discovery 钉 `*.x.ai`；billing 双形态解析要点——weekly `?format=credits` 的 `config.creditUsagePercent` 缺失时活跃窗口按 0 推断（`inferredPercent`），`config.isUnifiedBillingUser===true` 时须再探默认 URL 的月度 `monthlyLimit/used`（正数则用月度，否则确认周重置循环）；两探针均失败时丢弃推断值保 last-good。billing 头集 `Authorization: Bearer` + `X-XAI-Token-Auth: xai-grok-cli`，`redirect: error`。

**第三轮落地（2026-09-06 晚）：SuperGrok（`grok`）全链完成**

- 订阅 provider `grok`（id 与 BYO grok 预设同名共存，同 kimi 先例）：设备码 flow（scopes 全集含 `grok-cli:access`，token endpoint 经 OIDC discovery 解析并钉 `*.x.ai`，1h 进程缓存 + `resetGrokDiscoveryCache` 测试钩子，`GROK_OAUTH_DEVICE_ENDPOINT`/`GROK_OAUTH_DISCOVERY_URL` 逃生舱）；OAuthBearerAuthStrategy 联合 + JsonSubscriptionCredentialStore（refreshGrokToken/by-id 刷新/writeBack/markExpired）+ TokenRefreshScheduler 扫描；dispatch profile 镜像 codex（`api.x.ai/v1/responses` + `openai-response` 编码链——effort 方言全部走 canonical 能力协商，omit-effort 模型（grok-4.20-0309 系/grok-build 系/composer）注册 `thinkingLevels: ['none']` 使 `reasoning.effort` 不发送，effort 模型只注册 low/medium/high）；模型目录 9 个（含 UI 镜像）；`GrokAllowanceCollector`（billing 双形态 + inferredPercent/unified 推断规则 + on-demand 第三窗 + 401→refresh→retry；探测时序：weekly 可用且非 unified 只探一次）；allowance 调度白名单放行（grok 月/周窗是权威配额，无 opencodego 式控制台兜底问题，worst-window 语义正确）；CLI `omnicross login grok` + admin 设备码登录（`/accounts/grok/oauth/*`，同 kimi 形态）；UI 卡片/内联登录/手动 token/allowance 刷新/模型选择器全接（i18n 键落 en/zh/zh-Hant，其余 28 locale 走 `fallbackLng: 'en'` 回退——下次补译）。
- 未做但已探明：`x-grok-conv-id` 会话缓存头（多客户端中继下无法共享 conv id，属优化非门禁，跳过）；推理 UA 归属头（非门禁，跳过）。待实测确认（§4 同）：minted token 寿命/刷新轮换行为（按「响应缺 refresh_token 保留旧值」实现）、9 模型 id 的服务端实收集合。
- 全仓 4113 测试通过；build + typecheck 干净。

**第四轮落地（2026-09-07）：GitHub Copilot（`copilot`）全链完成**

- 设备码 flow（官方 Copilot CLI app `Ov23ctDVkRmgkPke0Mmm`，scope `read:user`，GitHub 特有 ×1.2/×1.4 递增轮询节奏）；ghu_ 长期令牌——**刷新是本地 no-op**（refresh=access 同 token + 10 年远期 expiresAt，Generic 刷新路径永不触发网络；401 时 store 标记 expired + "re-authenticate" 信息，代理不重试不循环）；登录后异步完成身份读取（/user login/email）+ 端点发现（copilot_internal/user.endpoints.api）+ **44 模型策略启用清扫**（POST /models/{id}/policy，Claude/Grok 系未启用会 403）。
- 推理：三 wire 按模型路由（复用 opencodego 的 per-model `resolveProviderTransformerNames`/`resolveUpstreamUrl` seam）——Claude 系 11 模型走 `/v1/messages` 同格式直通，GPT/Grok/mai-code 系 20 模型走 `/v1/responses`，Gemini/Kimi/raptor 系 13 模型走 `/v1/chat/completions`；base 解析 apiEndpoint > GHE 域 > api.githubcopilot.com。身份头集由 AuthStrategy 注入（`copilot/1.0.82` UA/Editor-Version + Copilot-Integration-Id/Harness-Id + `X-GitHub-Api-Version: 2026-08-01`（解锁长上下文 tier 元数据，永不发给 api.github.com REST）+ 静态 `X-Initiator: agent`（官方 CLI 自身分类，agent=0 倍 premium 计费）；每请求 initiator 推断与 Copilot-Vision-Request 头刻意未做（多客户端中继恒为 agent 语义）。
- 配额：CopilotAllowanceCollector（`api.github.com/copilot_internal/user`，GHE 走 api.<domain>）——premium_interactions 月度窗（绝对 meter 优先，unlimited 报 0% 永不阻塞）+ 计费制 legacy chat 窗；调度白名单放行。
- canonical 新增 COPILOT_MODELS 块（仅 Copilot 独有 id；gpt-5/gpt-5.3-codex 等复用既有条目避免重复 id 断言）+ Anthropic/Gemini 块补 Copilot 变体（claude-opus-4-5/sonnet-4-5/sonnet-4、gemini-2.5-pro/3.x 预览系）。
- CLI `omnicross login copilot` + admin 设备码端点（登录会话完成后才 settle done，含策略清扫）+ UI 全接（i18n en/zh/zh-Hant，其余回退英文）。GHE 域登录交互留作后续（enterpriseUrl 字段与路由已支持，只是 CLI/admin 流未做域提示）。
- 待实测确认：44 模型 id/ wire 归属的服务端实收（静态表来自审计源冻结清单）、premium 计费对 X-Initiator: agent 的实收倍率、policy 启用的幂等语义。
- 全仓 4128 测试通过；build + typecheck 干净。

**顺带修复**：main 上 `importSurface.test.ts` 期望的 README 短语已过期（b190db1 改了 README 未同步测试）。

**第五轮收尾（2026-09-07）：工作流后续任务清零**

- **i18n 补译完成**：grok/copilot 六键补入其余 28 locale（`124cc19`，镜像各 locale 既有 kimi 句式）。注意：28 locale 还另有 **623 键历史债**（overview/upstreams/apiService/accounts.management 等，8 月起累积，非本工作流产物）——en/zh/zh-Hant 是完整维护集，其余靠 `fallbackLng:'en'`，如需清扫建议独立 sweep（先例 f676275）。
- **Copilot GHE 域登录完成**（`c4bc168`）：`normalizeCopilotEnterpriseDomain` + `copilotOAuthUrls`（设备/令牌端点骑企业域）+ `copilotGitHubApiBase` 共享 REST base（allowance collector 复用）；CLI `login copilot --enterprise <domain>`（非 copilot 传参即报错、坏域名 fail-fast）；admin start 收可选 `enterpriseUrl` body（400 校验）+ 回显归一域；UI copilot 卡片可选域名输入（新键直接落满 31 locale）。
- **google CCA 立项文档落盘**：`docs/design/omnicross-google-cca-provider-requirements.md`。关键发现回答了 §2.6 开放问题——**omnicross 现有 `gemini` 订阅 provider 就是 google-gemini-cli 主体**（同 client `681255809395-…`、`GeminiCodeAssistTransformer`+`ProjectResolver` 已实现 CCA 信封与 project 握手），缺的只有 `retrieveUserQuota` 采集器与 GeminiCLI 伪装头（P0 小 change）；antigravity 才是全新大项（独立 client 1071006060591、daily-cloudcode-pa 双端点、UA 版本热探测、双模型路由、quotaSummary 双桶，~3000 行级，P1 独立 change）。
- **kilo 处置：不做（当前）**。与 openrouter 聚合形态重叠且无额度 API；omnicross 已有 openrouter/openrouter-response BYO 预设覆盖同类目录，唯一增量是 60 行私有 device-auth 登录器（非 RFC 8628 的 202/403/410 语义）+ 一年令牌。若未来用户点名要 kilo 付费档，按 opencodego 先例（静态凭据 + 私有登录器）半天级可补。
- **alibaba-token-plan 处置：不做**。额度接口（5h+7d 双窗，价值确实高）依赖浏览器会话 Cookie 手动供给 + CSRF 头 + 控制台私有网关两步调用（国际/中国区域互锁、失效 `ConsoleNeedLogin` 需重贴）——与 omnicross 加密凭据存储 + 自动刷新模型不匹配，运维成本 > 额度价值。coding-plan（粘 key、零额度）同样不做：与现有 dashscope 预设重叠。真有需求时折中形态是「BYO 预设 + test-model 探活」而非账号订阅。

**工作流状态：§6 P2 列表清零**（google 双项已立项成文档、kilo/alibaba 已记录不做决策）；剩余仅为 GitLab Duo / Cursor / Devin（P3 私有协议，无明确需求不动）与各家待实机验证项（§4 + 各轮记录）。

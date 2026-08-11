# Rasen 托管 Route Lease — OmniCross 功能需求

> 状态：待开发需求基线
> 日期：2026-08-11
> 目标仓库：OmniCross
> 消费方：Rasen workflow/session execution layer

## 1. 需求摘要

OmniCross 需要为 Rasen 提供一个长期运行的本地推理路由服务。用户只在 OmniCross 中配置上游
Provider、API Key、订阅账号、账号组或账号池；在 Rasen workflow 中选择 agent runtime、上游
资源和模型。Rasen 执行 stage 时，OmniCross 自动创建一个短期 Route Lease，并返回启动
Claude Code 或 Codex 所需的环境变量和 argv。

本功能不得要求用户为每个 workflow/stage 手动创建长期 API Key 或 GatewayBinding，也不得
修改用户的 Codex/Claude 全局配置文件。Route Lease 的临时 token 即本次执行的下游 API Key，
其内存 RouteContext 即本次执行的下游绑定。

## 2. 背景与现有基础

OmniCross 当前已有：

- 长期运行的 daemon、Admin API、Outbound API Gateway；
- resident `ProviderProxy` 和 `ProviderProxyRouteMap`；
- `addRoute(RouteContext) -> token`、`removeRoute(token)` 和 idle TTL；
- OpenAI Responses、Anthropic Messages、OpenAI Chat、Gemini ingress；
- Provider/账号解析、API Key Pool、订阅账号调度和 transformer chain；
- Claude Code 与 Codex 的单次 launch config builder；
- `POST /admin/api/cli/:cli/launch` 创建 route 后直接打开外部 terminal；
- 持久 Gateway Key/GatewayBinding，供普通外部客户端使用。

本需求不是重做上述能力，而是把“创建 route”和“启动本机 terminal”解耦，增加一个机器可调用、
不启动 CLI 进程的 Route Lease 控制面。

### 2.1 当前 Codex 差距

当前 `buildCodexLaunchConfig()` 使用：

```text
requires_openai_auth=true
OPENAI_API_KEY=<route-token>
```

Rasen 托管路径需要改为 Codex custom provider 的专用 `env_key`：

```text
model_providers.omnicross.env_key="OMNICROSS_CODEX_ROUTE_TOKEN"
OMNICROSS_CODEX_ROUTE_TOKEN=<route-token>
```

不得依赖 `requires_openai_auth`、ChatGPT/OpenAI 登录状态或 `~/.codex/auth.json`。

## 3. 术语

| 术语 | 定义 |
|---|---|
| Upstream | OmniCross 已配置的 BYO Provider、Provider Key、订阅账号、账号组或账号池 |
| Runtime | 发起模型请求的 agent CLI；本期为 `claude` 或 `codex` |
| Ingress | Runtime 对 OmniCross 使用的协议；Claude 为 Anthropic Messages，Codex 为 OpenAI Responses |
| RouteContext | 冻结一次执行的 upstream、model、ingress、auth 和 attribution 的内存路由 |
| Route Token | 256-bit 随机 bearer token；仅用于在 resident proxy 中查找 RouteContext |
| Route Lease | RouteContext、route token、TTL、幂等身份和 launch descriptor 的受控生命周期 |
| Launch Descriptor | Rasen 启动 agent child process 时需要合并的 `env` 与 `extraArgs` |

文档中的 **必须/MUST** 是交付要求，**应该/SHOULD** 是默认应实现、只有明确理由才能偏离的要求。

## 4. 用户故事

### US-1：只配置上游

作为 Rasen 用户，我只需要在 OmniCross 中添加 Anthropic、DeepSeek 等 Provider 或 Claude/Codex
订阅账号，不需要理解或创建 Rasen 专用的 GatewayBinding。

### US-2：按 stage 选工具与上游

作为 workflow 作者，我可以让 planner 使用 Codex + Claude Opus，让 implementer 使用 Claude
Code + Claude Sonnet，让 ship 使用 Codex + DeepSeek；这些 stage 可以顺序或并发执行。

### US-3：daemon 只启动一次

作为本地用户，我只启动一次 OmniCross daemon。每次 stage 只创建/释放 Route Lease，不启动或
销毁 resident router。

### US-4：配置零污染

作为同时日常使用 Codex/Claude 的用户，Rasen runs 不修改我的全局 model provider、登录状态、
`auth.json`、Claude credentials 或 settings。

### US-5：安全恢复

作为运行恢复者，当 daemon 重启或旧 lease 过期时，Rasen 可以根据其冻结的逻辑路由申请新
lease；旧 token 不能继续使用，也不能回退到其他 Provider。

## 5. 功能需求

### FR-1：Resident Route Lease Manager

OmniCross daemon **必须**拥有一个与 daemon 同生命周期的 `RouteLeaseManager`：

- 复用同一个 resident `ProviderProxy`；
- 为每个 lease 调用现有 route map 的 `addRoute()`；
- 保存 `leaseId -> routeToken/RouteContext/metadata/expiry/cleanup` 的内存记录；
- 释放 lease 时只调用 `removeRoute(token)`，不得停止 ProviderProxy；
- daemon shutdown 时释放全部 lease；
- route/lease 到期后自动回收；
- 不把 route token 持久化到磁盘。

`RouteLeaseManager` **不应**创建正式 Outbound API Key、Integration Key 或 GatewayBinding 记录。

### FR-2：机器可调用的 Admin API

OmniCross **必须**在现有 `/admin/api/*` 控制面增加：

```text
POST   /admin/api/route-leases
GET    /admin/api/route-leases
GET    /admin/api/route-leases/:leaseId
POST   /admin/api/route-leases/:leaseId/renew
DELETE /admin/api/route-leases/:leaseId
```

要求：

- 复用现有 AdminServer 认证门；
- 第一阶段只允许 loopback 访问；
- 创建/续租响应必须设置 `Cache-Control: no-store`；
- GET/list 只能返回脱敏元数据，绝不能返回 route token 或 launch secret；
- DELETE 必须幂等；
- endpoint 不得启动 terminal 或 agent 进程。

### FR-3：上游目标契约

创建 lease **必须**支持与现有 `GatewayBindingTarget` 对齐的判别联合：

```ts
type RouteLeaseUpstream =
  | { kind: 'provider'; providerId: string; keyId?: string }
  | { kind: 'account'; providerId: string; accountId: string }
  | { kind: 'account-group'; providerId: string; group: string }
  | { kind: 'account-pool'; providerId: string };
```

解析规则：

- `provider` 使用 BYO Provider；指定 `keyId` 时遵守现有 Key Pool 严格选择语义；
- `account` 严格绑定单账号；
- `account-group` 在指定组内使用现有健康/优先级/限额策略；
- `account-pool` 使用指定订阅 Provider 的完整账号池；
- 不存在、停用或不可用的严格目标必须在 lease 创建阶段返回结构化错误；
- 只有请求中显式声明的 pool/fallback 策略可以换账号或 key；
- 不得静默回退到全局默认 Provider。

应该复用现有 GatewayBinding/route resolver 的目标选择语义，但不得为 lease 写入持久 Binding。

### FR-4：Runtime 到 Ingress 的确定性映射

本期 runtime 闭集：

| runtime | ingressFormat | 客户端 wire |
|---|---|---|
| `claude` | `anthropic-messages` | `POST /v1/messages` |
| `codex` | `openai-responses` | `POST /openai/responses` |

OmniCross **必须**根据 runtime 选择 ingress，调用方不得自行提交任意 ingress string。未来增加
runtime 必须通过版本化 capability 扩展，不能让未知值落入默认分支。

### FR-5：模型与格式预检

创建 lease 前 **必须**完成不发起付费模型请求的静态预检：

- upstream 资源存在且类型匹配；
- 所需凭证或订阅 profile 可解析；
- model 为非空且允许用于该 upstream；
- ingress 到 upstream `apiFormat` 的 transformer chain 可解析；
- runtime launch adapter 可用。

不支持的格式组合必须在 agent 启动前以 `format_unsupported` 失败，不能延迟成不透明的上游
502。预检不要求主动调用上游；网络、额度和凭证有效性仍可能在真实请求期变化。

RouteContext 中的 upstream 和 model 必须冻结。客户端 request body 中的 model 不得改变实际上游
模型；若需要保持客户端可见 model 名称，应只在响应投影中保留，usage 仍归因真实上游模型。

### FR-6：临时 Token

每个新 lease **必须**获得独立的 256-bit 加密随机 token：

- token 只能查找本 lease 的 RouteContext；
- token 未知、过期、释放或 daemon 重启后必须返回 401，且不允许 fallback；
- ProviderProxy 必须剥离 token，再使用 OmniCross 保存的上游凭证重新认证；
- token 不能作为上游 API Key 转发；
- token 不得出现在普通日志、错误序列化、GET/list、审计详情或 telemetry；
- 同时运行的 leases 不得共享 token。

### FR-7：Runtime Launch Descriptor

创建成功后 **必须**返回结构化、argv-safe 的：

```ts
interface RuntimeLaunchDescriptor {
  env: Record<string, string>;
  extraArgs: string[];
}
```

`extraArgs` 是离散 argv 元素，不是 shell command string。OmniCross 不负责 Rasen 的 prompt、
sandbox、approval、output schema、structured output 或 session/thread resume 参数。

#### FR-7a：Codex descriptor

Codex descriptor **必须**等价于：

```text
env:
  OMNICROSS_CODEX_ROUTE_TOKEN=<route-token>

extraArgs:
  -c model_provider="omnicross"
  -c model_providers.omnicross.name="OmniCross"
  -c model_providers.omnicross.base_url="http://127.0.0.1:<port>/openai"
  -c model_providers.omnicross.wire_api="responses"
  -c model_providers.omnicross.env_key="OMNICROSS_CODEX_ROUTE_TOKEN"
  -c disable_response_storage=true
```

要求：

- 不设置 `requires_openai_auth=true`；
- 不使用 `OPENAI_API_KEY` 传 route token；
- 不读取或写入 `auth.json`；
- 不写 `config.toml`；
- provider name 必须为 OmniCross 保留名并正确 TOML quote；
- base URL 必须来自已启动的 resident ProviderProxy；
- response storage 在 OmniCross 支持有状态 Responses 前保持禁用。

#### FR-7b：Claude descriptor

Claude descriptor **必须**包含：

```text
ANTHROPIC_BASE_URL=<resident-proxy-base>
ANTHROPIC_AUTH_TOKEN=<route-token>
ANTHROPIC_API_KEY=<non-secret-sentinel-if-required>
ANTHROPIC_MODEL=<frozen-model>
```

不得读取或修改 `.claude/.credentials.json` 或用户 `settings.json`。上游真实凭证不得进入 descriptor。

### FR-8：幂等创建

创建请求 **必须**携带 `idempotencyKey`。同一 consumer scope 内：

- 相同 key + 相同规范化 payload + lease 仍存活：返回同一个 lease 和同一个创建 descriptor；
- 相同 key + 不同 payload：返回 HTTP 409 `idempotency_conflict`；
- 原 lease 已 released/expired：允许创建新 lease，但响应必须明确新的 lease id；
- idempotency key 必须有长度和字符/字节上限；不得直接写入无限制日志或路径。

这使 Rasen 在 create 响应丢失时可以安全重试，而不会泄漏多个 routes。

### FR-9：TTL、续租与释放

- lease 必须具有有界 TTL 和 `expiresAt`；
- 默认 idle TTL 应与现有 route map 的 10 分钟语义兼容；
- Rasen 可以在到期前调用 renew；
- renew 必须延长 lease 和底层 route 的有效期，不更换 token；
- renew 已释放/过期 lease 返回 `lease_not_found` 或 `lease_expired`；
- DELETE 必须立即使 token 失效并执行 cleanup；
- 重复 DELETE 返回成功且表明 `released=false`，不得报 500；
- daemon 必须用 fake clock 可测试地回收过期 lease；
- 不允许无界、永久 lease。

### FR-10：Daemon 重启语义

Route Lease 和 token **必须**是进程内临时状态：

- daemon 重启不恢复 token；
- 所有旧 token 在新进程中失效；
- Rasen 使用冻结的 upstream/model/runtime 重新创建 lease；
- OmniCross 不需要持久化 prompt、Run Record 或 Rasen stage 状态；
- GET 旧 lease 返回 404，而不是猜测或重建路由。

### FR-11：并发隔离

至少支持：

- 同一 Rasen run 多个并发 stage；
- 不同 runs 使用相同 upstream/model；
- 不同 runs 使用不同 upstream/model；
- 同一 Codex/Claude runtime 同时存在多个 routes；
- 一个 lease 释放、过期或失败不影响 resident proxy 和其他 lease。

Route lookup 必须完全由 token 决定，不得依赖“最近 route”、全局当前 Provider 或共享可变 model。

### FR-12：脱敏诊断与归因

Lease metadata 应支持下列安全字段：

```ts
interface RouteLeaseMetadata {
  leaseId: string;
  consumer: 'rasen' | string;
  runtime: 'claude' | 'codex';
  upstream: RouteLeaseUpstream; // 不含 credential
  model: string;
  createdAt: string;
  expiresAt: string;
  lastActivityAt?: string;
  status: 'active' | 'released' | 'expired';
  execution?: {
    runId?: string;
    stageId?: string;
    attempt?: number;
    sessionIdHash?: string;
  };
}
```

要求：

- GET/list 只返回 metadata；
- session id 默认只保存有域分离的 hash；
- run/stage 字段必须有长度上限并做日志安全处理；
- usage 可以归因到 consumer/run/stage/lease，但不得把 token 作为归因 id；
- prompt/request body 不进入 lease 管理日志；
- 错误消息可包含 provider/account/model 的安全标识，不包含 key/token。

### FR-13：Capability Discovery

OmniCross **应该**提供：

```text
GET /admin/api/route-leases/capabilities
```

返回版本化信息：

```json
{
  "schemaVersion": "omnicross.route-lease.capabilities/1",
  "runtimes": ["claude", "codex"],
  "upstreamKinds": ["provider", "account", "account-group", "account-pool"],
  "leaseApiVersion": 1,
  "codexAuthMode": "env_key",
  "maxTtlSeconds": 3600
}
```

Rasen 可在运行前发现不兼容 daemon，而不是在 stage 中失败。

### FR-14：保留现有产品路径

- 现有持久 Gateway API Key/GatewayBinding 必须继续服务普通外部客户端；
- 现有 `omnicross launch` 和 UI terminal launch 可以复用新的 RouteLeaseManager；
- terminal launch 仍可由 daemon 持有 lease，但创建 lease 的底层逻辑必须与进程打开解耦；
- Rasen 路径不得调用 `IntegrationManager.install()`；
- 本需求不要求删除持久 Codex/Claude integration，但必须保证 Rasen 不触碰它；
- 不使用 Route Lease 的现有请求路径不得发生行为回归。

## 6. API 契约

### 6.1 创建 lease

```http
POST /admin/api/route-leases
Authorization: Bearer <admin-control-token>
Content-Type: application/json
Idempotency-Key: rasen:run-123:ship:1
```

```json
{
  "schemaVersion": "omnicross.route-lease.request/1",
  "consumer": "rasen",
  "runtime": "codex",
  "upstream": {
    "kind": "provider",
    "providerId": "deepseek-api"
  },
  "model": "deepseek-chat",
  "execution": {
    "runId": "run-123",
    "stageId": "ship",
    "attempt": 1,
    "sessionId": "rasen-session-affinity-value"
  },
  "ttlSeconds": 600
}
```

新建返回 `201 Created`；幂等命中返回 `200 OK`：

```json
{
  "schemaVersion": "omnicross.route-lease/1",
  "leaseId": "lease-123",
  "createdAt": "2026-08-11T11:50:00.000Z",
  "expiresAt": "2026-08-11T12:00:00.000Z",
  "runtime": "codex",
  "upstream": {
    "kind": "provider",
    "providerId": "deepseek-api"
  },
  "model": "deepseek-chat",
  "launch": {
    "env": {
      "OMNICROSS_CODEX_ROUTE_TOKEN": "<ephemeral-secret>"
    },
    "extraArgs": [
      "-c",
      "model_provider=\"omnicross\"",
      "-c",
      "model_providers.omnicross.name=\"OmniCross\"",
      "-c",
      "model_providers.omnicross.base_url=\"http://127.0.0.1:8766/openai\"",
      "-c",
      "model_providers.omnicross.wire_api=\"responses\"",
      "-c",
      "model_providers.omnicross.env_key=\"OMNICROSS_CODEX_ROUTE_TOKEN\"",
      "-c",
      "disable_response_storage=true"
    ]
  }
}
```

创建响应是唯一允许返回 route token 的 API 响应。它必须 `Cache-Control: no-store`，且不得被
access log 记录 body。

### 6.2 续租

```http
POST /admin/api/route-leases/lease-123/renew
Content-Type: application/json
```

```json
{
  "ttlSeconds": 600
}
```

```json
{
  "leaseId": "lease-123",
  "expiresAt": "2026-08-11T12:10:00.000Z",
  "status": "active"
}
```

续租响应不得返回 token。

### 6.3 释放

```http
DELETE /admin/api/route-leases/lease-123
```

```json
{
  "leaseId": "lease-123",
  "released": true
}
```

重复释放：

```json
{
  "leaseId": "lease-123",
  "released": false
}
```

### 6.4 查询

`GET /admin/api/route-leases` 与单条 GET 返回第 5 节 FR-12 的 metadata。不得包含：

- route token；
- launch.env 的 secret 值；
- Admin token；
- 上游 API Key/OAuth token；
- prompt 或 request/response body。

## 7. 错误契约

错误响应必须稳定、结构化：

```json
{
  "error": {
    "type": "route_lease_error",
    "code": "upstream_not_found",
    "message": "provider 'deepseek-api' was not found",
    "retryable": false
  }
}
```

最低错误集合：

| HTTP | code | 含义 |
|---:|---|---|
| 400 | `invalid_request` | schema、字段、TTL、标识非法 |
| 400 | `runtime_unsupported` | daemon 不支持请求 runtime |
| 400 | `model_not_configured` | model 为空或不适用于 upstream |
| 400 | `format_unsupported` | ingress 到上游格式无法转换 |
| 401/403 | `control_unauthorized` | Admin 控制面认证失败 |
| 404 | `upstream_not_found` | Provider/账号/组/池不存在 |
| 404 | `lease_not_found` | lease 不存在或 daemon 重启后丢失 |
| 409 | `idempotency_conflict` | 同 key 不同 payload |
| 409 | `upstream_unavailable` | 严格上游停用、无凭证或无可调度账号 |
| 410 | `lease_expired` | 已知 lease 已过期 |
| 429 | `upstream_exhausted` | 账号池/限额策略无候选，包含安全 Retry-After |
| 503 | `daemon_not_ready` | ProviderProxy 或依赖尚未就绪 |

错误的 `retryable` 必须反映操作语义；例如 daemon 未 ready 可重试，upstream id 不存在不可自动重试。

## 8. 安全需求

1. Route Lease API 必须经过现有 Admin 认证；如果 daemon 未配置 Admin token，Rasen 集成向导
   必须警告并拒绝非 loopback endpoint。
2. 第一阶段 ProviderProxy 和 Admin API 均只允许本机访问；不得信任转发头绕过 loopback。
3. route token 只允许出现在创建响应内存、lease manager 内存和 agent child process 环境。
4. route token 必须使用不可枚举的精确查找语义，未知 token fail closed。
5. 所有 auth header 在上游调用前剥离，并由 OmniCross 重新认证。
6. 任何日志、审计、错误和 GET/list DTO 必须经过自动 secret-redaction 测试。
7. 创建响应必须 `no-store`，Admin access log 不记录 body/header secret。
8. 不得读取或写入 Codex `auth.json`、Claude credentials；不得写用户 config/settings。
9. 不得把 secret 放入 argv，因为 argv 可能被进程列表观察；secret 只进入 child env。
10. lease id 与 route token 必须是不同值；公开 lease metadata 不授予代理访问能力。

## 9. 非功能需求

### 9.1 性能

- daemon 已运行时，创建 lease 不发起上游模型请求；
- 本地 create/renew/delete 的 P95 应小于 100 ms（不含首次 daemon 启动）；
- lease 操作不得为每次请求重启 ProviderProxy；
- 至少支持 32 个并发 active leases，且查找保持近似 O(1)。

### 9.2 可靠性

- 所有 cleanup best-effort 且幂等；
- 一个 route cleanup 异常不得停止 resident proxy；
- daemon shutdown 释放所有 session/lease routes；
- fake clock 覆盖 TTL、renew、race 和 expiry；
- create 的 route 注册与 lease registry 发布必须具备失败回滚：不能留下不可管理的孤儿 route。

### 9.3 兼容性

- Windows PowerShell/直接 spawn 必须使用 argv 数组，不依赖 shell quoting；
- Codex custom-provider overrides 必须通过受支持的 `-c key=value`；
- 现有 `omnicross launch`、UI terminal launch 和持久 Gateway 不回归；
- API 使用 `schemaVersion`，未知 major 必须拒绝，兼容 minor 只允许加字段。

## 10. 建议模块边界

建议但不强制的代码结构：

```text
packages/core/src/provider-proxy/
  RouteLeaseManager.ts
  routeLeaseSchema.ts
  runtimeLaunchDescriptor.ts

packages/daemon/src/admin/
  routeLeaseApi.ts
  __tests__/routeLeaseApi.test.ts

packages/cli-launcher/src/proxy-env/
  codex-proxy-env.ts       # 改为 env_key
  claude-proxy-env.ts      # 复用 descriptor builder
```

设计原则：

- route 创建/验证/descriptor 生成位于可复用 service，不绑 Admin HTTP；
- `handleCliLaunch()` 调用 service 后再打开 terminal；
- Route Lease API 调用同一 service，但只把 descriptor 返回给受认证消费者；
- route map 保持唯一，不另建第二套 proxy/router；
- schema/DTO 放在可被 daemon 测试和未来 SDK 复用的位置；
- token-bearing DTO 与 token-free metadata DTO 使用不同类型，避免误返回 secret。

## 11. 测试要求

### 11.1 单元测试

- 所有 upstream 判别联合的 schema 与解析；
- runtime -> ingress 映射闭集；
- Codex `env_key` 的准确 TOML override 和 quoting；
- Claude descriptor 不包含上游 key；
- idempotency same/same、same/different、expired/recreate；
- TTL、renew、release、double release、shutdown cleanup；
- route token 与 lease id 不相等；
- token redaction 和 DTO 白名单；
- 不支持 transformer chain 时 fail early；
- route 注册后 registry 发布失败能回滚。

### 11.2 HTTP 集成测试

- Admin auth 和 loopback gate；
- create -> proxy request -> selected mock upstream -> release 全链路；
- 两个并发 leases 路由到不同 Provider/model；
- 释放 A 不影响 B；
- 旧 token 401 且不 fallback；
- GET/list 永不返回 token；
- `Cache-Control: no-store`；
- daemon shutdown 后 routes 清空；
- 不创建 Outbound API Key/GatewayBinding 数据。

### 11.3 真实 CLI E2E

当前 builder 测试只验证参数和本地 Proxy 合约，交付前必须补：

1. 启动真实 daemon；
2. 对本地 mock Anthropic/OpenAI-compatible upstream 创建 lease；
3. 真实 `codex exec` 通过 Responses ingress 完成一次包含 tool call 的回合；
4. 真实 `claude -p` 通过 Messages ingress 完成一次包含 tool call 的回合；
5. 验证 streaming、错误、取消、renew 和 release；
6. 比较运行前后 `config.toml`、`auth.json`、Claude settings/credentials 的 hash、mtime、size；
7. 使用用户显式提供的可计费测试账号完成一次人工 smoke，不在默认 CI 发起付费请求。

### 11.4 回归测试

- 原 `omnicross launch codex/claude`；
- UI `POST /admin/api/cli/:cli/launch` 与 stop session；
- 持久 IntegrationManager；
- Outbound Gateway Key + GatewayBinding；
- Provider Key Pool、账号组和订阅账号调度；
- Responses/Messages transformer 和 usage attribution。

## 12. 验收标准

### A. 核心行为

- [ ] 一个 daemon 启动后可以连续服务多个 Rasen stages，不重复启动 ProviderProxy；
- [ ] Rasen 能创建 Codex/Claude lease，且 OmniCross 不启动 terminal；
- [ ] 不同 lease 可以绑定不同 Provider、账号池和模型；
- [ ] planner/implementer/ship 三个 stage 可以分别走 Opus、Sonnet、DeepSeek；
- [ ] stage 完成后只销毁自身 route，daemon/router 和其他 routes 保持可用；
- [ ] 不创建持久 API Key 或 GatewayBinding；
- [ ] daemon 重启后旧 token 失效，新 lease 可用。

### B. Codex

- [ ] descriptor 使用 `env_key="OMNICROSS_CODEX_ROUTE_TOKEN"`；
- [ ] 不设置 `requires_openai_auth=true`；
- [ ] route token 不放入 `OPENAI_API_KEY`；
- [ ] 不读写 `config.toml` 和 `auth.json`；
- [ ] 真实 Codex CLI 完成 Responses + tool call E2E；
- [ ] DeepSeek/Claude 等非 OpenAI 上游经过 transformer 可被 Codex 使用，或在 lease 创建时明确拒绝不支持组合。

### C. Claude Code

- [ ] descriptor 仅包含代理 base、route token、非 secret sentinel 和模型；
- [ ] 上游凭证不进入 Claude child env；
- [ ] 不读写 Claude credentials/settings；
- [ ] 真实 Claude CLI 完成 Messages + tool call E2E。

### D. 安全与生命周期

- [ ] token 为每 lease 独立的 256-bit 随机值；
- [ ] GET/list/log/error/audit 均无 token 或上游 secret；
- [ ] create/renew/delete 经过 Admin auth 且只允许 loopback；
- [ ] 并发路由不串线；未知/过期 token fail closed；
- [ ] create 幂等，release 幂等，TTL 可确定性测试；
- [ ] 崩溃遗留 route 会自动回收。

### E. 兼容性

- [ ] 普通长期 Gateway Key/GatewayBinding 行为不变；
- [ ] 现有 terminal launch 行为不变或迁移到共享 lease service 后等价；
- [ ] 不使用 Route Lease 的 ProviderProxy 请求路径无回归；
- [ ] 全仓 typecheck、测试和 build 通过。

## 13. 不在本期范围

- 公网/远程 daemon、TLS、mTLS 和多租户租约授权；
- Rasen workflow 编辑 UI；
- Rasen Run Record 或 pipeline executor 的实现；
- 把 Rasen prompt/workspace 状态保存到 OmniCross；
- 永久保存或恢复 route token；
- Codex server-side response store；
- 自动修改用户全局 Codex/Claude 配置；
- 删除现有持久 integration 产品路径；
- 为任意未知 agent runtime 提供用户可配置 ingress。

## 14. 交付建议顺序

1. 将现有 builder 重构为“解析目标 + 注册 route + 生成 descriptor”的可复用 service；
2. 实现 RouteLeaseManager、幂等 registry、TTL 和脱敏 metadata；
3. 实现 `/admin/api/route-leases` create/get/list/renew/delete；
4. 把 Codex 临时启动认证改为专用 `env_key`；
5. 用现有 terminal launch 复用 lease service，证明没有双路由实现；
6. 完成 mock upstream 的 HTTP 集成矩阵；
7. 完成真实 Codex/Claude CLI E2E；
8. 发布版本化 capability endpoint 和 Rasen 集成说明。

完成定义：上述验收项全部通过，并能证明 **用户只配置上游，Rasen 自动获得临时下游身份与
格式转换路由，整个过程不需要手动 Binding、不会频繁启动 daemon、不会污染本机 CLI 配置。**

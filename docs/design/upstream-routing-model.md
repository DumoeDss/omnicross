# 上游直连路由模型（upstream routing model）— 设计与实施计划

> 状态：**P1–P4 已实施**（2026-09-15）；P5 部分完成，余项与回退窗口绑定（见 §5）。
> 取代「下游与路由」（GatewayBinding 手工路由聚合）作为用户可见的路由模型；
> GatewayBinding 保留为**内部派生层**，解析引擎不动。

## 1. 动机

现状要求用户理解「下游路由」这个独立聚合：端点、目标、密钥范围、模型映射、
优先级、回退全都配在路由上，同一个上游在不同端点的路由上还可能配出不同的映射。
快速上手被迫分「情况 A / 情况 B」。

新模型把用户可见概念收敛为两个：

- **上游资源**（Provider + 订阅账号/分组/池）——自带模型映射表；
- **访问密钥**——绑定一个**有序上游集合**，顺序即优先级。

三个正交关注点各归其主：

| 关注点 | 回答的问题 | 属主 | 配置位置 |
| --- | --- | --- | --- |
| 转换 | 协议格式怎么变 | 无（自动推导） | **零配置**：客户端端点 × 所选上游格式 |
| 路由 | 集合里这次用谁 | 密钥 | 密钥详情：有序上游列表 |
| 映射 | 模型名怎么翻译 | 上游 | 上游详情：名称映射表（无 = 透传原生目录） |

请求生命周期（各关注点恰出现一次）：

```
端点入口（客户端协议）
  → 密钥鉴权
  → 路由：按密钥列表顺序选上游（纯调度，不读模型名）
  → can-serve：选中的上游服务这个模型吗？不能 → 让位下一位（fallback next）
  → 映射：按该上游映射表翻译模型名（无表透传）
  → 转换：翻译协议格式
  → 上游（订阅类型永远经内部 dispatcher 中转）
```

**can-serve 的判定方式是上游类型的内在属性**，不是网关层机制：

| 上游类型 | 声明可服务名的方式 |
| --- | --- |
| BYO Provider | 映射表精确行 / 通配行；无表 = 透传（任意非空名可服务） |
| Claude 订阅 | 家族模式（`claude-*`，版本号漂移免疫） |
| Codex 订阅 | 订阅目录（codex / mini 家族，o 系列归 gpt 家族） |
| 其他订阅 | 各自目录 |

## 2. 已批准的决策台账

| # | 决策 |
| --- | --- |
| D1 | can-serve 失败 = 让位下一位（fallback next），统一，不暴露开关；要严格就只绑一个上游 |
| D2 | 未绑定上游的密钥 → 403；设置页可配新密钥默认「绑全部」或「不绑」 |
| D3 | 「绑全部」= 活引用（`mode:'all'`），密钥页显示展开后的生效清单；用户一旦手动编辑列表即坍缩为固化快照（`mode:'explicit'`） |
| D4 | 订阅上游永远经内部 dispatcher 中转（按上游类型自动接入，与路由无关） |
| D5 | kind 推导：命中映射行/通配即服务；映射表带通配行 → 未命中走通配；多条映射且无通配 → **写入端报错**要求补 `*`（派生层不猜） |
| D6 | Gemini 角色模型 = 映射表角色键（`default` / `background`）；前缀派发溶解为通配映射（o 系列特判并入匹配器），独立 dispatchMode 删除 |
| D7 | 迁移：一次性转换 + 备份 + 一个版本的回退开关；同上游跨端点映射合并为单表，同名冲突人工裁决或自动拆为第二个上游档案（同一 Provider 可重复添加 = 天然逃生门） |

## 3. 数据模型

### 3.1 密钥行（`OutboundKeyDbRow` 新增字段）

```ts
/** 密钥的上游绑定。absent = 未迁移/未决定（走 legacy 路由，兼容期语义）。 */
upstreamBinding?:
  | { mode: 'all' }                                    // 活引用：当前全部上游（D3）
  | { mode: 'explicit'; targets: GatewayBindingTarget[] } // 固化快照；空数组 = 明确不绑（403）
```

派生绑定的 priority = targets 下标（0 最优先）；id = `keyup:<keyId>:<index>:<endpoint>`
（与 `x-omnicross-binding-id` 路由锁定兼容）。

### 3.2 上游映射表（`server` 配置新增段）

```ts
/** 按「上游资源」键控的模型映射表。BYO = providerId；订阅 = 'sub:<providerId>'。 */
upstreamModelMappings?: Record<string, GatewayModelMapping[]>
```

- 行结构与今日路由 `modelMappings` 完全一致：`{ source, target, effort? }`，
  source 支持精确名与 `*` 通配（精确优先于通配），target 为裸模型 id；
- 角色键（D6）：`source: 'default' | 'background'` 两行特殊行，派生时抽出，
  投影为 gemini 端点的 default/background 模型，不参与名字匹配；
- 校验（写入端，admin API）：多条映射且无 `*` → 报错；source 空白/重复 → 报错。

### 3.3 兼容与合并（`assembleGatewayBindings`）

```ts
assembleGatewayBindings(input: {
  keys: Array<{ id; upstreamBinding? }>;
  allUpstreams: GatewayBindingTarget[];      // mode:'all' 的展开源 + 标签
  mappingsFor(target): GatewayModelMapping[] | undefined;
  legacyBindings: GatewayBinding[];          // 存量 server.bindings
}): GatewayBinding[]
```

- 有 `upstreamBinding` 的密钥 → 派生 scoped 绑定（四端点 × 每个 target）；
  **legacy 绑定中 scoped 到该密钥的全部剔除**（派生结果权威）；
- 无 `upstreamBinding` 的密钥 → legacy 行为原样（逐密钥灰度，无 big-bang）；
- 派生绑定 shape：`{ keyScope:'selected', apiKeyIds:[keyId], fallback:'next',
  modelMode: mappings?.length ? 'mapped' : 'passthrough', modelMappings }`。
  现有 `gatewayBindingToEndpointConfig` 的 generic 分支已经按
  「映射行/透传 → applySingleModel → 各端点投影」处理一切端点，kind 推导免费获得。

## 4. 为什么引擎不用改写

现有解析器内部早已是三轴分解：

- `candidateGatewayBindings` 优先级排序 = 路由（调度）；
- `routeCanServe` + `fallback:'next'` = can-serve 让位谓词；
- `modelMappings` + generic handling = 映射（含通配、effort、kind 投影）；
- 入口格式 × 目标投影的 transformer 链 = 转换。

订阅中转也一样：目标 kind 为 account\* 的绑定本就由端点管线接入 dispatcher，
**派生绑定与手工绑定同形，订阅服务（含 codex/gemini 全端点）零改动获得**。
今天直连层的 claude/kimi-only 限制源于 boundUpstream 的 messages 专用实现，
新模型不经过那条路径，限制自然消失。

已知的逐对矩阵缺口（与今日一致，不因本设计恶化）：chat → 非 claude 订阅
仍 501（v1 只做了 claude 桥）；随订阅桥扩展逐步补齐。

## 5. 实施分期与状态

| 期 | 内容 | 包 | 状态 |
| --- | --- | --- | --- |
| P1 | 核心派生层：`KeyUpstreamBinding` 类型 + `deriveKeyUpstreamBindings` / `assembleGatewayBindings` + 单测 | core | ✅ `upstreamRouting.ts` |
| P2 | 守护进程接线：映射表/默认项持久化 + admin API（`GET /upstreams`、`PUT /upstreams/:key/mappings`、`POST /keys/:id/upstream-binding`、新建密钥默认绑定）+ 变更重派生（含 providers/accounts 变更）+ 启动派生装配 + 迁移密钥的网关 403 语义与「只认派生绑定」规则 | core+daemon | ✅ `upstreamRoutingAdmin.ts` |
| P3 | UI：密钥行上游绑定摘要 + 编辑弹窗（全部/有序指定/回退旧版，含每上游映射表编辑器 ⚙）；网关页新密钥默认项；隐藏「下游与路由」页签（深链仍可达）；launch targets 改读 `liveBindings` | ui | ✅ |
| P4 | 迁移：`POST /upstreams/migrate-legacy`（幂等；映射表转换仅一次，`upstreamMigrationDone` 闸门）+ `POST /upstreams/rollback-legacy` 整体回退；legacy 路由原样保留即天然备份 | core+daemon | ✅ `upstreamMigration.ts` |
| P5 | 清理：legacy 绑定读取路径、`dispatchMode:'prefix'`、直连 boundUpstream、旧测试改写 | core/daemon/ui | ◐ 页签已隐藏、launch targets 已切换；**其余余项刻意绑定回退窗口**（D7：保留一个版本的回退能力），待迁移稳定后随 legacy 路径一并删除 |

每期独立可发布：P1 是纯新增函数；P2 起 daemon 才开始消费；P3 前 UI 不变。

实施中固化的小语义（偏离文档初稿处）：

- **迁移密钥只认派生绑定**：路由器对携带 `upstreamBinding` 的密钥过滤掉
  一切非 `keyup:<id>:*` 绑定（含 legacy all-scope），否则显式空列表会被
  旧路由兜底服务、403 语义失效；launch preflight 同步该规则。
- **空订阅池不进目录**：零账号的 account-pool 在 passthrough can-serve 下
  会黑洞任意模型名（实测打到真 Anthropic），故目录只收录 ≥1 账号的池。
- **角色键优先于名字行**（gemini）：同时配置时名字行只喂后台检测。

## 6. 测试策略

- 派生层纯函数全覆盖：all/explicit/空、priority 顺序、映射 mapped/passthrough、
  角色键抽取、通配、legacy 合并剔除、路由锁定 id 兼容；
- 路由器集成：有/无 upstreamBinding 的密钥共存、403 语义（explicit 空 + 无 legacy）；
- 迁移：存量绑定快照固化、同名冲突检测。

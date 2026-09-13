# 修复工单：codex 透传丢失 `session-id` header，上游缓存亲和失效

**日期**：2026-09-14
**严重度**：中高（静默性能退化，无功能错误，成本面损失）
**发现方式**：codex-rs 上游 #44862（2026-09-11 合入）揭示 ChatGPT 后端缓存亲和机制后，对 omnicross 透传链路做的对照审计
**审计上下文**：Elftia 设计文档 `elftia/docs/design/sol-pi-efficiency-mechanisms-integration-design.md` §4.2.2 AUDIT-5（含完整缓存成本分析背景，可选读）

---

## TL;DR

codex 客户端实际发送**连字符拼写**的 `session-id` / `thread-id` header（ChatGPT 后端推导 Responses 前缀缓存路由的权威信号），而 omnicross 的 codex 转发白名单 `CODEX_FORWARD_ALLOWLIST` 只包含**下划线拼写**的 `session_id`——真实 header 被静默丢弃，上游收不到任何会话亲和信号。经 omnicross 代理的 codex 订阅会话，前缀缓存命中率会系统性低于直连。现有测试只断言下划线拼写，对这个缺口假绿。

---

## 1. 为什么这个 header 重要（codex 上游的权威行为）

### 1.1 codex 发送什么

`codex-rs/codex-api/src/requests/headers.rs`（本地参考仓 `workflow/Reference/codex`，2026-09-14 拉取后核实）：

```rust
pub fn build_session_headers(session_id: Option<String>, thread_id: Option<String>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Some(id) = session_id {
        insert_header(&mut headers, "session-id", &id);   // ← 连字符，标准 HTTP header 名
    }
    if let Some(id) = thread_id {
        insert_header(&mut headers, "thread-id", &id);    // ← 连字符
    }
    headers
}
```

`insert_header` 直接 `name.parse::<http::HeaderName>()`，**无任何拼写转换**。现行 codex CLI 发出的就是 `session-id`（hyphen）。

### 1.2 ChatGPT 后端从 header 推导缓存亲和（#44862，2026-09-11）

commit `bc5957eac9` "Preserve parent cache affinity for ephemeral forks" 的 Why 原文：

> **ChatGPT derives Responses cache affinity from the `session-id` header.** Ephemeral forks need to reuse their parent's cache routing while retaining their own session and thread identities.

三个关键行为（`codex-rs/core/src/client.rs`，当前树 ~497-519 行）：

```rust
fn prompt_cache_key(&self, responses_metadata: &CodexResponsesMetadata) -> String {
    if let Some(prompt_cache_key) = &self.prompt_cache_key_override { return prompt_cache_key.clone(); }
    // ephemeral fork：继承父会话的缓存分片（兄弟分支保持暖的官方解法）
    if let SessionSource::Internal(source) = &self.state.session_source
        && let Some(parent_thread_id) = responses_metadata.parent_thread_id {
        return format!("{source}:{parent_thread_id}");
    }
    responses_metadata.session_id.clone()
}

// ChatGPT derives cache affinity from the Responses session-id header. Keep the
// actual session identity in turn metadata, hooks, and history/notes requests.
fn responses_session_id(&self, metadata: &CodexResponsesMetadata) -> String {
    if self.state.session_source.is_non_root_agent() { metadata.session_id.clone() }
    else { self.prompt_cache_key(metadata) }   // ← root agent 的 session-id header = prompt_cache_key
}
```

即：**HTTP 请求头和 WebSocket 握手的 `session-id` 都被 codex 显式设为亲和键**；真实会话身份移到 turn metadata。body 级 `prompt_cache_key` 字段虽然存在，但 codex 团队特意把 header 补到与它一致——header 是 ChatGPT 后端的权威信号。

### 1.3 附带事实（omnicross 已对的部分，修复时勿破坏）

- body 级：`ensureCodexPromptCacheKey`（provider-proxy 路径）在客户端未带时注入 `prompt_cache_key = "omnicross:<source>:<sessionKey>"`——**已正确**。
- `store:false`：commit `8af5955` "force store:false on codex subscription Responses relays (#50)"——**已正确**（与 codex 隐私语义一致）。

---

## 2. 诊断：omnicross 的缺口（证据链）

### 2.1 转发白名单只有下划线拼写

`packages/core/src/provider-proxy/identity/codexCliHeaders.ts:97-103`：

```ts
const CODEX_FORWARD_ALLOWLIST: ReadonlySet<string> = new Set([
  'version',
  'openai-beta',
  'session_id',   // ← 下划线！codex 现版本根本不拼这个
  'originator',
  'user-agent',
]);
```

`extractCodexClientHeaders`（同文件 109-121 行）严格按此白名单过滤 caller headers → `decorateCodexHeaders`（`responsesDriver.ts:502-516`）→ `fillMissingHeaders` 合入上游请求。**hyphen 的 `session-id`、`thread-id`（以及 `thread_id`）全部被过滤丢弃。**

### 2.2 无任何补偿机制

- 全仓 grep `'session-id'`（hyphen）：除 `matchText.ts` 的读取外零命中——**没有任何路径注入或转发 hyphen session-id**。
- `responsesAffinity.ts`：只处理 `previous_response_id` 的账号粘性，无 header 亲和逻辑。
- body 级 `prompt_cache_key` 注入**不等于** header 亲和（见 §1.2——codex 团队特意做了 header 侧）。

### 2.3 反证：内部路由读对了拼写，转发漏了

`packages/core/src/provider-proxy/matchText.ts:178`（`deriveGatewaySessionKey`，omnicross 自己的账号池亲和）：

```ts
const sessionHeader = firstHeaderValue(headers, ['session-id', 'session_id', 'x-session-id']);
//                                                                   ↑ hyphen 优先
```

内部路由**以 hyphen 为第一优先级读取**，说明拼写是已知事实；转发白名单漏掉 hyphen 属于笔误，不是设计。紧随其后的 `thread-id` 读取（185 行）同样正确——同样没有进转发白名单。

### 2.4 测试假绿

`packages/core/src/provider-proxy/identity/__tests__/codexCliHeaders.test.ts:30/85/91`：

```ts
session_id: 'sess-abc',                       // 请求 fixture 用下划线
expect(headers['session_id']).toBe('sess-xyz'); // 断言也只断下划线
```

对真实 codex 流量（hyphen）没有任何用例覆盖。

### 2.5 影响量化口径

上游亲和丢失 → ChatGPT 后端缓存路由可能按请求漂移 → 前缀缓存命中率下降。按 2026-09 前缀缓存计价（读 ≈ 0.1×、未命中全价），长会话一次本可命中的 400K token 前缀从 40K（读价）变 400K（全价），单次差 ~360K token 等价。**修复后用上游 `usage` 的 cached tokens 前后对比即可定量验证（见 §4.3）。**

---

## 3. 修复方案

### 3.1 最小修（必做）

`CODEX_FORWARD_ALLOWLIST` 增加：

```ts
const CODEX_FORWARD_ALLOWLIST: ReadonlySet<string> = new Set([
  'version',
  'openai-beta',
  'session-id',    // ← 新增：codex 实际拼写（ChatGPT 缓存亲和权威信号）
  'session_id',    //    保留：兼容仍发下划线的旧客户端
  'thread-id',     // ← 新增：codex 实际拼写（会话身份，上游一致性）
  'thread_id',     //    保留：兼容变体
  'originator',
  'user-agent',
]);
```

注意：

- `NEVER_FORWARD_HEADERS`（auth/hop-by-hop 集）不动；`extractCodexClientHeaders` 先查 NEVER 再查白名单的顺序天然保证 `authorization` 等不会被新拼写绕过。
- `fillMissingHeaders` 是「缺失才填」语义，auth strategy 已放的 headers 不会被 caller 值覆盖——低风险。
- header 值仍是客户端可控字符串，与已在白名单里的 `user-agent`/`version` 同风险等级，非新类别；但**不得**把 raw session-id 值写进日志/route activity（保持 `deriveGatewaySessionKey` 「只暴露截断 SHA-256 摘要」的隐私姿态）。

### 3.2 完整修（建议，对齐 #44862 语义）

客户端**未带** `session-id` 时（例如经 omnicross 的非 codex-CLI 调用方），把已注入的 body 级 `prompt_cache_key`（`ensureCodexPromptCacheKey` 的 `omnicross:<source>:<sessionKey>`）**同步注入 header**——把 body 级亲和补齐到 header 级，落在 `decorateCodexHeaders` 里 `fillMissingHeaders(headers, plan.callerClientHeaders)` 之后：

```ts
function decorateCodexHeaders(headers, plan) {
  if (plan.proxyProviderId !== 'codex') return;
  fillMissingHeaders(headers, plan.callerClientHeaders ?? {});
  fillMissingHeaders(headers, { accept: codexAcceptHeader(true) });
  // 新增：header 级亲和兜底（对齐 codex #44862：session-id header = prompt_cache_key）
  ensureCodexSessionIdHeader(headers, body /* 或经 plan 传入已注入的 cache key */);
  fillMissingCodexCliIdentity(headers);
}
```

需要把 `ensureCodexPromptCacheKey` 的结果（它目前返回 `{cacheKeySource, cacheKeyInjected}` 元数据）穿到 header 注入处，保持 body 与 header 的 key 值一致。

### 3.3 需要一并核对的边界

- **WebSocket 路径**（若 omnicross 代理 codex 的 Responses-over-WS）：codex 的 WS 握手同样携带 `responses_session_id()` 作为 session-id——核对 omnicross 的 WS 握手 header 构造是否同样需要白名单/注入。
- **`opencodego` 路径**的 `callerOpenCodeSession`（responsesDriver.ts ~329 行附近）是独立机制，勿动。
- **上游审计**：若 `fetchUpstream` 的 routeActivity 记录了上游 headers，确认修复后 session-id 出现在上游请求且**不落日志**。

---

## 4. 测试与验收

### 4.1 单元测试（补假绿缺口）

- `extractCodexClientHeaders`：hyphen `session-id`/`thread-id` 输入 → 转发；下划线旧拼写 → 仍转发；两者并存 → 均转发（fillMissingHeaders 语义下不冲突即可）。
- NEVER 集优先级不变（`authorization` 永不透传）。
- `decorateCodexHeaders`（3.2 完成后）：caller 未带 session-id → header 被注入且值 = 注入的 prompt_cache_key；caller 已带 → 原样保留。
- 现有 `codexCliHeaders.test.ts` 下划线用例全部保持绿。

### 4.2 集成验证

- 走一次真实/回放的 codex 订阅会话透传，在上游 fetch 层断言请求 headers 含 `session-id`。
- 同一会话连续多请求，断言 session-id 值稳定（不随请求漂移）。

### 4.3 定量验证（前后对比）

修复前后各跑同一长会话负载，对比上游响应 `usage` 的 cached tokens 占比（或 ChatGPT 后端可观测的命中指标）。预期：修复后命中率显著上升；若**无变化**，说明后端在无 header 时退回了 body `prompt_cache_key` 亲和——也值得记录结论（此时严重度降级，但修复仍是对齐上游语义的正确姿势）。

---

## 5. 参考

- codex 上游 commit：`bc5957eac9` "Preserve parent cache affinity for ephemeral forks (#44862)"，2026-09-11——`session-id` header 亲和与 fork 继承的权威出处
- codex 源码：`codex-rs/codex-api/src/requests/headers.rs`（header 拼写）、`codex-rs/core/src/client.rs` ~497-519（prompt_cache_key / responses_session_id）
- omnicross 现状：`packages/core/src/provider-proxy/identity/codexCliHeaders.ts:97`（白名单）、`responsesDriver.ts:502`（decorateCodexHeaders）、`matchText.ts:160-220`（deriveGatewaySessionKey，hyphen 优先的读取）
- 背景分析（缓存成本/亲和机制全景）：`elftia/docs/design/sol-pi-efficiency-mechanisms-integration-design.md` §4.2.2 AUDIT-5 与 `elftia/../SoL-Pi/docs/prompt-cache-dossier.md`（C-10「缓存是端点属性」）

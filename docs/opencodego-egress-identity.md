# OpenCodeGo 出站身份标识

opencode.ai 公告要求访问其 API 的代理类工具明确标识自身（不要过于笼统的 user-agent），并携带 `x-opencode-session` 请求头以便其优化提示词缓存。本文说明 omnicross 对 OpenCodeGo（`opencodego`，go/zen 两个 half）出站流量的身份处理。

## user-agent

所有发往 opencode.ai 的请求（中继流量与后台 `GET /v1/usage` 额度轮询）统一携带：

- **配置值优先**：嵌入 omnicross 的应用在 config.json 中声明自己的身份；
- **默认 `omnicross/<版本>`**：未配置时的产品缺省，版本随发版自动更新。

```json
{
  "opencodego": {
    "userAgent": "elftia/1.2.3"
  }
}
```

该值非机密，明文存取；空白或类型错误的配置折叠为未配置。配置在 daemon 启动时注入，修改后重启生效。多账号共享同一全局身份——它是"嵌入应用级"标识，不属于单个账号。

下游客户端自身的 user-agent 不会被透传：几乎所有 HTTP 客户端都会携带通用值（`curl`、`node`），透传反而会让 omnicross 隐身。

## x-opencode-session

按以下优先级发出：

1. 下游客户端带了 `x-opencode-session` → 原样透传（OpenCode CLI 直连 omnicross 时保留其会话 id）；
2. 未带 → 发送 omnicross 内部的会话亲和键（与账号池粘性路由同源）：
   - Anthropic 入口（`/v1/messages`）：按 system + 首条 user 消息锚点派生的 FNV-1a 8-hex 键；
   - Responses 入口（`/v1/responses`）：感知 `session-id`/`thread-id` 等元数据的 SHA-256 32-hex 键。
3. 两者皆无（无锚点内容）→ 不发送该头。

两种派生均为稳定的非敏感会话哈希；同一会话跨入口会出现两个值，对上游缓存亲和而言可接受。后台额度轮询无会话概念，只带 UA 不带该头。

## 生效范围

覆盖全部 OpenCodeGo 生产出站：`/v1/messages` 同格式透传（含 count_tokens）、translate/fallback 形状、`/v1/responses` native/reduced 两条分支、额度采集器。BYO provider 行即使撞名 `opencodego` 也不受影响（订阅策略不参与该路径）。管理 UI 暂不提供该配置的可视化编辑。

## 验证

`subscription-messages-boot-smoke` 端到端覆盖真实策略链路：config.json 配置 → 校验 → bootstrap 注入 → 真实 `StaticBearerAuthStrategy` 出站头；`ProviderProxy.anthropicSubscription` / `openaiResponsesSubscription` / `anthropicCountTokens` 覆盖三条中继入口的透传与派生回退。

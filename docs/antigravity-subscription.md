# Antigravity 订阅接入

Antigravity 是独立的 Google OAuth 订阅 provider，标识为 `antigravity`。它与已有 `gemini`（Gemini CLI）账号使用不同 OAuth 应用、凭据池和 Code Assist project，不能直接互换 refresh token。

## 登录与检查

```bash
omnicross login antigravity --config ./omnicross.config.json
omnicross doctor antigravity --config ./omnicross.config.json
```

CLI 授权回调地址固定为 `http://127.0.0.1:51121/oauth-callback`。端口无法监听时，可以粘贴浏览器回调 URL 或授权码；URL 中的 state 必须与当前流程匹配。管理界面提供独立 Antigravity 登录卡片，凭据由 daemon 存储，浏览器只拿到登录状态。取消后的异步授权结果不会继续新增账号。

`doctor antigravity` 默认仅检查本地凭据。显式添加 `--live` 才进行令牌刷新和额度查询；它不发送模型生成请求。配额采集失败后保留的历史窗口不会被 doctor 当作查询成功。

## 模型与路由

- 配置路由时选择 Antigravity 账号、分组或账号池。
- 目前文本接入通过 Anthropic Messages（`/v1/messages`）和 OpenAI Responses（`/v1/responses`）转换到 CCA `generateContent` / `streamGenerateContent`。Chat Completions 对非 Claude 订阅的原有入口限制仍保留；不要将它当作已验证的 Antigravity 入口。
- 静态目录提供离线候选；上游资源页调用 `GET /admin/api/accounts/antigravity/models` 合并动态发现结果，并将新模型加入路由建议。切换活动账号后重新获取目录。
- 同名静态条目优先；动态发现失败时保留静态目录。目录中的模型名只是候选，不代表当前账号拥有该模型权限。
- 元数据 `supportsImages` 表示图片输入能力，不证明图片生成能力。
- NanoBanana 绘图已随多 provider 图像 change 实现：Images API 的 `gemini-*.5/3.1-*-image(-preview)`、`gemini-3-pro-image-preview` 路由到 Antigravity 身份（见[生图功能开发文档](./image-generation-development.md) §14），Codex 图片模型可通过 `images.codex.imageModel` 切换。该实现尚无实机验证（见下方验证边界）。

## 额度与账号选择

采集器优先查询 `retrieveUserQuotaSummary`，失败时尝试 `fetchAvailableModels` 的 quotaInfo。归一化窗口携带剩余额度、重置时间、模型族和 disabled 标记。

额度调度仍由现有 allowanceScheduling 配置控制，默认关闭。启用时只用新鲜窗口；按请求实际模型族评估：Claude 额度耗尽不会误停 Gemini。disabled 标记在缓存读写后保留，单账号、严格绑定和账号池均受对应族的暂停限制。健康状态、模型支持限制与额度检查共同生效。

令牌刷新后的 project 重新握手由凭据存储层负责，覆盖后台定时刷新、按账号刷新以及请求内刷新。握手失败保留已刷新的令牌和旧 project；执行请求时仍核实当前账号的 project。project 与发送 Bearer 绑定，不能混用不同账号的 project。

## 端点与版本

默认上游为 `https://daily-cloudcode-pa.googleapis.com`。配置：

```json
{
  "antigravity": {
    "sandboxFailover": false
  }
}
```

开启后可重试错误最多切换一次到 `daily-cloudcode-pa.sandbox.googleapis.com`，默认不切换。该机制不将无权限错误伪装成成功。

客户端版本读取官方更新 manifest，成功缓存一小时，失败保留已知值并退避一分钟，初始回落版本为 `2.8.0`。更新查询走共享代理感知出口。`ANTIGRAVITY_VERSION`、`ANTIGRAVITY_CL`、`ANTIGRAVITY_OS`、`ANTIGRAVITY_ARCH` 任一显式设置都停用自动版本探测。

## 验证边界

实现和本地测试使用模拟 OAuth、配额与推理响应。不替代真实 Google 授权、账号权限、三族模型请求及 UI 实机验收；在这些步骤有真实证据前，不能宣称线上已可用。代码不会通过普通 UI 轮询触发图片生成。

图像部分（NanoBanana provider 与会话内嵌图）同样只有离线证据与单元测试覆盖；真实订阅上的三模型出图、编辑链路与客户端实测仍待补（与生图 change 的实机验证项合并推进）。

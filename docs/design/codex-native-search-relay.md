# Codex 原生搜索转发

`server.search.modes.codex = "native"` 时，`POST /v1/alpha/search` 通过当前客户端的 Responses 路由选择上游。此前该请求在路由选择前被托管搜索分支截获，选择 `native` 仍会返回 `unsupported_capability`。

## 协议依据

已核对本地 OpenAI Codex 源码，提交 `343074d420`：

- `codex-rs/codex-api/src/endpoint/search.rs`：SearchClient 在同一 provider base URL 下请求 `alpha/search`。
- `codex-rs/codex-api/src/search.rs`：请求包含 `id`、`model`、`input`、`commands`、`settings` 等字段；响应包含 `output`、可选 `encrypted_output` 和不透明的 `results`。
- `codex-rs/ext/web-search/src/tool.rs`：`id` 是会话 ID，`commands` 包含搜索、打开、查找等操作。
- `codex-rs/model-provider-info/src/lib.rs`：ChatGPT 订阅的 provider base 为 `https://chatgpt.com/backend-api/codex`。

因此，Codex 订阅的真实搜索地址为 `https://chatgpt.com/backend-api/codex/alpha/search`；自定义原生 Responses 上游则保留其 base path 和 query，使用同级的 `alpha/search`。

## 行为

- 复用 Responses 的客户端鉴权、路由绑定、模型映射、账号/密钥选择、OAuth 刷新、配额与并发限制。
- 只接受能提供原生 Responses 的路由；转换型上游返回明确的能力错误。
- 除路由要求的模型映射外，保留完整请求。搜索不注入 Responses 的 `store`、`stream` 或默认 reasoning effort。
- 使用会话头或请求 `id` 保持账号亲和性，转发安全的客户端身份头，以选中账号的凭证鉴权。
- 原样返回上游响应正文、状态码及允许的响应头，保留引用、加密输出与不透明结果。不会退回托管搜索。
- `managed` 继续使用现有托管运行时，`off` 继续返回能力关闭错误；默认模式保持不变。
- 界面增加顶部保存按钮，说明切页前需要保存、Codex 模式保存后立即生效。

## 验证

2026-09-22（Asia/Hong_Kong）：

- 20 个相关测试文件、184 项测试通过，覆盖原生请求保真、上游错误、权限、账号绑定、刷新、模型映射、取消，以及已有 Responses 和搜索界面回归。
- Core、UI 类型检查通过；Core 构建和导出检查通过。
- 使用修复后的真实 daemon 组件，在独立回环端口、临时客户端密钥下，经现有 Codex 账号组调用原生搜索：HTTP 200，响应含 `output`、`encrypted_output`、`results`。
- 继续使用搜索返回的原生引用调用 `open` 与 `find`：HTTP 200，返回网页行号和原生引用。此验证没有使用托管搜索。
- 组装后的用户目录热修复运行时也完成同一真实上游验证，并正常退出（exit code 0）。

本机安装目录受 Windows 写入权限保护，已在用户目录准备完整后端热修复，通过桌面应用支持的 `OMNICROSS_DAEMON_ENTRY` 进程环境覆盖加载。自动重启被执行审批策略拒绝后，用户选择暂不退出并保留启动脚本，原服务尚未切换。退出应用后可运行热修复目录内的 `Start-Omnicross-NativeSearch.ps1`，它会启动修复版并通过管理 API 保存原生模式。原安装保持可回退；正式版本合入前，应使用该启动脚本。

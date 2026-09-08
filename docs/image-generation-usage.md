# Omnicross 生图功能使用文档

本文说明如何在 Omnicross 0.2.0 中启用图片服务，并分别使用 Codex 内置 `image_gen` 工具和 imagegen skill 的 CLI 回退脚本。

实现细节见 [生图功能开发文档](./image-generation-development.md)。

## 1. 两种使用模式

两种模式最终都访问 Omnicross 的同一套 Images API 和同一个 Codex 订阅上游，但客户端接入方式不同。

| 模式 | 适用场景 | Codex 可见性 header | 所需凭证 |
| --- | --- | --- | --- |
| Codex 内置 `image_gen.imagegen` | 在 Codex 对话中直接生成或编辑 | 当前自定义 provider 需要 | auth helper 自动取得 Omnicross key |
| imagegen skill CLI 回退 | 明确要求 CLI/API、输出路径或脚本参数 | 不需要 | `OPENAI_API_KEY=<Omnicross key>` |

这里的 `OPENAI_API_KEY` 是 OpenAI SDK 约定的环境变量名。接入 Omnicross 时，它的值必须是 Omnicross key，而不是 OpenAI 平台 key。

## 2. 使用前提

开始前确认：

1. 已安装包含图片编辑支持的 Omnicross 0.2.0 构建。
2. 安装或升级后已经完全退出并重新启动 Omnicross。
3. 当前运行的是安装包内的新 daemon，而不是升级前仍驻留的旧进程。
4. 已登录至少一个可用的 Codex 订阅账号。
5. Outbound API 服务正在运行，默认 loopback 地址为 `http://127.0.0.1:8765`。
6. Omnicross 的“图像生成”服务已开启。
7. 客户端使用的 Omnicross key 具有所需权限。

权限要求：

- 仅直接调用 `/v1/images/*`：需要 `images`。
- Codex 持久接入或 `/v1/responses` 图片工具：需要 `responses` 和 `images`。

## 3. 推荐配置：使用 Omnicross 持久接入

安装版推荐通过 UI 生成配置，不要手工复制安装目录里的 daemon 路径。

### 3.1 开启图片服务

1. 打开 Omnicross。
2. 在上游/账号页面登录或确认 Codex 订阅账号可用。
3. 打开“API 服务”。
4. 确保本地网关已启用。
5. 在“图像生成”区域开启“启用 Images 端点”。
6. 选择固定账号、账号组或可用账号池。
7. 按需要选择 strict 或 pool 回退策略。

页面会分别显示：

- **已配置**：Images 开关已经开启；
- **实际状态**：当前账号和证据是否表明图片能力可用。

二者不是同一个概念。没有新鲜证据时，首次真实请求仍可通过安全 bootstrap 尝试上游；真实的账号拒绝会作为稳定错误返回。

### 3.2 启用 Codex 持久接入

1. 打开“集成”页面。
2. 找到 Codex 的“持久接入”卡片。
3. 点击“预览并启用”。
4. 检查目标为当前用户的 `.codex/config.toml`。
5. 应用配置。
6. 完全关闭现有 Codex 会话，再重新启动 Codex。

Omnicross 会：

- 创建或绑定一个最小权限 key；
- 确保该 key 具有 `responses` 和 `images` 权限；
- 在 `config.toml` 中配置本地 `responses` provider；
- 配置 auth helper，在需要时动态返回 Omnicross key；
- 保留用户配置的非托管部分，并支持安全移除或修复。

不要把 auth helper 打印出的 key 写入日志或提交到仓库。

## 4. Codex `config.toml`

### 4.1 Omnicross 自动生成的结构

自动配置的关键结构如下。`command` 和 `args` 取决于安装位置，应由 Omnicross 生成，不能照抄占位路径。

```toml
model_provider = "omnicross"

[model_providers.omnicross]
name = "Omnicross Local Gateway"
base_url = "http://127.0.0.1:8765/v1"
wire_api = "responses"
supports_websockets = false
http_headers = { "X-OpenAI-Actor-Authorization" = "omnicross" }

[model_providers.omnicross.auth]
command = "<Omnicross 安装版内置运行时>"
args = ["<daemon cli>", "integrations", "token", "codex", "--config", "<daemon config>"]
timeout_ms = 5000
refresh_interval_ms = 0
```

这个 header 的作用仅是满足当前 Codex 自定义 provider 的工具可见性条件，使 `image_gen.imagegen` 被注册。它不是 Omnicross key，也不参与服务端认证、账号选择、能力证据或 generate/edit 分流。

不要添加不存在的 `supports_image_generation` 一类字段，也不要把 `requires_openai_auth` 改成 `true`；后者会让 Codex 改走自己的 OpenAI 登录，而不是 Omnicross auth helper。

### 4.2 手工 key 配置

如果不使用 auth helper，可以让 Codex 从环境变量读取 Omnicross key：

```toml
model_provider = "omnicross"

[model_providers.omnicross]
name = "Omnicross Local Gateway"
base_url = "http://127.0.0.1:8765/v1"
wire_api = "responses"
supports_websockets = false
env_key = "OMNICROSS_API_KEY"
http_headers = { "X-OpenAI-Actor-Authorization" = "omnicross" }
```

在启动 Codex 的同一个 PowerShell 会话中设置：

```powershell
$env:OMNICROSS_API_KEY = "<具备 responses 和 images 权限的 Omnicross key>"
codex
```

不要同时配置 `env_key` 和 `[model_providers.omnicross.auth]`。不要把明文 key 直接写进 `config.toml`。

## 5. 使用 Codex 内置 image_gen

配置完成并重启 Codex 后，可以直接用自然语言提出图片任务。

### 5.1 文生图

```text
生成一张 Omnicross 路由核心的成年女性二次元角色立绘，靛紫与白色未来科技服装，完整全身，干净背景。将最终图片复制到 assets/generated/omnicross-character.png。
```

Codex 会调用内置 `image_gen.imagegen`，它通过当前 provider 的：

```text
POST http://127.0.0.1:8765/v1/images/generations
```

### 5.2 编辑本地参考图

```text
基于 assets/generated/omnicross-character.png 生成同一角色的正面、严格侧面和背面三视图。保持脸、发型、配色和服装结构一致。
```

Codex 应先读取参考图，再调用 edit。当前只支持一张参考图；若 prompt 或工具调用传入多张图，会返回 `unsupported_capability`。

实际请求进入：

```text
POST http://127.0.0.1:8765/v1/images/edits
```

### 5.3 继续编辑刚生成的图片

```text
基于刚才生成的图，只把背景改为透明，角色本身保持不变。
```

Codex 可以从当前对话最近的生成结果构造 edit 输入。当前生产适配器尚未开放透明背景，因此该请求会返回 `unsupported_capability`，不会用纯色背景冒充透明。

### 5.4 输出位置

Codex 内置工具默认把图片保存到：

```text
%USERPROFILE%\.codex\generated_images\<thread-id>\<call-id>.png
```

如果图片属于当前项目，应在任务中明确要求把最终产物复制到项目目录。不要让项目引用只指向 `.codex/generated_images`。

## 6. 使用 imagegen skill 的 CLI 回退

CLI 回退脚本直接使用 OpenAI Python SDK。它不会读取 Codex `config.toml` 的 provider，也不需要工具可见性 header。

### 6.1 环境变量

在运行脚本的同一个 PowerShell 会话中设置：

```powershell
$env:OPENAI_BASE_URL = "http://127.0.0.1:8765/v1"
$env:OPENAI_API_KEY = "<具备 images 权限的 Omnicross key>"
```

如果脚本运行在代理环境中，还应确保 `127.0.0.1` 不被转发到外部 HTTP 代理。

### 6.2 文生图

在 imagegen skill 目录下运行：

```powershell
python .\scripts\image_gen.py generate `
  --model gpt-image-2 `
  --prompt "一张干净的 Omnicross 角色设定图" `
  --n 1 `
  --quality low `
  --size auto `
  --output-format png `
  --out .\output\imagegen\omnicross.png
```

### 6.3 单参考图编辑

```powershell
python .\scripts\image_gen.py edit `
  --model gpt-image-2 `
  --image "E:\path\reference.png" `
  --prompt "保持角色身份与服装不变，生成三视图设定表" `
  --n 1 `
  --quality low `
  --size auto `
  --output-format png `
  --out .\output\imagegen\omnicross-turnaround.png
```

脚本本身提供的参数比当前 Omnicross 订阅适配器更宽。通过 Omnicross 使用时必须遵守当前子集：

- `--model gpt-image-2`
- `--n 1`
- 编辑只传一个 `--image`
- 不传 `--mask`
- 输入为 PNG、JPEG 或 WebP，最大 50 MiB
- 不要求图片 partial stream

`generate-batch` 可以逐项调用单图接口，但默认并发可能很快占满本地队列；批量任务应把并发降到与账号并发上限相符。

## 7. 直接调用 Images API

不使用 Codex 时，也可以用任意 OpenAI Images 兼容客户端直连 Omnicross。

### 7.1 PowerShell 文生图示例

```powershell
$headers = @{
  Authorization = "Bearer $env:OPENAI_API_KEY"
}
$body = @{
  model = "gpt-image-2"
  prompt = "A clean indigo and white futuristic character concept."
  n = 1
  quality = "low"
  size = "auto"
  background = "opaque"
  output_format = "png"
} | ConvertTo-Json

$result = Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8765/v1/images/generations" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $body

[IO.File]::WriteAllBytes(
  (Join-Path $PWD "generated.png"),
  [Convert]::FromBase64String($result.data[0].b64_json)
)
```

### 7.2 multipart 编辑示例

```powershell
curl.exe --fail-with-body `
  "http://127.0.0.1:8765/v1/images/edits" `
  -H "Authorization: Bearer $env:OPENAI_API_KEY" `
  -F "model=gpt-image-2" `
  -F "prompt=Keep the character identity and create a clean turnaround sheet." `
  -F "image=@E:\path\reference.png;type=image/png" `
  -F "n=1" `
  -F "quality=low" `
  -F "size=auto" `
  -F "output_format=png"
```

响应为 OpenAI Images 风格 JSON，最终图片位于 `data[0].b64_json`。

## 8. 验证与 doctor

本地检查不消耗图片额度：

```powershell
omnicross doctor images --config "<Omnicross daemon 使用的配置文件>"
```

它检查：

- Images 配置；
- 私有存储根；
- reference/state/evidence store；
- key 权限 schema；
- Codex 账号凭证；
- 缓存能力证据。

显式 live 验证会消耗图片额度：

```powershell
omnicross doctor images --config "<同一个配置文件>" --live
```

live verifier 会执行一次最小 PNG 生成，并把结果再执行一次 edit。两步都成功后才记录编辑能力。安装版普通用户如果没有可直接调用的 `omnicross` 命令，可以用第 7 节的最小真实请求验证当前 daemon。

当前 0.2.0 的 v2 证据只记录 live verifier 实际测试的 `quality=low`。因此运行 `--live` 后，Codex 内置 imagegen 默认提交的 `quality=auto` 可能被本地能力检查返回 `unsupported_capability`；这不表示图片上游未接通。修复证据模型前，可用第 6 节 CLI 回退或第 7 节直接 API，并显式设置 `quality=low`。

## 9. 常见问题

### `image_gen.imagegen` 在 Codex 中不可见

检查：

- Codex 是否已经完全重启；
- 当前 `model_provider` 是否为 Omnicross；
- provider 是否保留工具可见性 header；
- 是否误设了 `requires_openai_auth = true`；
- 当前 Codex 版本是否包含 image generation extension。

该 header 只影响 Codex 是否注册工具，不影响 CLI 回退或直接 Images API。

### `unsupported_capability`

常见原因：

- Images 服务未开启或当前运行时不可用；
- 传入多张参考图；
- 使用 mask；
- 请求 `n > 1`、stream 或 partial image；
- 请求选项不在当前三层能力证据的交集中；
- 请求透明背景但当前账号/协议没有对应证据。

如果错误参数是 `quality`，且此前运行过 `doctor images --live`，还应检查第 8 节所述的 v2 证据限制。

### `invalid_image_request`

检查 prompt 是否为空、字段名是否正确、`image` 与 `images` 是否同时出现、尺寸是否符合约束，以及 JSON/multipart 的字段类型是否正确。

### `image_too_large`

当前单参考图最大 50 MiB，最大 8,294,400 像素。压缩文件很小但解码像素过大时也会被拒绝。

### `unsupported_image_type`

当前参考图只支持真实可解码的 PNG、JPEG 和 WebP。修改扩展名不会改变文件的实际 MIME。

### 401 或 `invalid_api_key`

这是本地 Omnicross key 的问题。检查环境变量是否在启动客户端的同一个进程环境中、key 是否仍启用、是否已撤销，以及 loopback-only key 是否从本机访问。

### 403 或 `insufficient_permissions`

直接 Images 请求需要 `images` 权限；Responses 图片工具需要 `responses` 和 `images`。在 Omnicross 的访问密钥页面补齐权限，或重新应用 Codex 持久接入。

### `upstream_auth_required`

本地 key 已通过，但 Codex 订阅账号缺失、过期、不可调度或刷新失败。重新登录账号并检查账号选择策略。

### `subscription_usage_limit_reached` / `upstream_rate_limited`

等待订阅图片额度窗口重置或上游限流解除。不要对已经可能被接受的图片任务进行无界自动重试。

### 安装后仍提示当前环境不支持图片能力

最常见原因是旧 daemon 仍在运行。完全退出 Omnicross 和 Codex，确认旧进程结束后重新打开安装版。源码 watcher、旧安装版和新安装版不会自动热替换彼此的运行时。

## 10. 当前限制摘要

- 默认关闭，必须显式开启 Images。
- 上游仅使用 Codex 订阅账号。
- 模型为 `gpt-image-2`。
- 单次一张输出。
- 编辑单参考图、无 mask。
- 参考图 PNG/JPEG/WebP，最大 50 MiB、8,294,400 像素。
- 当前 provider 不提供公共图片流式输出。
- 远程 URL 默认禁用。
- 当前生产适配器未开放透明背景。
- 质量、格式、尺寸和响应 usage 只在真实能力证据支持时对外可用。

## 10. 多 provider 图像路由（Codex 与 Antigravity）

### 10.1 模型路由表

Images 服务的模型→provider 路由由配置段 `images.models` 决定，默认表：

| 模型 | provider | 说明 |
| --- | --- | --- |
| `gpt-image-2` | Codex 订阅 | 默认模型 |
| `gpt-image-2-5` | Codex 订阅 | 新模型就绪后零代码切换 |
| `gemini-2.5-flash-image(-preview)` | Antigravity 订阅 | NanoBanana |
| `gemini-3.1-flash-image(-preview)` | Antigravity 订阅 | NanoBanana |
| `gemini-3-pro-image-preview` | Antigravity 订阅 | NanoBanana |

请求模型先经 `defaultModel` 兜底与 `aliases` 别名归一，再查表选 provider；表外模型返回 `unsupported_model`，不会跨 provider 改路由。某个 provider 没有可用账号时，只影响路由到它的模型。`/v1/models` 列出的图像模型 = 路由键 × 各 provider 当前新鲜证据的交集。

### 10.2 Codex 线路模型覆盖

`images.codex.imageModel` / `carrierModel` 可覆盖 Codex 私有线路的图像模型与载体模型（默认 `gpt-image-2` / `gpt-5.6-luna`）。UI"图像生成"区域提供两个覆盖输入与路由表只读展示，清空输入即恢复默认。能力证据的模型维度跟随配置值记录。

### 10.3 会话内嵌图（v1）

图像模型也可直接用于会话请求（例如 `/v1/chat/completions` 的 BYO gemini 行）：请求侧自动注入 `responseModalities: ['TEXT','IMAGE']`，响应文本之外以 `message.images`（流式为 `delta.images`）携带 data URL 数组。Anthropic Messages 面不伪造协议外块：图片会被丢弃并记录计数日志。Responses 面的 `image_generation_call` 输出映射为后续工作。

### 10.4 Antigravity 侧验证状态

⚠️ Antigravity 图像 provider 目前只有离线证据与单元测试覆盖。在真实订阅上完成实机验证前，不应宣称其可用；其能力声明为 PNG-only，遇到非 PNG 实际格式会按 `upstream_protocol_changed` 报错而非静默转换。`omnicross doctor images` 已按 provider 分行展示账号状态。

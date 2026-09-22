# 火山方舟 Agent Plan

在提供商设置中选择「火山方舟 Agent Plan」预设，填入 Agent Plan 套餐专属 API Key 后保存。不要混用按量付费或旧 Coding Plan 的密钥、地址。

- 预设 ID：`volcengine-agent-plan`
- 协议：OpenAI Chat Completions
- Base URL：`https://ark.cn-beijing.volces.com/api/plan/v3`
- 请求地址：`https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions`
- 默认主模型：`ark-code-latest`（智能路由）
- 默认后台模型：`doubao-seed-2.0-mini`
- 默认视觉模型：`doubao-seed-2.1-turbo`

此预设独立于现有「火山方舟」预设，不修改其标准 API 或 Coding Plan 配置。内置模型列表及已声明的上下文、输出长度和图片输入能力来自[官方 Pi 接入文档](https://ark.volcengine.com/region:cn-beijing/docs/ark/agent-plan-personal-pi?lang=zh)；实际可用模型以账号订阅套餐为准。官方未声明的模型能力不额外推断。

本次接入覆盖聊天模型接口，不包含套餐的图片或视频生成工具；这些能力需要另外接入相应工具或 MCP。

修改源码后需重新构建并启动对应版本，才能在界面中看到新预设。自动化测试覆盖预设映射、请求地址、保存、密钥掩码和热加载；未使用真实套餐密钥验证上游推理。

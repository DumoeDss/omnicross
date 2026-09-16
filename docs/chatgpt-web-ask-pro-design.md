# ask_pro — ChatGPT Pro 作为 Codex 的 MCP 外脑（设计）

> 2026-09-14 立项，同日实现完成（单测 27 项 + 真浏览器 UI 点验 PASS；**实机安装 + 真实咨询实测未做**，见 §7）。
> 配套：`docs/chatgpt-web-handoff.md`（主线交接）、`docs/chatgpt-web-harness-findings.md`（harness 排障）。
> 用户已拍板：做「老师模式」+「Pro 自主干活」；**不做硬指挥**（MCP 无嵌套工具语义，codex 等 MCP 结果期间阻塞，Pro 的工具调用无法透明路由回 codex 执行）。

## 1. 一句话

codex 用**原生小模型**干活，通过一个 stdio MCP server（`ask_pro` 工具）把问题抛给 ChatGPT Pro；
Pro 在自己的浏览器回合里**可以调用本地工具**（connector → tunnel → broker 按 turn_token 路由），
但执行者从 codex 换成了 ask-pro server 自己 —— 它就是 `/v1/responses` 的 HTTP 客户端，
走已被验证的两阶段协议（`scripts/chatgpt-web-harness-roundtrip.ts` 即其原型，Pro 档已跑通）。

```
codex（原生 provider，任意小模型）
  │ MCP tools/call: ask_pro({question})
  ▼
ask-pro server（~/.omnicross/chatgpt-web/ask-pro/server.mjs，stdio MCP，node 起的独立进程）
  │ POST /v1/responses（model=chatgpt-web/pro，Bearer=bridge-token）
  ▼
桥（harness 模式）→ Pro 浏览器回合（connector 已挂载，prompt 带 turn_token）
  │ Pro 调 codex_shell(turn_token, argv)
  ▼
connector → tunnel-client → mcpServer → broker（按 turn_token 找到回合）
  ▼
ask-pro server 收到 function_call SSE ──▶ 本地执行（默认只读 allowlist）
  │ 后续请求带回 function_call + function_call_output（可多轮）
  ▼
Pro 续流 → 最终答案 → MCP 工具结果 → codex 小模型继续干活
```

关键不变量：**中间链路（connector/tunnel/mcpServer/broker）零改动**；回路执行者 = `/v1/responses`
的 HTTP 客户端，broker 只认 turn_token（`tunnel/broker.ts`），worker 的续流判定只看 history 里的
`function_call_output`（`bridge/worker.ts`）。

## 2. 边界与不做的

- **不能与 `codex --profile chatgptweb` 叠加**：prompt 编译器不渲染 codex 的 `tools` 数组（模型只能
  调 connector 的 codex_shell/codex_apply_patch），且 worker 是单 harness 回合槽，嵌套请求 429。
  正确姿势 = codex 原生 provider + ask_pro MCP 外挂（恰是本功能的目标形态）。
- **apply_patch v1 不实现**：Pro 调到会收到 isError 输出（v1 是只读顾问）。
- **硬指挥不做**（用户拍板）。软指挥天然可用：Pro 返回指令文本，小模型照办。
- **并发**：ask-pro server 单飞（busy 时立即报错，不排队——codex 的 tool_timeout_sec 从调用起算，
  排队会白烧超时）；且全局同一时刻只能有一个 harness 回合（UI 启动的桥上若 codex-on-bridge 正
  parked，ask_pro 到达会把它 retire——见 worker.ts「stale live turn」路径，属已知设计约束）。

## 3. 安全模型（默认只读）

ask-pro 执行 Pro 的命令**在 codex 沙箱与审批流之外**，直接以用户身份跑。缓解：

- 默认 `readonly`：argv 级 allowlist（纯函数 `checkReadonlyCommand`，充分单测）
  - `git` 仅只读子命令（status/log/diff/show/branch/blame/rev-parse/ls-files/ls-remote/remote/tag/
    reflog/describe/shortlog/name-rev/grep/cat-file/show-branch/merge-base、`stash list`、
    `worktree list`、`config --list/--get*`；支持前置全局 flag `-C/--no-pager/-c/...`）
  - 文件读取/探测类：cat head tail wc grep findstr rg fd ls dir tree sort uniq file stat du pwd
    echo which where type diff comm cut date basename dirname realpath
  - `find` 拒绝 `-delete/-exec*/-ok*/-fprint*/-fls`
  - 显式拒绝会写文件的解释器/文本处理：awk、sed（都能写文件）、node/python/powershell/npm…
  - Windows builtin（type/dir/ver）仅经 `["cmd","/c",<builtin>,...]` 包装放行，且其余参数禁止
    shell 元字符 `< > | & ^ %`
  - 可执行文件解析只走 PATH（**跳过 cwd**，防工作区里的同名 .bat/.cmd 影子逃逸），只接受
    .exe/.com，绝对路径同样受 allowlist 约束
- `--writable` 逃生口（自担风险，装好后可改 config）；命令超时默认 30s（schema 可调，上限 120s）；
  输出截断 64KB
- codex 侧对 ask_pro 这个 MCP 调用本身仍受其审批策略管（交互模式下逐次批准）

## 4. 落点（文件地图）

| 层 | 文件 | 内容 |
|---|---|---|
| chatgpt-web | `src/askpro/askProCore.ts` | allowlist、SSE 累积器、consultPro 主循环、`resolveAskProServerEntry()` |
| chatgpt-web | `src/askpro/askProServer.ts` | stdio MCP 入口（entry guard，import 不触发 main——坑 #20 教训） |
| chatgpt-web | `src/bridge/server.ts` | `/healthz` 加 `harness: boolean`（ask-pro 前置探测用） |
| chatgpt-web | `tsup.config.ts` | 拆成两个 build 配置：库入口双格式（ESM+CJS，**必须无 import.meta**）；独立子进程入口（`tunnel/mcpServer`、`askpro/askProServer`）**ESM-only 且 splitting:false**——esbuild 会把 import.meta 原样留在 CJS 里（require 即崩），而 askProServer 必须内联 askProCore 保持单文件自包含（安装是整文件拷贝） |
| daemon | `src/admin/chatgptWebCodexProfile.ts` | 托管段引擎抽取 + `[mcp_servers.omnicross-chatgptweb-pro]` upsert/remove + 安装胶水（拷 server.mjs 到 `~/.omnicross/chatgpt-web/ask-pro/`） |
| daemon | `src/admin/chatgptWebApi.ts` | `POST ask-pro/install`、`POST ask-pro/uninstall`、status 加 `askPro` |
| daemon | `src/commands/chatgpt-web.ts` | `chatgpt-web ask-pro install/uninstall/status` 子命令 |
| ui | `features/chatgpt-web/` | 向导页新增「Pro 外脑」卡（装/卸/状态/说明） |

安装产物稳定在 `~/.omnicross/chatgpt-web/ask-pro/server.mjs`（**拷贝**而非引用 dist 绝对路径——
桌面 app 升级会换 daemon-runtime 目录，写死 dist 路径会悄悄失效）。config.toml 里
`command = "node"`（codex 自身就是 npm 装的，node 必在 PATH），args 指向稳定路径，
`tool_timeout_sec = 660`（codex 0.154 二进制确认存在该 per-server 字段；ask 内部 deadline 600s）。

## 5. MCP 工具面（单工具）

```
ask_pro({question: string})
```

description 明示：无跨调用记忆（每次是新会话，question 必须自包含全部上下文）、慢（数十秒到
数分钟）、Pro 可只读检查工作区。服务器参数：`--bridge-base-url`（默认 17850）、
`--bridge-token-file`（默认 bridge-token）、`--model`（默认 chatgpt-web/pro）、`--writable`、
`--deadline-ms`、`--log-file`。支持 MCP `notifications/cancelled` 中止当次咨询。

## 6. 错误面（MCP isError 文本，给小模型读的）

- `bridge-down`：桥没起 → 指引 UI 启动
- `harness-off`：桥在跑但非 harness 模式 → 指引重启
- `busy`（HTTP 429）：另一 harness 回合占用
- `turn-failed` / `http`：浏览器回合/桥错误（含桥的 error envelope 文本）
- `rounds-exceeded` / `deadline`：附已产出部分文本
- readonly 违规**不是**咨询失败：作为 isError 工具输出回给 Pro，让它在同一回合里改道（换
  allowlisted 命令），这是刻意选择

## 7. 验证阶梯（对应交接文档 §3 风格）

1. ✅ 单测：allowlist 决策表、SSE 累积器（含 custom_tool_call / adapter_eof park）、
   consultPro 对本地 mock 桥（两轮 function_call→输出→completed、429/失败/超轮/只读违例/
   apply_patch 拒绝）、profile 托管段 upsert/remove、安装胶水（mock HOME，验证拷贝 + 段写入 +
   外来配置不动 + 干净卸载）；合计新增 27 项（chatgpt-web 16 + daemon profile 11 − 原有 4 重构）
2. ✅ 构建产物冒烟：直接 node 起 dist/askpro/askProServer.js —— initialize / tools_list /
   tools_call(bridge-down 错误映射) 全对；import 无副作用（entry guard 生效）；单文件自包含
   （仅 node 内建 import）
3. ✅ 真浏览器 UI 点验（vite dev + 自有 Electron + CDP）：Step 7 卡片渲染、i18n 三语言 key、
   安装按钮可点、未安装时卸载隐藏
4. ⛔ **实机安装 + 真实咨询实测**（待做）：UI「安装 ask_pro」或 CLI → 桥 harness 模式起跑 →
   原生 codex 会话（非 chatgptweb profile）给一个需要查 repo 的任务 → 观察它调 ask_pro →
   Pro 只读跑命令 → 小模型拿到建议。浏览器侧遵守「单次尝试、失败即停」
5. 已知先决关系：ask_pro 依赖的是**模拟回路已验证的那一侧**（HTTP 客户端执行者，75ca72a），
   与 handoff §9.1 的「真 codex × harness」互补、不互相阻塞

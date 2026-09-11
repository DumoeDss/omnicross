# ChatGPT Web Bridge — Session Handoff

> 交接文档（2026-09-11）。分支 `feat/chatgpt-web-bridge`，基于 main。
> 目标读者：接手继续开发的下一个 session。读完后从「下一步」开始。

## 1. 项目目标

在 omnicross 中集成 **ChatGPT Web（含 Pro 档）作为 Codex 的模型后端**：

- 参考实现：`E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\codex-chatgpt-web`（MIT，~31k 行，Electron 内嵌浏览器驱动 chatgpt.com）
- 我们的实现：新包 `packages/chatgpt-web`（private，不发布）+ daemon 命令 `omnicross chatgpt-web`
- 三层能力：browser-only（Pro 纯对话）→ full harness（tunnel+MCP 本地工具）→ Electron 专用宿主（隔离浏览器）

## 2. 架构总览

```
Codex ── -c model_provider=omnicross-chatgptweb ──▶ 桥 (loopback /v1/responses, SSE)
  桥 ── CDP ──▶ 浏览器宿主（二选一）
      chrome: 用户日常 Chrome 的调试端口（9222）
      electron: 专用 Electron 子进程（独立 profile, ~/.omnicross/chatgpt-web/）
  桥（harness 模式）──▶ tunnel-client（官方 openai/tunnel-client v0.0.12）
      └─ spawn 我们的 stdio MCP server 子进程（codex_shell / codex_apply_patch）
      └─ ChatGPT connector "Codex Native2"（用户已建好）经 tunnel 调 MCP 工具
  工具回路：ChatGPT→MCP→broker→桥发 function_call SSE→Codex 执行→下一请求带
  function_call_output→broker 解除阻塞→MCP 结果回 ChatGPT→同一浏览器回合续流
```

关键模块（packages/chatgpt-web/src/）：
- `cdp/` — CDP 连接层（discovery/websocket/connection/target）。`targetFactory` 选项支持 Electron（其 browser 端点拒绝 Target.createTarget）
- `browserHost/` — Electron 专用宿主（electronHost.ts + main.cjs）。main.cjs 起 loopback 控制端点（/new-target /close-target），端口写 `<dataDir>/host-control.json`；每个"标签"是一个隐藏 BrowserWindow，真实 CDP target id 通过 /json/list 差集发现
- `chatgpt/` — 选择器、能力探测（effort 滑块档数=账号档位）、回合执行（turn.ts browser-only / harnessTurn.ts 两阶段挂起续流）、markdown 流式 buffer、快照脚本
- `bridge/` — Responses 请求解析、prompt 编译（JSON envelope + 契约）、ocx1 压缩、SSE 编码（含 function_call 帧、heartbeat、stall 超时）、HTTP 服务器、worker（路由/延续识别/并发）
- `tunnel/` — tunnel-client 管理（下载+SHA256、connect 写配置、`run` 常驻守护）、broker（TCP+token）、mcpServer（stdio JSON-RPC 子进程）、harnessConfig（~/.omnicross/chatgpt-web-harness.json）

daemon 侧：`packages/daemon/src/commands/chatgpt-web.ts`（check/login/launch/harness 子命令）。

## 3. 验证状态矩阵（务必区分"验证过"和"没验证过"）

| 能力 | 状态 | 证据 |
|---|---|---|
| CDP 连用户 Chrome + 登录探测 + 能力探测 | ✅ 真实验证 | 账号识别 Sol+Pro（滑块 5 档） |
| browser-only 完整回合（短 prompt） | ✅ 真实验证 | check --smoke PASS 多次 |
| 大 prompt 插入（4.5KB/12KB 精确回读） | ✅ 真实验证 | insert-check 脚本 PASS |
| 桥直连完整回合（light 档 ×2） | ✅ 真实验证 | round-trip 脚本 PASS |
| **codex 端到端（light 与 Pro 档）** | ✅ 真实验证 | `CODEX BRIDGE OK` / `PRO BRIDGE OK`（含"Pro 思考"状态捕获） |
| tunnel 全链路（connect+run 常驻+healthy/ready） | ✅ 真实验证 | tunnel status 全绿 |
| MCP 子进程协议（initialize/list/call 往返） | ✅ 真实验证 | mcp-smoke 5/5（含 replyTo 修复） |
| harness 浏览器回合（@mention→挂起→续流） | ⛔ 未验证 | 需 connector+tunnel 活着时跑（被风控打断） |
| Electron 宿主窗口显示 | ✅ 真实验证 | 根因 `windowsHide:true`（b44f52b）；A/B 实验枚举 HWND visible=True，用户肉眼确认窗口+example.com |
| Electron 内 example.com 加载 | ✅ API 层验证 | 隐藏 tab 中 body 文本读回正常 |

## 4. 当前卡点（按优先级）

### 卡点 A：Electron 宿主窗口不显示 —— ✅ 已解决（2026-09-11 17:00）

- **根因**：`electronHost.ts` spawn electron.exe 时 `windowsHide: true` → STARTUPINFO 带 `STARTF_USESHOWWINDOW/SW_HIDE`，Electron 尊重它，**所有** BrowserWindow（含 `show:true` 的标签窗口）都变成"真实存在、有坐标、已加载、但永远 invisible"的 HWND
- **验证方法（可复用）**：Win32 `EnumWindows` 枚举 electron 进程顶层窗口，对照 `IsWindowVisible`/标题/rect。A/B：仅翻转该标志 → `visible=True`；用户肉眼确认窗口出现且打开 example.com。修复 commit `b44f52b`
- 旧假设全部证伪：**不存在会话隔离**（qwinsta 只有一个交互会话，Claude 与用户同在 session 1/同一桌面）；"句柄=0" 也是该 bug 的表象
- **协作铁律（继续有效）**：所有需要"看见窗口"的步骤必须用户自己跑；Claude 每次让用户跑 Electron 相关命令前必须先 `taskkill /F /IM electron.exe` 清锁

### 卡点 B：chatgpt.com 对该出口 IP 的新客户端做连接级风控

- 现象：用户日常 Chrome 同代理可开 chatgpt.com；CDP 标签页与 Electron 全新 profile 访问 → `ERR_CONNECTION_CLOSED`（TLS 层 RST，页面都没加载）。example.com 同一 Electron 秒开（对照实验已做，排除本地因素）
- 处置：换代理出口节点，或冷却数小时。用户人工登录不受影响
- 历史诱因：当日大量自动化试错（codex 5 连重试 × 多轮）触发过人机验证

### 卡点 C（次要）：codex 仍显示 "Model metadata not found" 警告

`/v1/models` 已改为原生 `{"models":[…]}` 且补了 `shell_type: "unified_exec"`（93b8b4a 之后），但 codex 对该警告可能缓存旧响应；回合功能不受影响。可让用户重启 codex 会话后观察是否消失。

## 5. 用户侧已完成的一次性配置

- **harness 配置**：`~/.omnicross/chatgpt-web-harness.json`（tunnel id `tunnel_6aa334eb…` + runtime key，已脱敏要求用户事后轮换 key——key 曾出现在聊天记录）
- **ChatGPT connector**：用户已在 chatgpt.com 建好 `Codex Native2`（Tunnel 类型、认证无、允许所有操作）。入口在繁中界面「外挂程式」页；开发者模式已开
- **Chrome 调试端口**：9222 常开（DevToolsActivePort 存在）
- **系统代理**：127.0.0.1:10808（v2ray/clash 类），Electron 走系统代理验证过（example.com 通）
- **账号**：ChatGPT **Pro**（Sol 选择器 5 档：Instant/Medium/High/Extra High/Pro）
- **Node**：v24.15.0（原生 WebSocket 可用）；日常 shell 为 PowerShell

## 6. 常用命令速查

```powershell
cd E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\omnicross

# 测试与构建
npx vitest run packages/chatgpt-web            # 63 tests
npx tsc -p packages/chatgpt-web/tsconfig.typecheck.json --noEmit
npx tsc -p packages/daemon/tsconfig.typecheck.json --noEmit
npm run build -w @omnicross/chatgpt-web        # tsup；main.cjs 复制到 dist/browserHost

# daemon 命令（tsx 从源码跑）
npx tsx packages/daemon/src/cli.ts chatgpt-web check [--smoke]
npx tsx packages/daemon/src/cli.ts chatgpt-web login            # Electron 宿主登录（用户自己跑！）
npx tsx packages/daemon/src/cli.ts chatgpt-web launch --model chatgpt-web/pro
npx tsx packages/daemon/src/cli.ts chatgpt-web launch --browser-host=electron --harness --model chatgpt-web/pro
npx tsx packages/daemon/src/cli.ts chatgpt-web harness status

# 诊断脚本（scripts/）
chatgpt-web-insert-check.ts [--size=12]   # 单次插入+回读验证（不发送）
chatgpt-web-round-trip.ts                 # 单次完整回合（不经过 codex，无重试风暴）
chatgpt-web-harness-roundtrip.ts          # harness 单发（带工具）
chatgpt-web-harness-bridge.ts             # 保活 harness 桥（KEEP_ALIVE_MINUTES env，默认 20）
chatgpt-web-page-probe.ts                 # 单页状态（URL/composer/正文）
show-electron-page.ts [url]               # Electron 宿主开可见页（用户自己跑！Ctrl+C 关）
diag-electron-host.ts                     # 宿主握手检查
diag-electron-net.ts                      # 宿主内 example.com vs chatgpt 对照
diag-electron-visibility.ts               # 页面可见性/坐标探针
mcp-smoke.mts                             # MCP 子进程协议冒烟

# 清理（让用户跑 Electron 前必须做）
taskkill /F /IM electron.exe
Remove-Item ~\.omnicross\chatgpt-web\DevToolsActivePort, ~\.omnicross\chatgpt-web\host-control.json -ErrorAction SilentlyContinue
```

## 7. 踩过的坑（下个 session 必读，勿重蹈）

1. **win32 spawn EINVAL**：npm/codex 的 `.cmd` shim 不能直接 spawn（Node≥20）。已建立模式：npm 走 `npm-cli.js`（node 安装目录旁 `node_modules/npm/bin/npm-cli.js`）+ `process.execPath`；codex 走 shim 内引用的 JS 入口（`resolveWindowsJsEntry` 解析 `"%dp0%\…\bin\….js"`）
2. **tunnel-client 0.0.12**：`runtimes connect` 只写 profile+探测一次就退出；常驻必须 `run --config <profile.yaml>`（桥已托管，tree-kill）。mcp-command argv 拒绝 secret 样式内容且子进程环境被清洗 → broker secret 走私有文件（`--broker-secret-file`，路径 argv 安全）
3. **Electron CDP**：browser 端点 `Target.createTarget` 返回 Not supported；`webContents.id` ≠ CDP targetId（用 /json/list 差集）。窗口隐藏时 Radix 菜单是否响应未验证（参考实现称 hidden 可行）
4. **ChatGPT DOM 契约**（已修的模式，UI 变更时照此排查）：send-button/effort 控件存在多份布局拷贝 → 必须 scope 到 composer 所在 form 取最后一个可见；composer 回读必须按顶层子节点 join('\n')（裸 textContent 丢换行）；插入前先清空（残留单字符即回读失败）；大文本插入后 Lexical 异步接管需页内轮询回读（≤10s）
5. **回合完成判定**：完成帧（text+copy action+非 running）即终局——完成后 ChatGPT 会重渲染替换 `data-turn-id` 元素，等待"稳定窗口"会永久错过
6. **codex 重试风暴**：回合失败若回 5xx，codex 重连 5 次 × 每次开新浏览器页（用户极度反感）。前置/配置类失败必须回 400（codex 不重试 4xx）
7. **模型目录 schema**：codex 0.154 要求 `{"models":[…]}` 且必含 `shell_type`（值域 `shell_command|unified_exec`），缺字段整个目录解码失败
8. **工具调用序列化**：空参数必须 `"{}"` 不能 `""`（codex 回放 JSON.parse("") 会 400 毒化会话）；apply_patch 走 custom_tool_call（freeform，input 解包）
9. **会话/进程管理**：Claude bash 后台任务会被会话清理连带杀死（GUI 闪退的来源之一）；Electron 单实例锁会被残留实例长期占据。诊断脚本 finally 里 `process.exit(0)` 会吞异常——catch 必须先打印
10. **Python heredoc 改 TS/JS 文件**：`\\n` 会被解释成真实换行注入源码（本 session 因此坏过 3 个文件）。**优先用 Edit 工具**；用 python 时 split 用 `/\r?\n/` 这类正则字面量而不是 `'\\n'`
11. **Chrome 后台标签页吞掉合成 Input 事件**（需 bringToFront）；fetch guard（Fetch.failRequest 拦调试端口探测）已内置
12. **风控敏感**：失败重试连环触发人机验证/连接级 RST。任何浏览器侧验证坚持"单次尝试、失败即停、本地分析后再动"
13. **spawn GUI 进程绝不能 `windowsHide: true`**（win32）：它把 `SW_HIDE` 写进 STARTUPINFO，Electron/Chromium 据此让所有窗口永不显示（进程活、页面加载、API 说 visible，屏幕上就是没有）。诊断此类问题用 Win32 EnumWindows 看 `IsWindowVisible`，别信 DOM 的 visibilityState。附带发现：`harness.test.ts` 导入 `mcpServer.ts` 会触发其顶层 `main()` 的 process.exit（vitest 报 unhandled error，63 测试本身全过），待后续把 main() 改成显式 entry 检测
14. **Google 登录拦截（accounts.google.com "此浏览器或应用可能不安全"）的两层坑**：(a) 裸跑 `electron main.cjs` 的 UA 带 `Electron/39.2.0` token，直接被拦；(b) 只删该 token 变成**裸 Chrome UA** 也不行——client hints（`navigator.userAgentData` / `Sec-CH-UA`）诚实地只报 `Chromium` 无 `Google Chrome` 品牌，UA 与 hints 不一致被判定为伪造 UA，照样拦。**正确形态 = Chromium 基底 + 自家产品 token**（参考实现 `app.setName("Codex Web GPT")` 打包后就是这个形态，在此网络+账号上验证可过）。修复（2e10cff）：UA = `<chromium 基底> OmniCross/<包版本>`，hints 不动。诊断用 `scripts/diag-electron-clienthints.ts`（本地 listener，不发外部请求）。若仍被拦（CDP/debug-port 检测），备选：邮箱验证码/passkey 登录（完全绕开 Google），或交互登录窗口不起 debug port

## 8. 提交历史（本分支，新→旧）

```
b44f52b fix(chatgpt-web): spawn Electron host without windowsHide   ← 卡点 A 根因修复
31bddb3 fix(chatgpt-web): drop disableHardwareAcceleration from the Electron host
e21a398 fix(chatgpt-web): visible tabs on demand + standalone demo script
4c5e4f5 fix(chatgpt-web): Electron host tab lifecycle + control endpoint hardening
e2ee26d fix(chatgpt-web): blank-window hardening for the Electron host   ← 后两项后被证明是误诊
5c95cac fix(chatgpt-web): debug port + proxy for the Electron host
7a3bc72 fix(chatgpt-web): spawn npm via npm-cli.js on win32 (.cmd shim EINVAL)
c2d05e2 feat(chatgpt-web): dedicated Electron browser host + login flow
b832e9e docs(chatgpt-web): accurate tunnel setup URLs in the harness checklist
52b86a4 feat(chatgpt-web): full harness — tunnel + MCP local-tool loop (phase 2)
93b8b4a fix(chatgpt-web): native codex models shape; shim-first spawn; bridge-leak guard
e63e855 fix(chatgpt-web): scope send click to the composer form; re-click once on no-evidence
f54fad8 fix(chatgpt-web): clear composer before insert; add single-attempt diagnostics
e096347 feat(chatgpt-web): experimental ChatGPT Web (incl. Pro) bridge for Codex over CDP
```

（另有后续小提交：models shell_type / preflight-400 / login 命令 / target factory / stale-port mtime 等，见 `git log feat/chatgpt-web-bridge --oneline`）

## 9. 下一步任务清单（建议顺序）

1. **[卡点 A 已解决]** 用户自己跑 `npx tsx packages\daemon\src\cli.ts chatgpt-web login` 在 Electron 宿主里登录 ChatGPT（主窗口当前标题「开始使用 | ChatGPT」= 未登录；本机当前能连通 chatgpt.com，风控未发作）→ 之后 `check` 能力探测应显示 Sol+Pro
2. **[卡点 B]** `chatgpt-web launch --browser-host=electron --model chatgpt-web/light` 跑 browser-only 回合（Electron 宿主首验；chatgpt.com 此刻可达，可直接试，失败即停）
3. harness 浏览器端联调：`launch --browser-host=electron --harness --model chatgpt-web/pro` + `scripts/chatgpt-web-harness-roundtrip.ts`。重点观察 @mention 菜单选择（attachConnectorMention 的行匹配未实战过）
4. 提醒用户轮换 platform API key（已暴露于聊天记录）
5. 收尾：`/v1/models` 警告确认消失；`harness status` 接入 tunnel 活状态；README 补 Electron 宿主章节；考虑把 `rasen/` spec 流程补上（实验特性，转正前）
6. 转正评估后：UI 设置页（Control Panel）、daemon 常驻集成、发布流程（包目前 private）

## 10. 环境速查

- 仓库：`E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\omnicross`；参考实现在同级 `codex-chatgpt-web`
- Windows 11 / PowerShell 为主 / Node 24.15.0 / codex-cli 0.154.0（npm 安装，无 .exe）
- Chrome 调试端口 9222；系统代理 127.0.0.1:10808
- 数据目录：`~/.omnicross/chatgpt-web/`（bin/tunnel-client.exe、browser/（Electron 运行时）、DevToolsActivePort、host-control.json）；harness 配置在 `~/.omnicross/chatgpt-web-harness.json`
- Electron 版本：39.2.0（按需 npm 装到数据目录，核心包零依赖）

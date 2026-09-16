# ChatGPT Web Bridge — Session Handoff

> 交接文档（2026-09-14 全面刷新；同日晚间增量：ask_pro）。分支 `feat/chatgpt-web-bridge`。
> 目标读者：接手继续开发的下一个 session。读完从「§9 下一步」开始。
> 配套深读：`docs/chatgpt-web-harness-findings.md`（harness 排障全记录）、`docs/chatgpt-web-ask-pro-design.md`（Pro 外脑设计与实现状态）。

## 1. 项目目标与现状一句话

把 **ChatGPT Web（含 Pro 档）做成 Codex 的模型后端**：桥 + 专用 Electron 浏览器宿主 + tunnel/MCP 本地工具回路 + 桌面端配置页 + codex 一键 profile；外加 **ask_pro**（Pro 作为 codex 的 MCP 外脑，小模型咨询、Pro 只读查库）。
**当前状态：核心链路全部真实验证通过（含 harness 工具回路），桌面 UI 已上线（含打包），codex profile 已交付，ask_pro 已实现（单测+构建冒烟+真浏览器 UI 点验，实机实测未做）；差「真 codex × harness 工具回路」与「ask_pro 实机」两项实测。**

## 2. 架构总览

```
Codex ─┬─ codex --profile chatgptweb（推荐；一次性写入的托管 profile，90590b6）
       └─ codex -c model_provider=… + env_key（daemon 生成的完整命令，见 UI 复制块）
     ──▶ 桥 (127.0.0.1:17850 /v1/responses, SSE；持久 token：~/.omnicross/chatgpt-web/bridge-token)
  桥 ── CDP ──▶ Electron 专用宿主（~/.omnicross/chatgpt-web/，main.cjs 控制 /new-target /close-target /login-state /shutdown）
  桥（harness）──▶ tunnel-client v0.0.12 ──▶ chatgpt.com connector "Codex Native2"
       └─ spawn stdio MCP server（codex_shell / codex_apply_patch）── broker（turn_token 路由）
  工具回路：ChatGPT 调工具 → connector → tunnel → MCP → broker → 桥发 function_call SSE
       → Codex 本地执行 → function_call_output → broker 解除挂起 → 同一浏览器回合续流
  ask_pro（Pro 外脑，2026-09-14）：codex（原生 provider + 小模型）──MCP──▶ ask-pro server
       （~/.omnicross/chatgpt-web/ask-pro/server.mjs，自包含单文件）──/v1/responses──▶ 桥
       （harness 模式）；Pro 的工具调用原路回到 ask-pro server 自己执行（默认只读 allowlist），
       再以 function_call_output 续流 —— 执行者=HTTP 客户端，中间链路零改动。设计全文见
       docs/chatgpt-web-ask-pro-design.md
  桌面端：packages/ui 独立页「ChatGPT 网页」（#/chatgpt-web，六步向导 + 可选 Step 7 ask_pro）
       ──/admin/api/chatgpt-web/*──▶ daemon admin/chatgptWebApi.ts（状态聚合/配置保存/
       登录窗口/登录检查/桥生命周期/codex profile 写入）
```

关键文件地图：
- `packages/chatgpt-web/src/`：`cdp/`（连接层，targetFactory 支持 Electron）、`browserHost/`（electronHost.ts + main.cjs；**stopExistingElectronHosts 定点清理**）、`chatgpt/`（选择器、effort 档位、turn.ts / harnessTurn.ts 两阶段）、`bridge/`（parser/编译/SSE/worker/server）、`tunnel/`（tunnelClient/broker/mcpServer/harnessConfig）、`askpro/`（askProCore.ts 引擎 + askProServer.ts stdio MCP 入口，均带 entry guard）
- `packages/daemon/src/admin/chatgptWebApi.ts` — UI 的全部后端；`chatgptWebCodexProfile.ts` — codex profile + ask-pro mcp_servers 段写入（TOML 幂等编辑器共用引擎，纯函数已单测；安装拷贝 server.mjs 并动态 import 自检）
- `packages/ui/src/features/chatgpt-web/` — 页面 + hook；`daemon/chatgptWebAdapter.ts` + `types-chatgpt-web.ts`
- `scripts/chatgpt-web-*.ts` — 单发验证脚本族（round-trip / harness-roundtrip 等）

## 3. 验证状态矩阵（区分"验证过"和"没验证过"）

| 能力 | 状态 | 证据 |
|---|---|---|
| CDP 连用户 Chrome + 登录/能力探测（Sol+Pro 5 档） | ✅ | check 多次 PASS |
| browser-only 完整回合（chrome 与 electron 宿主） | ✅ | `ROUND TRIP OK`（含 electron） |
| codex 端到端 browser-only（light + Pro） | ✅ | `CODEX BRIDGE OK` / `PRO BRIDGE OK` |
| Electron 登录（CDP-less 窬口） | ✅ | 用户两台机器真实登录成功 |
| tunnel 全链路 + MCP 协议 + broker | ✅ | 全绿 + mcp-smoke 5/5 |
| **harness 工具回路（模拟工具输出）** | ✅ | 2026-09-12 Pro 档 exit 0：connector 挂载→Pro 调 codex_shell→function_call 两阶段→续流→精确答案（75ca72a） |
| 桌面 UI 页（向导/动图/灯箱缩放） | ✅ 代码层 | 类型/测试/构建全绿；灯箱缩放经真实浏览器 CDP 实测 PASS；**整页在打包版 app 里未逐项点验** |
| codex profile 写入 + `--profile` 切换 | ✅ 代码层 | 单测 4/4（TOML 幂等）；**实机 `codex --profile chatgptweb` 未跑**（用户可能正在验） |
| ask_pro 引擎（mock 桥全回路） | ✅ 代码层 | 单测 16 项：allowlist 决策表 / SSE 累积器（含 park）/ 两轮工具应答 / 429 / 只读违例 / apply_patch 拒绝 |
| ask_pro 构建产物 + UI | ✅ 代码层 | dist 直跑 MCP 冒烟三连全对、import 无副作用；UI Step7 真浏览器（vite+Electron+CDP）点验 PASS |
| ask_pro 安装胶水（mock HOME） | ✅ 代码层 | 单测：拷贝+段写入+外来配置不动+干净卸载；**实机 ~/.codex/config.toml 未写入** |
| **真 codex × harness 工具回路** | ⛔ **未验证** | 大项之一：模拟版过了，等真实 codex 会话执行 function_call |
| **ask_pro 实机（安装 + 真实咨询）** | ⛔ **未验证** | 大项之二：UI/CLI 安装 → 原生 codex 调 ask_pro → Pro 只读跑命令 → 小模型拿建议 |

## 4. 当前无阻塞卡点；遗留已知问题

1. **多机共用**：tunnel-id/runtime-key 无机器绑定，可顺序复用；但 (a) 每台机器要各自登录（profile 本地）；(b) **同时只能一台跑桥/tunnel**（工具调用会路由到错误机器的 broker + 实例交叠打架）；切机前先「停止桥」。
2. **新机器首跑慢属正常**：tunnel 状态探测 30s 超时、就绪等待 120s（7e7d7e7 已放宽）；tunnel-client 从 GitHub 下载，弱网下载失败页面上有红色徽章+重试按钮。
3. **风控（低频复发）**：chatgpt.com 对全新 profile/IP 偶发连接级 RST（白屏）——重试/冷却即可，与 electron 进程数无关。坚持"单次尝试、失败即停"。
4. codex "Model metadata not found" 警告（`/v1/models` 已原生 shape；可能缓存旧响应，不影响功能）。

## 5. 用户侧配置（两台机器）

- 主机（Sayo 主力机）：全部就绪——harness 配置、`Codex Native2` connector、Chrome 9222、系统代理 127.0.0.1:10808、ChatGPT **Pro**（Sol 5 档）、Node 24.15.0
- 新机器（2026-09-14 部署）：已登录、已跑通基本流程
- `~/.codex/config.toml` 有我们托管的 `[profiles.chatgptweb]` + `[model_providers.omnicross-chatgptweb]`（标记注释分隔）；token 在用户环境变量 `OMNICROSS_CHATGPT_WEB_TOKEN`（setx 写入，旧终端不可见）
- ⚠️ **runtime key 至今未轮换**（曾暴露于聊天记录）——见 §9

## 6. 常用命令

```powershell
cd E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\omnicross

# 检查
npx vitest run packages/chatgpt-web packages/ui          # 343 tests（daemon 侧 admin 测试另跑）
npx tsc -p packages/chatgpt-web/tsconfig.typecheck.json --noEmit
npx tsc -p packages/daemon/tsconfig.typecheck.json --noEmit
npm run build -w @omnicross/chatgpt-web    # ⚠️ 改 src 后必做（daemon 走 dist，见坑 #15）
npm run build -w @omnicross/ui

# daemon CLI（tsx 从源码）
npx tsx packages\daemon\src\cli.ts chatgpt-web check [--smoke]
npx tsx packages\daemon\src\cli.ts chatgpt-web login      # 用户自己跑（看得见窗口的操作）
npx tsx packages\daemon\src\cli.ts chatgpt-web launch --browser-host=electron --harness --model chatgpt-web/pro
npx tsx packages\daemon\src\cli.ts chatgpt-web harness status
npx tsx packages\daemon\src\cli.ts chatgpt-web ask-pro install [--model chatgpt-web/pro] [--writable]
npx tsx packages\daemon\src\cli.ts chatgpt-web ask-pro uninstall|status   # 写 ~/.codex/config.toml 托管段 + 拷 server.mjs

# 验证脚本
npx tsx scripts\chatgpt-web-round-trip.ts --host=electron [--model=chatgpt-web/light]
npx tsx scripts\chatgpt-web-harness-roundtrip.ts --host=electron [--model=chatgpt-web/pro]  # 两阶段含模拟工具应答
npx tsx scripts\mcp-smoke.mts

# Electron 清理（绝不 taskkill /IM electron.exe！）
# 代码里用 stopExistingElectronHosts()；手动等价 = PowerShell 按 we 的二进制完整路径过滤后 Stop-Process

# 桌面 app
npm run dev -w @omnicross/ui        # 前端 dev（配合 tauri dev）
cd apps\desktop; npm run dev        # tauri dev（自动 build:daemon，用 workspace dist，改动即时生效）
cd apps\desktop; npm run build      # 出正式包（stage-daemon 重建全部 workspace → tauri build）
```

## 7. 协作规约（用户确认过的偏好）

1. **需要"看见窗口"的步骤由用户自己跑**；让用户跑 Electron 相关操作前先用定点清理（不是 taskkill /IM）。
2. **风控敏感**：浏览器侧任何验证单次尝试、失败即停、本地分析后再动。
3. UI 改动要求**真实浏览器实测**后再交付（灯箱缩放那次教训：Tailwind preflight 钳制在代码审查里看不出来）。可用自有 Electron + `--remote-debugging-port` 起 vite dev 页面用 CDP 驱动验证。
4. UI 文案/交互要"一步一事"，外部操作给直达链接，能一键的不要让用户抄命令。
5. resume 按 provider 过滤（用户实测确认）——跨后端续会话不可行，所以做了 profile 一键切换；这是设计共识，别试图绕。

## 8. 踩过的坑（必读；细节证据见 findings 文档）

1. **win32 spawn EINVAL**：npm/codex 的 .cmd shim 不能直接 spawn；npm 走 npm-cli.js，codex 走 resolveWindowsJsEntry
2. **tunnel-client 0.0.12**：常驻要 `run --config`；mcp-command argv 拒绝 secret → broker secret 走私有文件
3. **Electron CDP**：browser 端点拒绝 Target.createTarget（用 targetFactory）；webContents.id ≠ CDP targetId（/json/list 差集）
4. **ChatGPT DOM 契约**：控件多份布局拷贝须 scope 到 composer form；回读按顶层子节点 join('\n')；插入前清空；Lexical 异步接管需轮询回读
5. **回合完成判定**：完成帧即终局，等"稳定窗口"会永久错过
6. **codex 重试风暴**：非 5xx 不重试 → 前置/配置类失败回 400
7. **模型目录**：codex 要求 `{"models":[…]}` + `shell_type`
8. **工具序列化**：空参数必须 `"{}"`；apply_patch 走 custom_tool_call
9. **进程管理**：Electron 单实例锁会被残留实例占据（startElectronHost 已自愈重试）；脚本 finally 的 process.exit(0) 吞异常
10. **别用 Python/heredoc 改 TS 文件**（换行注入）；PowerShell 内联 node -e 的引号转义极易坏——**用 Edit 工具**
11. **合成输入开不了 @-mention 菜单**（CDP/Playwright 全不行，真人可以）→ connector 挂载走 `+` 菜单点击路径（详见 findings §0 最终配方）
12. **ChatGPT 幽灵草稿**：未发送草稿会异步恢复进新标签 → 回合开始清空 + 稳定窗口
13. **`+` 菜单长列表虚拟化**：连接器行来自独立目录异步加载 → 15s 耐心轮询；菜单是 body 级 portal（行匹配别 scope 到 form）；发送首击偶被吞 → 2.5s 自动重点
14. **杀 Electron 绝不按镜像名**（2026-09-14 事故）；stopExistingElectronHosts = /shutdown 优雅 + 按完整路径定点杀
15. **daemon 从包名导入的是 dist**：改 chatgpt-web src 必须 rebuild（症状：脚本过、daemon 报 not a function）
16. **Tailwind preflight `img{max-width:100%}` 会静默钳制任何 >100% 的图片放大**（灯箱缩放失灵真凶）；`cn()` 不做 tailwind-merge → 覆盖组件内置类要用 `!important` 后缀（`!max-w-6xl`）
17. **Tauri 里 `<a target=_blank>` 无效**：外链必须 openExternal（shared/tauri/openExternal）
18. **首跑机器 tunnel 状态探测 10s 不够**（admin 初始化慢）→ 30s；就绪等待 120s
19. **tunnel-client 下载源是 GitHub releases**：弱网慢/失败要有 UI 态和重试；桥启动守卫"下载中拒绝启动"
20. **win32 spawn GUI 绝不 windowsHide:true**（窗口永不显示，EnumWindows 诊断）；~~mcpServer import 即 process.exit~~（已修：entry guard）
21. **esbuild CJS 产物会原样保留 `import.meta`**（require 即崩且构建不报错）——chatgpt-web 的 tsup 拆成两配置：库入口双格式必须无 import.meta；被 node 直接 spawn 的入口（mcpServer/askProServer）ESM-only；askProServer 还要 splitting:false 保持单文件自包含（安装=整文件拷贝到 ~/.omnicross，装时动态 import 自检兜底）
22. **heredoc 里写 Windows 反斜杠路径会被传输层吃掉一层**（`\\`→`\`，`\n` 变真换行）——坑 #10 的 bash 变体：复杂脚本一律 Write 工具落文件再 node 跑，或用正斜杠路径
23. **mcp_servers 是全局的**（codex 每个会话都会拉起）：ask-pro 安装必须 opt-in（UI 按钮/CLI），不能随 profile 顺手写

## 9. 下一步（建议顺序）

1. **[最优先] 真 codex × harness 工具回路**：UI 启动桥（pro）→ 新终端 `codex --profile chatgptweb` → 给个需要跑命令的任务 → 观察 function_call 由 codex 真实执行。用户未验（2026-09-14 确认）。
2. **ask_pro 实机验证**（代码已就绪，见 `docs/chatgpt-web-ask-pro-design.md` §7）：UI Step 7「安装 ask_pro」（或 CLI）→ 桥 harness 模式跑着 → **原生 provider 的** codex 会话（不是 chatgptweb profile，两者不能叠加）→ 给个需要查 repo 的任务 → 小模型应调 ask_pro → Pro 只读跑命令 → 返回建议。注意 codex 对 MCP 工具调用有审批门；一次咨询 10s-数分钟属正常。
3. **打包验证收尾**：打包已成功（2026-09-14）；新包 UI 逐项点验只完成了代码层 + dev 环境真浏览器（ask_pro Step 7）；打包版整页逐项点验仍待做。
4. **轮换 runtime key**（暴露过）：platform.openai.com 新建 key → UI「重新配置」；多机各一份拷贝，更要换。
5. Zero Risk 模式（参考实现的伪造回执 + 人工执行）——用户未拍板，属于"可选吸收"。
6. 收尾：`/v1/models` 警告确认；README 补 Electron 宿主 + ask_pro 章节；诊断脚本收敛（harnessTurn 里 turn-starting/tab-opened/plus-menu-items 等临时诊断择机瘦身）；ask_pro 后续可选项：--writable 模式的 UI 开关、apply_patch 执行器、跨调用会话记忆；考虑吸收参考实现的 compaction/检查点。
7. 转正评估：daemon 常驻集成（桥随应用生命周期，而非页面上手动启停）、发布流程（包 private）。

## 10. 环境速查

- 仓库：`E:\…\omnicross`；参考实现同级 `codex-chatgpt-web`（MIT，它的集成方式是**接管 openai_base_url 并事务还原**；我们是加法式 profile——设计对比见 git 历史讨论，用户选了加法式）
- Windows 11 / PowerShell / Node 24.15.0 / codex-cli 0.154+（npm 装，无 .exe）
- 主机：Chrome 9222 常开；系统代理 127.0.0.1:10808；数据目录 `~/.omnicross/chatgpt-web/`（bin/browser/DevToolsActivePort/host-control.json/bridge-token）；harness 配置 `~/.omnicross/chatgpt-web-harness.json`
- Electron 39.2.0（按需装到数据目录）；tunnel-client v0.0.12
- 桌面 app：dev 用 workspace dist（改动重启 dev 即生效）；安装版用 daemon-runtime 快照（必须 `apps/desktop; npm run build` 重打包）
- 测试基线：chatgpt-web 79（+16 askpro，且 mcpServer 噪音修复后 0 unhandled error）/ ui 280 / daemon admin 85（profile 10→11，含 ask-pro 胶水）；daemon 全量有一个**既有**失败（ImageRuntimeGenerationFactory，main 上同样失败，非本分支引入）

## 11. 提交历史（本分支关键提交，新→旧）

```
【未提交】feat: ask_pro — ChatGPT Pro as a Codex MCP advisor（2026-09-14 晚：引擎/入口/安装胶水/
          admin API/CLI/UI Step7/i18n×3/mcpServer entry-guard 修复/tsup 双配置；27 新单测；
          真浏览器 UI 点验 PASS。工作区另有无关未跟踪文件 codex-meter-*.json/md，别动）
90590b6 feat(daemon,ui): one-time codex wiring — persistent token + managed profile
1f43d39 fix(ui,daemon): working lightbox zoom + a codex command that actually runs
7e7d7e7 fix(chatgpt-web): first-run tunnel readiness + zoomable guide lightbox
31722b7 feat(ui): animated step guides on the ChatGPT Web page + lightbox
6ae90f7 feat(ui,daemon): ChatGPT Web page as a real setup wizard
6cfb419 fix(chatgpt-web): never kill electron by image name
061383d/e690708 feat(ui,daemon): ChatGPT Web 页面首版（六步向导前身）
75ca72a feat(chatgpt-web): full harness tool loop verified end to end   ← harness 里程碑
4e9ab7b/9c28c97/4dc003e …            ← harness 排障链（+菜单挂载/幽灵草稿/发送重点）
f6f5fbd/b1317de …                    ← 文档节点
（2026-09-11 之前的完整列表见 git log；另有两次 origin/main 合并 5c51cbc/53818f6）
```

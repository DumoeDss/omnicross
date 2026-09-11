# Harness Connector Attach — Findings (2026-09-11 深夜)

> 今晚 harness 联调的完整战报。已证实的事实、死路、遗留谜题与下一步。
> 配套代码：harnessTurn.ts 的 `attachConnectorViaPlusMenu`（+ 菜单挂载）。

## 1. 已证实（有实验支撑）

- **tunnel 全链路绿**：`tunnel ok/healthy/ready`，connector `Codex Native2`（用户已把名字从 "ctunnel" 改为 `Codex Native2`，与 harness 配置一致）
- **@-mention 打字路径已死**（对合成输入）：
  - 极简 CDP keyDown/char、Playwright 级完整事件（Shift+Digit2、code/vk/modifiers）、CDP `Input.insertText`、**Playwright 本尊的键盘**（pressSequentially，连到 Electron 实测）——全部打不开 @ 应用弹窗
  - 用户**手打** `@` 能开（日常 Chrome，普通对话）；四种合成事件在你 Chrome 里也全灭
  - 结论：不是事件保真度问题（Playwright 也失败），是 ChatGPT 对合成输入的 @ 触发做了识别（机制未知）
- **`+` 菜单路径可用且已自动化**（探针 2/2 + harness 真实流程 2 次 `connector-attached`）：
  - `+` 按钮 = composer form 内 aria-label「添加…」/ add/attach/plus 的按钮
  - 点开 → 菜单列出应用（含 **Codex Native2**，搜索框、图片、深度研究等）
  - 点行（最小 innerText<300 匹配）→ composer 出现 pill `[data-id^="plugin:"]` keyword=`Codex Native2`
- **temporary chat 的 `+` 菜单不列 connector**（对照实测）→ **harness 回合必须用普通对话**（`CHATGPT_PLAIN_CHAT_URL`，参考实现为同样问题做"个性化"切换舞步，我们直接绕开）
- **发送对照实验**：普通对话 + pill + 短文本，提交成功（URL 变 `/c/<id>`、user turn 出现、无弹窗）——pill 不阻碍提交

## 2. 死路（别再走）

- 改 UA 形态解决登录墙后，@ 菜单和 UA 无关（Playwright/Chrome/Electron 三处全灭）
- `bringToFront`/可见窗口/焦点/`visibilityState` 均不是 @ 菜单不开的原因（隐藏 tab 里 `vis=visible focus=true` 照样不开；可见窗口还测出 `vis:hidden` 异常）
- 合成事件补充 keypress/code/keyCode 没用（事件流录制显示 CDP keyDown+text 已产生完整 keydown/keypress/beforeinput/input，全 trusted）

## 3. 遗留谜题（下次首先查）

### 谜题 A：envelope 先于挂载出现在 composer

- 现象：`turn-starting` → （无任何中间 diag）→ `attach-entry` 时 **composer 已含完整 prompt envelope**（截图+DOM 双确认），而代码顺序是 attach → insert，insert 只有一处调用点
- 已埋探针：`turn-starting` 后立刻 `tab-opened: {url, text}`（openTab 返回后、navigate 前检查）——下次复现即知是**宿主 `/new-target` 返回了脏窗口**（怀疑 main.cjs 的 target 差集把主窗口误判为新窗口：主窗口页面 target 若注册晚于 before 快照，diff 会返回主窗口 id）还是中间步骤写入
- 若确认脏窗口：修 main.cjs `/new-target`（diff 前等待主窗口 target 注册稳定，或改为用 `tabWindow.webContents.id` 与 /json/list 的 `webSocketDebuggerUrl` 关联）

### 谜题 B：`+` 菜单偶尔不开（flaky）

- 前三次 run 挂载成功，之后开始失败；已做修复：行匹配**限定 composer form 子树** + 排除 `aside/nav` + **前缀匹配**（旧的全文档"包含"匹配会命中侧边栏里旧 harness 对话的预览文本——envelope 里含 "Codex Native2" 字样，点了还会导航走）
- 修复后未再成功跑通（见谜题 C），需要冷却后重验

### 谜题 C：频率限制（今晚最终状态）

- 最后一次 run 连 composer 都不出（预检失败）。今天该 profile 上创建了几十个新会话+密集菜单操作——典型的限流特征
- **冷却数小时或明天再试**；重试前先手动开一次 chatgpt.com 确认页面正常

## 4. 其他修复（今晚顺手）

- 发送定位：composer 选取加**非空过滤**（prompt 在里面；空的是失效布局副本），send 按钮取 form 内**第一个**可见（"取最后"在普通对话点中失效副本，点击无效果）
- `+` 挂载失败自动截图 `tmp-attach-fail.png`（注意 `Page.captureScreenshot` 在该宿主上间歇 30s 超时）
- roundtrip 脚本/harness turn 大量诊断点（attach-entry/tab-opened/失败带现场）

## 5. 下次清单（按序）

1. 冷却后：`npx tsx scripts\chatgpt-web-harness-roundtrip.ts --host=electron` 一次
2. 若谜题 A 复现：看 `tab-opened` 探针 → 修 `/new-target` 差集
3. 若挂载 flaky 复现：截图在手，按菜单真实 DOM 调 row 匹配
4. 全绿后：接入 codex 真跑（`launch --browser-host=electron --harness --model chatgpt-web/pro`）
5. 收尾：去掉/收敛临时诊断、README、转正评估

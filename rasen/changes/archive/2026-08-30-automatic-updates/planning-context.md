# Planning Context

## 用户原始需求

> 给omnicross加上启动后自动检测更新功能（通过github的版本号，另外注意要采用异步，如果连接不上就跳过，不要卡住用户的启动与使用），在设置中增加自动下载更新的选项，可以自动下载。可以参考elftia的自动更新功能： E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\elftia。创建worktree和开发分支，完成后提pr到main。

## 已知约束与交付要求

- 在独立 worktree `E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\omnicross-auto-update` 和分支 `feat/automatic-updates` 上开发；基线为最新 `origin/main`。
- 启动后的更新检测必须异步、非阻塞；GitHub 不可达、超时或返回错误时静默跳过，不影响启动和正常使用。
- 版本来源为 GitHub 发布版本；需要明确版本比较、发布资产选择与平台兼容策略。
- 设置页增加“自动下载更新”选项并持久化；开启时发现更新后可自动下载，关闭时仍可检测并给用户可操作的更新提示。
- 参考项目只读：`E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\elftia`。
- 必须补充与风险相称的测试，完成独立审查与修复循环，最后提交、推送并创建目标为 `main` 的 PR。

## 当前事实

- Omnicross 是包含 `apps/desktop` 的 TypeScript/Tauri monorepo。
- 主工作区已有用户未提交改动；本变更不得复制、覆盖或回滚这些改动。
- Rasen pipeline 为 `small-feature`，Gate policy 为 `off (global)`；所有角色解析为 Codex native（Tier A）。

## Planner 调研补充

- Omnicross 的桌面入口位于 `apps/desktop/src-tauri/src/lib.rs`；窗口显示与守护进程 `spawn_blocking` 已分离，更新检查应作为另一条延迟的 Tauri async 任务加入，不能被 setup/daemon 生命周期 await。
- 桌面设置的现有权威落点是 `<app_config_dir>/ui-settings.json`（`ui_settings.rs`），新增字段可通过 serde 缺省值兼容旧文件；React Settings 只通过 Tauri command 读写。
- 2026-08-24 查询到最新公开 GitHub Release 为 `v0.1.9`；资产包含常规 Windows/macOS/Linux 安装包但没有 `latest.json` 或 `.sig`，因此仅加运行时检查不足以实现安全自动下载，发布流水线必须同时签名并汇总多平台 manifest。
- 参考 Elftia 的延迟 fire-and-forget、中心化状态、手动路径与永不自动安装值得沿用；其 `autoUpdateEnabled=false` 会连启动检查一起禁用，不符合本变更“始终检测、开关只控制下载”的语义。
- 选择 `tauri-plugin-updater` 作为外部 GitHub/签名 adapter，并在原生 `UpdateManager` 深模块中统一超时、并发、平台、安全与错误可见性；渲染端只消费快照/事件和少量命令。

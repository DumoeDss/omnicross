# Omnicross 仓库工作规则

## 桌面安装包内容

- 每次打包、修改打包脚本、增加或升级生产依赖时，都要检查安装包是否夹带测试、fixtures、benchmark、覆盖率结果及开发缓存。`npm install --omit=dev` 不会移除生产依赖发布包中自带的这些文件。
- 正常打包使用仓库根目录的 `npm run build:app`，或 `apps/desktop` 下的 `npm run build`。依赖安装后必须经过 `prune-daemon-runtime.mjs` 清理和 `verify-daemon-runtime.mjs` 检查；保留 Tauri 的 `beforeBundleCommand`，确保直接 `tauri bundle` 和 CI 也会检查。
- 清理规则维护在 `apps/desktop/scripts/prune-daemon-runtime.mjs`。只能删除审查过的明确包路径；扫描发现未知测试目录或文件时，先确认用途，再补充清理规则。运行时必需的同名资源应记录精确路径及保留理由，禁止用宽泛通配符盲删。
- 必须保留运行入口、exports 指向的文件、类型声明、许可证、私有 Node 和目标平台的 Sharp 原生依赖。不得通过关闭检查或临时覆盖打包钩子绕过问题。
- 打包后核对最终安装器文件清单，确认清理规则确实生效；交付时记录版本、路径、大小、SHA256 和已执行的检查。
- 默认重新生成 daemon 和 UI 产物。复用编译产物前，必须确认相关源码、依赖及构建配置未变化，并说明复用依据，避免新安装器夹带旧代码。

打包流程和手动检查命令见 [桌面端 README](apps/desktop/README.md#runtime-content-gate)。

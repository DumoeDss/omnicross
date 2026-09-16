# README 截图

这些图片由各语言 README 的「界面截图」区引用（相对路径 `screenshots/<name>.png`，
从 `docs/README.*.md` 解析；根目录 `README.md` 用 `docs/screenshots/<name>.png`）。

## 文件名约定

主截图区（两列表格，按此顺序）：

| 文件名 | 页面 |
| --- | --- |
| `overview.png` | 总览 |
| `dashboard.png` | 仪表板（用量统计） |
| `upstreams.png` | 上游与路由 → 上游资源 |
| `routes.png` | 上游与路由 → 下游与路由 |
| `access-keys.png` | 网关 → 访问密钥 |
| `integrations.png` | 集成（Code CLI） |

正文内联占位（可选，见各 README 中的 `📷` 标记）：
`quickstart-*.png` · `overview-nav.png` · `upstreams-provider-add.png` ·
`upstreams-routes.png` · `codecli-launch.png`

## 拍摄建议

- 统一窗口宽度（建议 1440px 左右）与主题，六张图观感一致；
- 2x 分辨率导出，GitHub 上缩放后仍清晰；
- 用 PNG；单张控制在 500 KB 以内，避免仓库膨胀；
- **发布前检查有无敏感信息**：API Key、访问密钥明文、账号邮箱、真实用量金额。
  访问密钥页截图前请先收起「查看密钥」，或对密钥串打码。

## 多语言

界面语言跟随控制面板设置。若只准备一套图，建议用英文界面，各语言 README 共用；
需要分语言时按 `<name>-<locale>.png` 命名（如 `overview-zh.png`），并在对应 README 中引用。

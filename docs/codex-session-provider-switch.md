# Codex Session 更换 Provider 恢复指南

当 Codex CLI 报错：

```text
failed to load configuration: Model provider `旧 provider` not found
```

只修改目标 `.jsonl` 往往不够。Codex session 可能是 fork 出来的，恢复时还会读取父 session；同时本地 SQLite 状态库的 `threads.model_provider` 也会参与 TUI bootstrap。

## 处理原则

1. 关闭所有 Codex CLI/TUI，再修改 SQLite。
2. 先备份目标 JSONL、所有父 session 和 SQLite 数据库。
3. 沿 `forked_from_id` / `history_base.thread_id` 追溯完整父链。
4. JSONL 只处理精确的 provider 字段，不要全局替换旧 provider 字符串。旧字符串可能出现在对话、命令输出或日志里。
5. SQLite 只更新目标 session 和它的父链，不要批量修改所有旧 provider session。
6. 不要根据示例中的字段数量硬编码替换次数；同一个 session 可能包含多条 provider 设置事件。

## 1. 找到 session ID 和父链

目标 ID 通常就是 JSONL 文件名最后的 UUID。也可以读取第一行确认：

```powershell
$sessionFile = 'C:\Users\Sayo\.codex\sessions\2026\09\08\rollout-....jsonl'
$firstLine = Get-Content -LiteralPath $sessionFile -TotalCount 1 -Encoding UTF8
($firstLine | ConvertFrom-Json).payload.session_id
```

读取每个 session JSONL 第一行的 `payload`：

- `session_id`：当前 session。
- `forked_from_id`：父 session。
- `history_base.thread_id`：需要读取的历史基线。

从目标 session 开始反复查找父 ID，直到没有父 session。目标文件、每个父文件都属于恢复链，不能只修改目标文件。

## 2. 备份文件

对每个 JSONL 使用独立备份名：

```powershell
if (-not (Test-Path -LiteralPath "$sessionFile.bak")) {
    Copy-Item -LiteralPath $sessionFile -Destination "$sessionFile.bak"
}
```

SQLite 应使用 SQLite 自己的备份功能，避免遗漏 WAL 中的已提交数据：

```powershell
$sqlite = 'C:\path\to\sqlite3.exe'
$stateDb = 'C:\Users\Sayo\.codex\state_5.sqlite'
$stateBackup = 'C:\Users\Sayo\.codex\state_5.sqlite.provider-switch.bak'

if (Test-Path -LiteralPath $stateBackup) {
    throw 'Backup destination already exists; choose a new backup name'
}
& $sqlite $stateDb ".backup '$stateBackup'"
```

备份完成后确认文件存在，再继续修改。

如果 `.bak` 已经存在，先比较大小或哈希确认它确实对应当前源文件；旧的或大小明显不符的备份不要覆盖，也不要直接复用。可以使用带日期或操作名的独立备份名。

## 3. 清理 JSONL 中的 provider 标记

常见字段有：

```json
"model_provider":"旧 provider"
"model_provider_id":"旧 provider"
```

在常见 session 格式中，字段可能位于：

- `session_meta.payload.model_provider`
- `thread_settings_applied.payload.thread_settings.model_provider_id`

实际事件类型可能不同；本次目标 session 中，`model_provider_id` 出现在多条 `event_msg.payload.thread_settings` 记录里。因此要解析 JSON 后按属性名定位全部结构化字段，不要假定只有一条，或只按事件类型筛选。

如果目标 provider 是当前默认 provider，可以删除这些字段，让恢复过程使用当前配置。如果需要明确切换到另一个 provider，则将字段值改成该 provider 的配置 ID。

明确切换到 `omnicross` 时，保留字段，只改已确认是 JSON 属性的值。对紧凑 JSONL 可以使用以下形式；处理带空格的格式时保留中间的空白捕获组：

```powershell
# $text 必须是已经确认只包含结构化事件字段的一行 JSONL
$text = $text.Replace(
    '"model_provider":"sss"',
    '"model_provider":"omnicross"'
)
$text = $text.Replace(
    '"model_provider_id":"sss"',
    '"model_provider_id":"omnicross"'
)
```

上面的替换只能对已经确认的结构化 JSONL 行执行；如果旧字符串也可能出现在消息文本中，应使用 JSON 解析或仅匹配未转义的属性 token，而不是对整个文件执行 `Replace('sss', '')`。对超大文件建议逐行读入、写入同目录临时文件，验证完成后再原子替换。

修改后必须逐行解析 JSONL，并用严格 UTF-8 读取；确认没有解码错误、意外 BOM 或未闭合 JSON。若文件原文已经包含字面 `U+FFFD`（原始字节是合法的 `EF BF BD`），记录修改前后的数量并原样保留，不要把它当作对话文本去清洗；只有严格解码本身失败时才使用备份恢复后重新处理。只要某一行 JSON 解析失败，也应使用备份恢复该文件后重新处理。

## 4. 更新 SQLite session 状态

先查看目标和父链在数据库中的 provider：

```powershell
$ids = "'目标 ID','父 ID 1','父 ID 2'"
& $sqlite $stateDb `
    "SELECT id,model_provider,model FROM threads WHERE id IN ($ids);"
```

`state_5.sqlite` 的 `threads.model_provider` 是恢复时必须同步的记录。新 provider ID 应该来自当前有效配置，或者来自一个已经能正常启动的 session。例如本次切换到 `omnicross`：

```powershell
$ids = "'目标 ID','父 ID 1','父 ID 2'"
$sql = @"
BEGIN IMMEDIATE;
UPDATE threads
SET model_provider = 'omnicross'
WHERE id IN ($ids);
COMMIT;
SELECT id,model_provider,model
FROM threads
WHERE id IN ($ids);
"@
& $sqlite -bail -cmd '.timeout 15000' $stateDb $sql
```

PowerShell 5.1 下，`.bail`、`.timeout` 等 SQLite dot command 应通过 CLI 参数（如 `-bail`、`-cmd`）传入，不要混入 SQL here-string。若旧 session 使用的模型在当前 CLI 或新 provider 中不可用，再单独把目标 session 的 `model` 改成当前可用模型；provider 切换本身不应无条件改模型。父 session 的模型记录通常只用于历史元数据，可以保留；如果 bootstrap 仍读取父链模型，再按同样规则更新父链。

在 Windows 上使用临时文件替换原 JSONL 时，`.NET File.Replace` 传入空的备份路径可能失败；应传入一个明确且不存在的备份路径，并在替换前确认临时文件已通过校验。

不要直接修改 `thread_history_1.sqlite` 中所有包含旧字符串的 `item_json`。其中可能有命令、搜索结果或用户文本包含相同字符串。只有确认某条记录确实是 provider 设置事件时，才处理该记录。

## 5. 验证和恢复

先用 `rg` 做初筛：

```powershell
$files = @('目标 JSONL','父 JSONL 1','父 JSONL 2')
rg -n '"model_provider(_id)?":' -- $files
```

`rg` 命中可能来自对话文本、命令输出或日志，不能把“无输出”当作最终判据。最终应逐行使用 `ConvertFrom-Json`，只检查 JSON 对象中的结构化 `model_provider` / `model_provider_id` 属性；目标字段的值应全部是新 provider，父链中没有字段则保持不变。大文件建议用允许 `FileShare.ReadWrite` 的 `StreamReader` 逐行读取，避免一次性 `ReadAllText` 占用过多内存。

确认结构化字段后，继续确认 SQLite：

```powershell
& $sqlite $stateDb `
    "SELECT id,model_provider,model FROM threads WHERE id IN ($ids);"
```

每个目标行应显示新 provider，模型字段应保持预期值。关闭 Codex CLI/TUI 后再恢复：

```powershell
codex resume 目标 ID
```

看到 `Earlier messages are available` 并进入输入界面，说明 TUI bootstrap 已通过。历史记录中可能仍显示旧模型报错，那是已保存的旧对话内容；应以当前 TUI 顶部显示的 provider/model 和能否发送新消息为准。

## Windows 并发注意事项

- 修改 SQLite 前关闭其他 Codex CLI/TUI；如果当前操作由正在运行的 Codex 代理执行，不要强制终止自己的进程，完成文件修改后再重启 Codex 验证。
- 目标文件或日志可能被其他进程打开。只读检查可以使用 `FileShare.ReadWrite`；写入时仍应使用临时文件，并在校验通过后原子替换。
- `File.Replace` 的源文件、目标文件和备份文件应位于同一卷，备份路径使用明确的绝对路径；不要依赖空备份路径在所有 Windows/.NET 版本上都可用。

## 典型遗漏的根因

只处理目标 JSONL 和父 session 的 provider 字段仍可能无法恢复，因为 `state_5.sqlite` 的 `threads.model_provider` 还保存着旧 provider。最终需要同时处理：

```text
目标 JSONL
目标的全部父 JSONL
state_5.sqlite.threads
```

`session_index.jsonl` 只保存列表索引和标题，本次没有保存 provider 字段，不需要修改。

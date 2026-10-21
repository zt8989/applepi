# 设置 / `/settings`

配置的唯一真相是 `~/.pi/agent/settings.json` —— **与 pi 同一个文件、同一批键**（见
[sessions](sessions.md) 的家目录一节）。所以「本项目的设置」分两类：

| 类 | 是什么 | 从哪改 |
| --- | --- | --- |
| **面板里有的** | 本项目真的会照着做的键 | `/settings`，或手改 settings.json |
| **只读/只管写入的** | 本项目不读、但 pi 读（或不读也不管的）键 | 手改 settings.json（写了不骗人，但本项目不因它改变行为） |

分成这两类的理由只有一条：**面板上的一行必须真的会改变什么**。pi 的
`SettingsSelectorComponent` 有三十多行（fullscreen、cache warming、transport、
telemetry、project trust……），本项目没那些功能 —— 硬摆上去就是「看着能改、改了没用」，
而这个项目最不愿留的就是那种东西（见 `model-picker.ts` 里「假成功比报错更糟」那几句）。

## 面板里现在有一行什么

| 行 | 写哪个键 | 谁生效 |
| --- | --- | --- |
| Auto-compact | `compaction.enabled`（默认 `true`） | 内核当场开关自动压缩（`store.ts` 的 `AutoCompact`）。关掉只是不**自动**压，`/compact` 仍能手动压 |
| Hide thinking | `hideThinkingBlock` | 与 `Ctrl+T` 同一个键、同一条渲染路径（两处共用一份就地状态） |
| Default thinking level per model | `modelThinkingLevels`（键 `provider/id`） | 启动 / 换模型时按它解析；改的正好是当前模型时当场生效 |

「Default thinking level per model」那一屏**逐字照抄 pi**：两步选择（先模型、再档位），
档位只列这个模型支持的那几档，已配过的多一行 `(clear override)`（回到全局默认），
配完 `loop` 回第一步好连着配几个。见 [thinking](thinking.md)。

## 浏览器里的同一屏

`--web` 的 `/settings` 是同一批键的另一块界面：顶部分区「常规 / 模型 / 技能」。
「常规」三行与上表一一对应；「模型」是 `enabledModels`（TUI 的 `/scoped-models`，以前在
浏览器里是单独一个入口）；「技能」是只读清单。实现在 `packages/webui/src/settings-panel.ts`，
「模型」那一页的纯逻辑在 `settings-scope.ts`。两边的读写仍然落在**同一批函数**上，
所以不会不一致。

## 没进面板的键（以及为什么）

- **本项目会读、但属于「手改更合适」**：`thinkingBudgets`（四档 token 预算）、
  `compaction.reserveTokens` / `keepRecentTokens` / `modelOverrides`、
  `enabledModels`（`/scoped-models` 面板已经是它的界面）、
  `defaultTools`（改它要重装 prompt 与工具表）。
- **本项目会读、且有别的界面**：`defaultProvider` / `defaultModel`（`/model` 的 `Ctrl+S`）、
  `defaultThinkingLevel`（`/thinking` 的 `Ctrl+S`）、`theme`（手改；`setupTheme()` 只在启动读一次）、
  `externalEditor`、`packages`（扩展装载）。
- **本项目不读**（pi 读）：`transport`、`httpIdleTimeoutMs`、`cacheWarming`、
  `steeringMode` / `followUpMode`（这两个定的是**投递粒度**：`all` = 一次全插进去，
  `one-at-a-time` = 一条一条来。本项目恒定「一条一条」—— 排队那两条走哪一列由**按键**
  决定（回车 = steer，`Option+Enter` = followUp），与这两个键无关，所以不能拿它们当那一行的值）、
  `terminal.*` / `images.*`、`tuiMode` / `fullscreen*`、`mermaid`、`showCacheMissNotices`、
  `collapseChangelog`、`enableInstallTelemetry`、`defaultProjectTrust`、
  `doubleEscapeAction`、`treeFilterMode`、`quietStartup`、`warnings`。

加一行的顺序是：**先让本项目真的读那个键**，再把那一行接进 `settings-picker.ts`
（那里是一张表，加一行就是加一个 item + 一个分支）。反过来先摆开关是禁止的。

## 代码位置

| 做什么 | 在哪 |
| --- | --- |
| 面板（pi 的零件：`SettingsList` + `SteppedSubmenu` + `DynamicBorder`） | `packages/tui/src/settings-picker.ts` |
| 命令接线与三个回调 | `packages/tui/src/app.ts` 的 `case 'settings'` |
| 浏览器侧的分区面板 | `packages/webui/src/settings-panel.ts` |
| 浏览器侧的可用模型 / 作用域逻辑 | `packages/webui/src/settings-scope.ts` |
| 自动压缩开关 | `readCompactionEnabled` / `writeCompactionEnabled`（`packages/core/src/compact.ts`）+ `AutoCompact.setEnabled`（`packages/core/src/store.ts`）+ `Kernel.setAutoCompactEnabled` |
| 折叠思考块 | `model-scope.ts` 的 `readHideThinkingBlock` / `writeHideThinkingBlock` |
| per-model 档位 | `thinking-level.ts` 的 `readAllModelThinkingLevels` / `writeModelThinkingLevel` / `removeModelThinkingLevel` |
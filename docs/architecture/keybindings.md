# 键位：完全复用 pi，外加本项目的轨迹与打印布局

状态：`feat/pi-keybindings-parity` 分支。

## 目标

把 pi 的**整套**键位表在 ela 里变成真的能按的：

- 键位定义表已经是 `{ ...PI_KEYBINDINGS, ...PROJECT_KEYBINDINGS }`（`packages/tui/src/keybindings.ts`），
  所以「表里有」这件事早就是真的。**缺的是行为** —— 表里列着 `app.model.cycleForward`
  这些 id，但按下 `Ctrl+P` 什么都不会发生。
- 「完全复用 pi」= 每个 pi 动作 id 都有对应的处理者，且语义与 pi 一致。
- 「冲突以 pi 为准」= 当本项目的旧行为与 pi 抢同一个键时，**改本项目**。

## 冲突清单（pi 赢）

| 键 | pi 的含义 | ela 旧行为 | 处理 |
| --- | --- | --- | --- |
| `Ctrl+C` | `app.clear`：清空编辑器；**两次**才退出 | `app.abort`：中断回合，空闲即退出 | 改为 pi 语义：`CustomEditor.onAction('app.clear')` 清空；连按两次退出。中断改由 `Escape`（pi 的 `app.interrupt`）负责 |
| `Escape` | `app.interrupt`：取消 / 中断 | 无 | 接上：流式时中断回合；有队列时把队列还回编辑器（pi 的 `restoreQueuedMessagesToEditor`） |
| `Ctrl+D` | `app.exit`：编辑器为空时退出 | 无 | 接上（`CustomEditor.onCtrlD`） |
| `Up`/`Down` | `tui.editor.historyPrevious/Next`：翻输入历史 | 无（编辑器自己的光标移动仍保留） | 接上：显式绑定优先于 app 动作（pi 的 `CustomEditor` 已如此） |

> 注意：`Ctrl+C` 从「中断」改成「清空」是本分支对用户手感**最大**的一次改动。
> 这是「完全复用 pi、冲突以 pi 为准」的直接结果 —— pi 的中断键是 `Escape`。
> 原来的 `app.abort` 动作 id 仍然保留在定义表里（供 `keybindings.json` 覆盖），
> 但默认不再绑 `ctrl+c`。

## 翻页：交给 pi-tui 的 `tui.altScreen.*`（不再自己抢键）

早先翻页是本项目自己实现的：一张**字节序列表**把 `Alt+↑↓` / `Ctrl+P/N` 匹配成
「翻半页」，挂在全局 input listener 上。两个问题，都是「与 pi 抢键」：

- `Alt+↑` 是 pi 的 `app.message.dequeue`（把排队消息还回输入框），`Ctrl+P` 是
  `app.model.cycleForward`（换下一个模型）—— 都被翻页抢走，于是共用一份
  `keybindings.json` 里表达不出「我要 pi 那个动作」；
- 表里的裸 `\x1b[A` 被当成了「`Alt+↑` 的 xterm 变体」，其实它就是**普通 ↑**。
  不支持 Kitty 键盘协议的终端（Orca 的内嵌终端、Terminal.app、tmux 老配置）发来的
  正是这一串，于是所有 ↑↓ 都被吃成翻页：编辑器里改不了光标，扩展挂在输入区槽位里的
  对话框（`ask_user_question`）收不到方向键。

现在翻页完全交回 pi-tui：`TuiAltScreen` 构造时自己注册了一个 input listener，
处理 `tui.altScreen.pageUp/pageDown`（`PgUp`/`PgDn`）、`halfPageUp/Down`、
`lineUp/Down`、`previousPrompt/nextPrompt`、搜索与滚轮，滚的是 **primary** ScrollView
—— 而本项目切页时让 `primary` 跟着当前页走（`applyLayout`），正好就是「只滚当前页」。

于是三个后果，都是故意的：

- 半页默认**没有键**（pi 默认也是空的）；想用就给 `tui.altScreen.halfPageUp/Down` 绑一个；
- `/hotkeys` 里那一行写的是 `tui.altScreen.*` 而不是 `tui.editor.*` —— 同键不同 id，
  真正生效的是前者（写错了就成了「改键没反应」）；
- 全局监听器的让路判据多了第二种形态（见 `shouldYieldInput`）：扩展挂在**输入区槽位**
  里的对话框不在 overlay 栈上，只判 `hasOverlay()` 会漏掉它们。

## 要补的动作（按 pi 的 id 实现）

| id | 默认键（macOS/Linux → Windows） | 本项目要做的 |
| --- | --- | --- |
| `app.model.cycleForward` / `app.model.cycleBackward` | `Ctrl+P` / `Shift+Ctrl+P` → `Ctrl+P` / `Alt+P` | 在 `currentScope` 里循环换模型（内核已有 `setModel`） |
| `app.thinking.cycle` | `Shift+Tab` | 循环 thinking 级别，发 `thinking.changed`（**不**落盘 —— pi 的 `cycleThinkingLevel()` 没带 `persist`；存默认走 `/thinking` 面板里的 `Ctrl+S`）。见 [thinking](thinking.md) |
| `app.message.followUp` | `Alt+Enter` → **`Ctrl+Q`** | 流式时按 followUp 入队；空闲时等同回车 |
| `app.message.dequeue` | `Alt+Up` → `Alt+Q` | 把队列内容还回编辑器（需要新增 `queue.clear` action） |
| `app.editor.external` | `Ctrl+G` | 复用 pi 的 `editInExternalEditor()` |
| `app.message.copy` | `Ctrl+X` | 复制选区或最后一条 assistant 消息（复用 pi 的 clipboard utils） |
| `app.clipboard.pasteImage` | `Ctrl+V` → `Alt+V` | 复用 pi 的 `readClipboardFilePaths/Image/Text` |
| `app.suspend` | `Ctrl+Z` → **不绑** | 复用 pi 的 `handleCtrlZ()` 实现 |
| `app.interrupt` | `Escape` | 中断 / 还队列 |
| `app.clear` | `Ctrl+C` | 清空编辑器；两次退出 |
| `app.exit` | `Ctrl+D` | 编辑器为空时退出 |
| `tui.editor.historyPrevious/Next` | `Up` / `Down` | 交给编辑器（`CustomEditor` 已实现） |

## Windows：默认键不是同一批（followUp 是 `Ctrl+Q`，不是 `Alt+Enter`）

pi 的 `KEYBINDINGS` 在模块装载时就读了它自己的 `useWindowsKeybindings()`（`win32` **或** WSL
都算 Windows），本项目 `{ ...PI_KEYBINDINGS, ...PROJECT_KEYBINDINGS }` 直接拿到那一批。所以上表
里「→」右边的键只在 Windows 上生效，`/hotkeys` 也只会列出那一批。

最常被当成 bug 的一条是 followUp：`Alt+Enter` 在 Windows Terminal 里是**全屏开关**，
那一串根本到不了应用 —— 按下去只整屏放大，看起来就是「Windows 上没有 followUp 的快捷键」。
pi 的对策就是换键（`Ctrl+Q`），本项目跟随。**不要**给它补回 `alt+enter`：那样只是
把同一个按不动的键多写进一份文档。个别终端（WezTerm、VS Code 终端）确实能让它上来，
那就由用户自己写覆盖：

```json
{ "app.message.followUp": ["ctrl+q", "alt+enter"] }
```

两条推论，都是「少写一份会骗人的说明书」的直接结果：

- 所有**给人看**的键名走 `keyLabel()` / `actionKeys()`（`/hotkeys`、顶行、底栏提示），
  它们是同一份解析结果；注释与文档里写死的键名默认是 mac 的值。
- Windows 上 `app.suspend` 的默认是空数组（`ctrl+z` 在那儿不归应用），所以 `/hotkeys`
  里**没有 `app.suspend` 那一行** —— 表只列真能按的。测试盯的是「解绑的动作不凑空键名行」，
  而不是“每个动作都得有键名”。

## 测试要跟着改

`packages/tui/test/keybindings.test.ts` 里有一条 `不列本项目没实现的键位` 把 `app.suspend` /
`app.editor.external` / `app.message.dequeue` 列成「不该出现」。这些现在**实现了**，
断言已经反过来：它们**应当**出现在 `/hotkeys` 里。

## 暂缓：`!` / `!!`（bash 模式）

pi 那张表里最后一行是 `!` / `!!`（跑 bash 命令；`!!` 不进上下文）。**本轮先不做** ——
它需要在**对话消息模型**里加一种 `bashExecution` 角色：`state.messages` 是直接喂给 LLM 的
`pi-ai Message[]`，要让 `!` 进上下文、`!!` 不进，就得新增消息类型 + `bashExecutionToText`
转换，而落盘 / 回放 / 压缩切点都要认这条新消息 —— 那是本项目「上下文满了自己会压」
「绝不切在工具结果中间」那几条不变量最敏感的地方，得单独一轮改。

所以 `/hotkeys` 里**不列 `!` / `!!`**（列了就是「按了没反应」的说明书）。
# event-loop-agent

## 介绍

用 **Redux Loop**（Elm Architecture 移植到 Redux 的那个库）写的一个 agent 内核：**没有 while 循环的
agent** —— 循环不是写出来的，是 reducer 与副作用互相 dispatch 出来的环。

三件事让它和一般的 agent 写法不一样：

- **执行历史是一棵树**，像 `git log` 一样，一次尝试一个节点。失败和超时也留在树上，
  重试就是一次分叉：新尝试的父 id 指向**超时前**的那个节点。
- **错误也持久化。** 错误节点和成功节点走同一条路落盘（追加写 JSONL，崩了只丢最后半行），
  所以「失败过」不会随着对话滚出屏幕而消失。
- **上下文满了自己会压。** 复用 pi 的切点与摘要算法（绝不切在工具结果中间），压完在对话区
  常驻一行说明 —— 压缩是唯一会静默改写对话内容的操作，不说出来用户就只会看到「模型突然
  忘了前面说过什么」。手动也能压：`/compact`。
- **内核只有一份，跑在 Node 里。** 界面（pi-tui 终端）订阅它、画它、发消息给它，工具（`read` / `write` / `edit` /
  `bash`，直接用 Pi 官方那套）摸的是真实文件系统。
- **长命令边跑边显示。** 接上官方工具的 `onUpdate`，`npm install` 这类命令的输出
  逐行出现，而不是「卡几十秒然后突然蹦出一块」——那几十秒的空白和卡死了没区别。
- **能装 pi 扩展。** `settings.json` 的 `packages` 里的扩展、以及 pi 那两个**本地目录**
  （`<cwd>/.pi/extensions/`、`~/.pi/agent/extensions/`）里的扩展，装上就能用 ——
  比如让模型开一个结构化多选对话框问你（别猜），或者查 web 抓 PDF。官方 loader
  装载、官方扩展运行时驱动，本项目只提供自己那一半：环、工具表、overlay 宿主。
  **agent 生命周期事件也接上了** —— Orca 装在 `~/.pi/agent/extensions/` 的状态钩子
  因此能拿到 `agent_start` / `tool_execution_*` / `session_file`，不再永远停在 loading。
- **system prompt 也是官方的。** 用 pi 的 `buildSystemPrompt` 拼：每个工具怎么用、
  `edit` 的那些坑、`AGENTS.md` 项目上下文、cwd、skill 清单。自己**一个字都不写** ——
  项目自己的规则写在 `.pi/APPEND_SYSTEM.md`（或家目录那份）里，与 pi 同路径、同优先级。
  手写提示词会把那些踩坑换来的经验全扔掉。
- **也能在浏览器里用。** `ela --web` 会额外起一个 web server（`http://127.0.0.1:30141/`，
  界面是 `@earendil-works/pi-web-ui` 的聊天界面 —— 但**环还是终端进程里那一个**，
  浏览器只是渲染层（模型密钥与工具都在服务端）。见
  [`docs/architecture/webui.md`](docs/architecture/webui.md)。

**本文只讲怎么装、怎么起、怎么测。** 它是什么、内部怎么转、接口有哪些见
[`docs/architecture.md`](docs/architecture.md)。文档分工：README 是入口，
`docs/architecture/` 是现状（对着代码核过，带快照 commit）。

## 前置准备

- **Node.js 20+**（pi-tui 要求 ≥22.19，实测 24.9 可用）
- **pnpm 11+**（本项目用 pnpm；见下面「为什么要 pnpm patch」）
- 真实跑模型时需要对应 provider 的 API key

## 安装

```bash
pnpm install
npm link          # 把 `ela` 装成全局命令（软链本仓库）
```

根包的 `bin` 指向 `packages/tui/bin/ela.mjs`（安装壳在最外层，启动器在 tui 包里）。
也可以只链 tui 包：`npm link ./packages/tui` —— 它会以 `@ela/tui` 的名义装全局，`ela`
同样指向同一个启动器。

全局入口是 `packages/tui/bin/ela.mjs`：**一个只做装载的启动器**，一行逻辑也不放它里面 ——
`packages/tui/src/main.ts` 是 TypeScript 且用 `moduleResolution: "Bundler"` + 无扩展名相对导入，
tsc 不 emit（`noEmit`），产物也没法被 node 原生 ESM 解析，所以必须经 tsx 装载
（`tsx/esm/api` 的 `tsImport()`，不用改 tsx 的 exports，不用 patch）。
npm 只拷 `bin/`（`files` 之外的仓库文件不会跟着走），入口全部靠 `import.meta.url`
推 **tui 包根** —— 与调用时的 cwd 无关，因此**任何目录里都能跑**：

```bash
ela                              # 交互式（只开终端界面）
ela -p "今天几号？"              # 跑一条就退出
ela --cwd ~/some/project         # 工具的文件边界换到别处
ela --web                        # 额外起浏览器界面（默认不起）
ela --web-port 8080              # 换浏览器界面的端口（给了它就隐含 --web）
```

浏览器界面（`http://127.0.0.1:30141/`）需要**先构建一次前端**：

```bash
pnpm build                       # = pnpm --filter @ela/webui build
```

没构建也能起 —— 那一页会给一句「先跑 pnpm build」。只绑 `127.0.0.1`、无认证：
工具没有沙箱，别把它挂到局域网上。

改 `packages/*/src/*.ts` 后**直接生效**，不用重新 link。代价是仓库的 `node_modules` 得在
（`rm -rf node_modules` 之后全局命令会报模块找不到 —— 这是软链方案的固有性质）。

> **不读 `.env`**。key 来自 `~/.pi/agent/auth.json`、shell 环境变量、或 models.json
> 条目内的 `apiKey` —— `ela` 与 `pnpm start` 现在**完全等价**。
> 刻意没有 `.env` 这一档：从调用目录读 `.env` 会把「A 项目的 key」发给「B 项目」，
> 比读不到更难查。要带 key 用 `ela --api-key <key>` 或设真环境变量
> （凭证优先级与 pi 一致，见 `docs/architecture/provider.md`）。

`pnpm-workspace.yaml` 里的 `allowBuilds` 放行了三个包的构建脚本（esbuild / protobufjs /
@google/genai）—— 不放行的话 pnpm 10+ 会拦截它们，并让**每条 pnpm 命令都先跑一次
install 然后失败**。

所有全局状态都在**配置家目录** `~/.pi/agent/` —— 与 pi 同址，两边共用同一份配置与历史。
搬家只用 pi 官方的 `PI_CODING_AGENT_DIR`（本项目早先额外认一个自己的变量，现已删掉 ——
两个变量指向同一件事却只有一个被 pi 认，症状是「改了一边另一边读不到」）。

```text
~/.pi/agent/
  models.json            provider / 模型目录（pi 当前要求 models 是数组）
  auth.json              凭证
  settings.json          默认 provider / model / thinkingLevel / thinkingBudgets / compaction.enabled…（与 pi 同一批键）
  sessions/
    --<cwd 编码>--/<时间戳>_<id>.jsonl   会话（可恢复；pi 的 /resume 也能看到）
  traces/                        ← 只有本项目写，pi 没这个目录
    <时间戳>_<id>.jsonl          轨迹树 + 装载段（prompt / model）
```

文件名是 `<ISO 时间戳>_<UUIDv7>.jsonl`（如 `2026-10-12T05-44-28-468Z_01a12ea4-….jsonl`），
与会话 id 都是 UUIDv7 —— **与 pi 同一形状**。退出时打的那行
`To resume this session: ela --session <id>` 粘回去就能接着聊；因为两边完全互通，
把同一个 id 交给 `pi --session <id>` 也能打开。

**发过第一句话才算一段会话**：启动时 prompt / model 已经装进内存（开场就能报 skill 清单），
但轨迹节点与这两个文件都**推迟到用户发出第一句话**才建 —— 「进来看一眼就退出」不该在盘上
留一个只有装载段的空壳。与 pi 的 `SessionWriter` 同一个口径。

**首帧不等扩展**：三个 npm 扩展装载加上 MCP 连服务器实测 2~3 秒，而它过去整个在首帧之前。
现在交互式启动把这一块推到后台（`deferExtensions`）：界面 ~1.1s 就出来，扩展装完再报一次开场、
在那之前发的消息会排队等装载完成（不丢，见 [init.md](docs/architecture/init.md) 的启动时间线）。

**为什么与 pi 同址**：provider 目录改一次两边都得知道，key 改一次两边都得用。分两个目录的
代价是每次改配置要同步两次，收益仅仅是一个命名上的所有权标记。会话目录名（`--<cwd>--` 编码）
与 header 形状也照抄 pi，所以历史两边互通；`traces/` 是我们多出来的，单独放。

目录名与环境变量名都取自 pi 的**官方常量与函数**（`getAgentDir()` / `CONFIG_DIR_NAME` /
`ENV_AGENT_DIR`），不是手抄的字符串——否则 pi 改了实现而我们静默地指向别处，症状是
「改了一边另一边读不到」，很难查。

### 为什么要 pnpm patch

pi-coding-agent 的 `exports` 只开放 4 个入口，其余模块（包括 `dist/config.js` 的
`getAgentDir()`、`dist/core/model-config.js` 的 `ModelConfig`、它自己的 TUI）全被封住。
上面那句「取自官方函数」就需要打开 `dist/config.js`。

`patches/@earendil-works__pi-coding-agent.patch` 给 `exports` 加了两条通配符
（`./dist/*` 与 `./dist/*.js`），**12 行 diff，只动 `package.json`**。

patch 丢了或 pnpm 升级后没重新应用，这些 import 会全部变成
`ERR_PACKAGE_PATH_NOT_EXPORTED` —— `packages/core/test/pi-subpath-patch.test.ts` 盯着这件事。

另一份 patch（`patches/@juicesharp__rpiv-ask-user-question@*.patch`）改的是内置的
`ask_user_question` 扩展（终端那份归它渲染、浏览器那份交给我们），它的**可复现来源**是
`packages/core/scripts/repatch-ask-user-question.ts`：

```
pnpm repatch:ask-user-question     # npm pack → 应用改动 → pnpm patch-commit
```

脚本在 `packages/core/scripts/repatch-ask-user-question.ts`（与 `config:migrate` 同一套：
`node --import tsx`，也被 core 的 typecheck 盯着）。

升级上游只需改 `packages/core/package.json` 里的版本再跑一遍；上游动过我们 patch 的地方
会对不上，脚本会指名道姓地说出是哪一处。

三个 json 手写或从别处拷进来。`models.json` 放 provider 的 baseUrl / api / 模型目录，
`auth.json` 只放凭证；也可以用 `<ID>_API_KEY` 环境变量（**不读 `.env`**）。
命令行的 `-P` / `-m` 仍然优先。

- `-P/--provider`：models.json 里自定义的 provider，或 pi 自带的 44 个内置 provider
  （`anthropic` / `openai` / `deepseek` / …）。凭证优先级：models.json > auth.json >
  `<ID>_API_KEY` 环境变量（与 pi 一致）。
- `models.json` 的形状：pi 要求 `models` 是**数组**。本项目两种都读，读到旧的对象 map
  会顺手把盘上那份改成数组 —— 否则 pi 自己读同一个文件时整个文件作废。

## 扩展

扩展装在 **pi 那边**（同一个 `settings.json`），本项目启动时一并装载：

```bash
pi install npm:@juicesharp/rpiv-ask-user-question   # 结构化多选对话框
pi install npm:pi-web-access                        # web 搜索 / 抓取 / PDF / GitHub
```

（前者让模型可以问你而不是猜；后者让它能查外面的东西 —— 依赖对应 provider 的
API key，比如 exa / tavily / brave。）

`--no-extensions` 跳过。装了什么、开场那节 `[扩展]` 会报出来，坏了是 `[扩展警告]`。

**命令与快捷键也接了**：`/websearch` `/curator` `/google-account` `/search` 四个命令
与两个键位都可用。**内置的几个开关优先**——扩展抢不走它们。

**工具集与 prompt 一样是装载时定下的** —— 不在一轮对话中间换工具（那会让已发出的
消息与 prompt 对不上，而 prompt-cache 的前缀整个作废）。改工具集要 `/new` 换会话。
详见 [`docs/architecture/extensions.md`](docs/architecture/extensions.md)。

## MCP 与 codemode

两样一起接进来（都是 pi 的**内置扩展**，本项目只提供自己那一半）：

- **MCP**：读 `~/.pi/agent/mcp.json`（与项目级 `<cwd>/.pi/mcp.json`，与 pi 同一份文件），
  把服务器的工具接进来；`/mcp` 可以看连接状态、登录 OAuth、重连、改暴露方式。
- **codemode**：模型写一段 JS（QuickJS 沙箱）把多个工具调用批量跑、并行跑、先过滤再回
  —— 只有脚本的输出回到模型眼前。

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
    "internal-tools": { "exposure": "direct", "command": "uvx", "args": ["tools-mcp"] }
  }
}
```

默认（不写 `exposure`）是 **`codemode`**：MCP 工具**不进模型的工具表**，模型先看到
prompt 里的 `mcp_servers` 段（「有这个服务器、工具从 codemode 脚本调」），要用时写脚本
调（`searchTools()` / `describeNamespace()` 找）。想让它直接出现在模型的工具表里就写
`"exposure": "direct"`。

**codemode 怎么开**（它默认不激活）：

```json
// ~/.pi/agent/settings.json
{ "defaultTools": ["read", "bash", "edit", "write", "+codemode"] }
```

配了 `codemode` 暴露的 MCP 服务器时它**会自己开**（`mcp.json` 顶层的
`"autoEnableCodemode": false` 可以关掉）。

`tool_search` 也装（pi 的内置扩展），但它注册时是**不激活**的 —— 要用得在
`settings.json` 的 `defaultTools` 里写 `+tool_search`；激活后模型能把 `codemode` /
`deferred` 暴露的工具搜出来装进工具表。

**已知边界**（都写在 [`docs/architecture/mcp-codemode.md`](docs/architecture/mcp-codemode.md)）：
装载后才连上的 `direct` 服务器，其工具会在下一次请求前作为**声明增量**进模型工具表
（不必 `/new`）；`/new` 不重连 MCP；不装 `llama.cpp`（那是本地模型那条路）。

## 运行

```bash
pnpm install
```

**终端界面**（pi-tui）：

```bash
pnpm start                                  # 交互式（开发用）
ela                                        # 交互式（全局命令，任何目录；与上面等价）
pnpm start -p "今天几号？"                  # 跑一条就退出，顺带打印轨迹树
pnpm start --llm-timeout 30000 --attempts 3   # 短超时 + 三次尝试，好看到重试分叉
pnpm start --cwd ../other                  # 工具的文件操作边界换到别的目录
pnpm start --thinking high "帮我看看这个并发问题"   # 一次性的思考级别（按模型能力 clamp）
pnpm start -m cn:deepseek-v4.1-flash:high   # 同一个意思：模型 pattern 的 :<级别> 后缀
```

要**不打网络**跑一遍完整环（pi-ai 自带的 faux provider、工具真执行、轨迹真落盘）走测试：
`pnpm --filter @ela/core test`（内核的 `createKernel({ demo: true })` 就是那一条，
CLI 上不再有这个开关 —— 它只在测试里用）。

**浏览器界面**（pi-web-ui，**默认不起**，`--web` 打开）：

```bash
pnpm build                       # 先构建一次前端（dist/ 不在版本库里）
pnpm start --web                 # 然后开浏览器：http://127.0.0.1:30141/
pnpm start --web-port 8080       # 换端口（被占就往后试，真地址会报出来；隐含 --web）
```

两边是**同一个环**：在浏览器里发的话，终端那边也会看到（反之亦然）。模型列表与 TUI 的
`/model` 面板**同一份**（已配置 provider 里那些），作用域也照它来。
图片 / 文档附件可以随消息发出去（回形针 / 拖入 / 粘贴）：服务端把它们折成标准的 user
content 块，历史里的图片画成缩略图、文档画成文件格子。
实现与边界见 [`docs/architecture/webui.md`](docs/architecture/webui.md)。

界面里：`Ctrl+R` **在「对话」与「轨迹」两页之间切换**（顶部有页签标出当前在哪页），
`PgUp`/`PgDn` 翻当前页（整页 —— pi-tui 的 `tui.altScreen.pageUp/pageDown`，只滚当前那一页），
`Ctrl+O` 展开/收起工具输出，
`Ctrl+T` 展开/收起模型的思考块，`Ctrl+L` 开模型面板。
**pi 的整套键位都可用**（冲突以 pi 为准）：`Ctrl+P`/`Shift+Ctrl+P` 循环换模型，
`Shift+Tab` 循环思考级别，`Ctrl+G` 交给 `$EDITOR`，`Ctrl+X` 复制最后一条回答，
`Ctrl+V` 粘贴（文件/图片/文本），`Ctrl+Z` 挂后台，`Alt+Enter`（macOS `Option+Enter`）排 follow-up，
`Alt+Up` 把排队消息还回输入框。**中断是 `Escape`，`Ctrl+C` 是清空编辑器（连按两次退出）、
`Ctrl+D` 退出** —— 这三个与 pi 一致（不再把 `Ctrl+C` 当中断）。
`/hotkeys` 打出完整的一份（形状与 pi 的 `/hotkeys` 相同）。
布局照抄 pi 的终端界面：**顶行把页签与轨迹统计合并成一行**（`对话 │ 轨迹 3轮2步 错误1 (Ctrl+R)`），
模型与工作目录在底栏，工具调用是带底色的整块。

**键位可改**：写在 `~/.pi/agent/keybindings.json`（与 pi **同一个文件**），例如
`{ "app.trace.toggle": "ctrl+shift+r" }`。界面上的提示行、`/hotkeys`、`--help`
显示的都是解析后的键 —— 改完不用重启。本项目自己的 id 只有一个还默认占键
（`app.trace.toggle` `Ctrl+R`），其余全部复用 pi 的 id
（所以同一个覆盖在 pi 与本项目里都生效）。`app.abort`（旧的「`Ctrl+C` 一键中断/退出」）
默认不绑，写进 `keybindings.json` 就能拿回那个手感。

### 轨迹页：一直往下刷，也能往回滚

轨迹是**分块增量**渲染的（一个节点一块，与对话区同构）：流式 token 每来一个只重算
**那个节点**，不是每帧重画整棵树（200 个节点的单次渲染实测 4~6ms，而一个长工具输出
能刷几百帧）。

外面包一层 `ScrollView` 且 `follow: 'end'`：**新节点往下追加、视口自动贴底**，
而往上翻能回到任何一个历史节点（`PgUp`/`PgDn` 整页、鼠标滚轮）。于是：

- 跑到 26 个节点时，最早那几行被顶出屏幕 —— 但**随时能滚回去**；
- 节点继续往下追加时视口继续跟随，不会「卡在中间」；
- `/new` 或恢复别的会话后节点变少时，旧块会被丢掉，不残留。

翻页用 **`PgUp`/`PgDn`**（pi-tui 的 `tui.altScreen.pageUp/pageDown`，只滚当前页；鼠标滚轮同理）；
纯 ↑↓ 在多行提示词里是**移动光标**、`Alt+↑` 是「把排队消息还回输入框」——
这两个都跟 pi 同键同义，本项目**不抢**（半页想要就自己给
`tui.altScreen.halfPageUp/halfPageDown` 绑个键，pi 默认也是空的）。

### 生成中也能说话：steer 与 followUp

环在跑的时候直接敲字回车，**不用等也不用中断**。话会排进队列，按时机插进对话：

| 模式 | 插进去的时机 | 什么时候用 |
| --- | --- | --- |
| **steer**（默认） | 当前 step 的工具跑完后、**下一次 LLM 调用前** | 「等等，改用这个」「顺便查下版本」 |
| **followUp** | 模型没有工具调用了（回合收工），然后**开一个新回合** | 「先按你说的做，弄完再说下一件事」 |

两列队列各自 FIFO、互不排队。语义与 pi 的 `steer()` / `followUp()` 一致，
**键位也同一套**：回车 = steer，`Alt+Enter`（macOS `Option+Enter`）= followUp。
底区会一直列着排队的消息，形状与 pi 逐行同构：

```
 ↳ Option+Up to edit all queued messages
 Steering: 顺便看下版本
 Follow-up: 待会儿再说
```

投递后那两行自动消失——排队的消息在插进去之前模型**完全不知道它存在**，所以必须让人看得见；
最后一行提示按 `Alt+↑` 能把这些话**还回输入框**再改（不是重发一遍）。

### 回合（turn）与步（step）

一次用户输入引发的整个过程是一个**回合**（turn），里面可以有好几个**步**（step），
一步 = 一次 LLM 调用 **加上它触发的工具批次**。轨迹树于是是：

```text
○  n1 user: 今天几号？
○  n2 turn.start: 回合 1
│  ○  n3 step.start: 第 1 步
│  │  ○  n4 llm.result: 我来查
│  │  ○  n5 tool.result: 42
│  └─ n6 step.end: 第 1 步结束（1 个工具调用）
│  ○  n7 step.start: 第 2 步
│  │  ○  n8 llm.result: 今天是…
│  └─ n9 step.end: 第 2 步结束（0 个工具调用）
└─ n10 turn.end: 回合 1 结束：模型说完了 (reason=completed, steps=2)
```

轨迹页是**分块增量 + 可滚动**的：一个节点一行（不是整棵树一坨），新节点往下追加、
视口自动贴底，往上翻能看到任何历史节点 —— 节点再多也不会「只看得到最早那几行」。

轨道是 lazygit 那种画法：**缩进只由「轮」与「步」给**（轮一层、步一层），容器的闭口点
（`turn.end` / `step.end`）画回自己那一列（`└─`）。**所有节点都是 `○`**（包括当前 tip）——
tip 靠**加粗**区分（判据只有一处：`emphasizedTraceLine()`），字形上树上只有一种圈 ——
tip 就在树上，不再另起一行 `HEAD →`。成败靠**颜色**（绿 / 红加粗），不再有 `✓` / `✗` 字符。
**缩进用完即还**：第 2 轮与第 1 轮同列，不会随回合数一格格往右跑
（轨迹的链是一条直线，按父子关系缩进会长出一条阶梯 —— 见 [trace.md](docs/architecture/trace.md) 的渲染一节）。

顶行把**回合数与步数合成 `x轮x步`**（连着读不歧义），工具/重试/错误非 0 才出现。节点数被删掉了：
它是 `trace.order.length`，**开一轮就 +5**（user / turn.start / step.start / llm.attempt / …），
跳得又快又不 actionable —— 要看节点数切到轨迹页。花费 `$` 也删了：底栏已有一个同口径的会话累计 `$`。
重试的分叉长在 **step 这一层**：
失败的 step 自己关掉，重试另开一个兄弟 step（`turn.start` / `step.start` 都不推进 tip，
所以兄弟都挂在同一个 turn 下面，与原先 `llm.attempt` 的 git 语义一致）。

> **pnpm 与参数**：`pnpm start -p "问题"`，**中间没有 `--`**。写了的话 pnpm 会把它
> 一起透传给脚本，于是 `packages/tui/src/main.ts` 收到一个孤零零的 `--` 并报「未知选项」。

界面支持斜杠命令，在输入框里打 `/` 弹补全（**补全就是那个入口** —— 没有 `/help`，与 pi 一致）：

命令表**与 pi 同名同义**，描述直接用 pi 的英文原文（`packages/tui/src/app.ts` 的
`SLASH_COMMANDS` 是唯一真相；那张表的注释里列了「pi 有、这里不做」的那些命令与理由）。

| 命令 | 作用 |
| --- | --- |
| `/settings` | Open settings menu：自动压缩、隐藏思考块、**每个模型的默认思考级别**（per-model 覆盖，之前只能手改 settings.json） |
| `/model` | Select model：盖住输入框的模型选择面板；`/model <id>` 精确命中就直接切。面板里 `Ctrl+S` 存默认模型 |
| `/thinking` | Set thinking level：思考级别面板；`/thinking <级别>` 直接切。面板里 **`Ctrl+S` 存默认级别**，`Shift+Tab` 循环（**不**存） |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling（含每模型写死一档的 `p/id:high` 写法） |
| `/skills` | 列出**真的进了 system prompt** 的 skill。两条 pi 没有的命令之一 —— 磁盘上有、模型不知道，是这里最难归因的一类问题 |
| `/copy` | Copy last agent message to clipboard（与 `Ctrl+X` 同一条路） |
| `/name [<名字>]` | Set session display name：写进会话文件的 `session_info`（pi 读得懂同一个 entry）；不带参数 = 看当前名字 |
| `/session` | Show session info and stats：文件 / ID / 名字 + 消息条数 + token（含缓存命中率）+ 费用（按模型拆） |
| `/hotkeys` | Show all keyboard shortcuts（键名实时解析，与 pi 同形） |
| `/new` | Start a new session：换 id → 换文件。上一段完整留在 `sessions/` 里 |
| `/compact` | Manually compact the session context：把老对话换成一段结构化摘要 |
| `/resume` | Resume a different session：盖住输入框的历史会话选择面板（满宽，同 pi）。**零 token** —— 不重跑模型，只把消息**和轨迹树**读回来；删历史也在这里（`ctrl+d`） |
| `/continue` | Continue the interrupted turn without a new user message：超时 / 网络错误 / 轮数上限停下后，从停下的地方再跑一次。**不插一条「继续」** —— 对话、会话文件、下一次请求里都不会多出一句 user 消息（另一条 pi 没有的命令） |
| `/quit` | 退出（与 `Ctrl+D` 同一条路：先回主屏，再打那行 `To resume this session:`） |
| `/mcp` | MCP 服务器管理面板（内置扩展提供）：连接状态、登录、重连、改暴露方式 |
| `/skill:<名字>` | 把某个 skill 的正文展开后，连同你写的问题一起发给模型 |
| `/<模板名> [参数]` | Prompt 模板（pi 的 Prompt Templates）：`~/.pi/agent/prompts/*.md`、项目 `.pi/prompts/*.md` 与 pi 包里 `pi.prompts` 点名的文件；回车展开成正文发给模型 |

命令**不发给模型** —— 那是给界面/内核的管理动作。**`/skill:` 与 prompt 模板是例外**：
它们展开成正文/`<skill>` 块真的发给模型（形状与 pi 相同）。**未命中的 `/xxx` 也照发**：
`/etc/hosts`、`/文件名` 这类输入不该被命令层报错或吞掉 —— 与 pi 一致（认不出就原样发）。

### Skill

一个 skill = 一个带 frontmatter 的 `SKILL.md`（`name` + `description` + 正文）。
prompt 里只列一张清单（名字/描述/位置），模型对上号时自己调 `read` 去读正文 ——
少花 token 是这一层的全部意义。

```text
~/.pi/agent/skills/<名字>/SKILL.md    ← pi 自己的（用户级）
~/.agents/skills/<名字>/SKILL.md      ← 跳工具约定（用户通常装这儿）
<工作目录>/.pi/skills/<名字>/SKILL.md ← 项目级
```

```bash
pnpm start --skill ./docs/my-skill.md    # 额外指定，可重复
```

目录扫描、frontmatter 解析、prompt 里的 XML 格式**全部复用 pi 官方**
（`loadSkills` / `formatSkillsForPrompt`），本项目不维护副本。详见
[`docs/architecture/tools.md`](docs/architecture/tools.md#skill--也在-pi-那一侧packagescoresrcskillsts)。

> 清单是会话**装载时**定下的。事后新增 skill 要 `/new` 换个会话才生效。

### Prompt 模板

Prompt 模板就是「一段常写的提示词」存成 Markdown：**文件名是命令名**，正文是回车后
真正发给模型的那段话。pi 的 `pi.prompts`（安装的包）与下面两处目录都会加载：

```text
~/.pi/agent/prompts/review.md          ← 用户级，命令是 /review
<工作目录>/.pi/prompts/parallel-review.md ← 项目级
```

```markdown
---
description: Review staged git changes
argument-hint: "[focus]"
---
Review the staged changes. Focus on ${1:-correctness, security, and error handling}.
```

`description` / `argument-hint` 进补全；`$1` / `$@` / `${1:-默认值}` 的替换规则
**整个复用 pi 的 `expandPromptTemplate()`**，与模板作者在 pi 文档里看到的一致。

开场横幅里那一节 `[Prompts]` 就是本轮可用的模板清单（与 pi 同形、同样常驻），
所以装了 `pi-subagents` 之后会直接看到 `/council`、`/parallel-review`、`/review-loop` 这些；
`--web` 的 `/` 命令下拉里也列同一批（选中后由服务端展开）。
模板**不进 system prompt**，也不改工具集 —— 它只是省掉每次手打一大段提示词。

选项：`-p/--print`、`-P/--provider`、`-m/--model`、`-s/--system`、`--max-turns`、
`--llm-timeout`、`--attempts`、`--api-key`、`--no-trace`、`--session`、
`--skill`、`--cwd`、`--trace-dir`、`--no-extensions`、`--web`、`--web-port`、`-h/--help`。

配置/provider 这一层**直接用 pi-coding-agent 的 `ModelRuntime`**（它自己读 models.json /
auth.json、做 schema 校验、拼凭证优先级，并自带 44 个内置 provider、1500+ 模型目录）。
详见 [`docs/architecture/provider.md`](docs/architecture/provider.md)。

## 测试

```bash
pnpm test           # 全部离线测试（core + tui），不打网络
pnpm typecheck      # 三个包各跑一次 tsc --noEmit
pnpm build          # 构建前端（webui 的 dist/，不在版本库里）

pnpm core:test      # 只跑 core 包
pnpm tui:test       # 只跑 tui 包
```

全程离线（pi-ai 的 faux provider），不消耗 token。覆盖：环闭合、轮数上限、错误路径、
reducer 纯性、轨迹树的不变量（**超时后重试的父 id 指向超时前的节点**）、错误落盘与 JSONL
回放、会话清理、对话区的增量渲染（**没变的块不许重算**）、真实文件 IO。

## 目录

```
packages/core/src/        内核：环 / store / reducer / effects / trace / compact / kernel / 扩展宿主 / 线协议
packages/core/scripts/    配置迁移（migrate-config-dir / migrate-models）
packages/tui/src/         pi-tui 终端界面（main.ts 是入口）+ web server（web/）
packages/tui/bin/ela.mjs  全局 CLI 启动器（只做 tsx 装载，逻辑都在 src/）
packages/webui/src/       浏览器界面（Vite + pi-web-ui；`pnpm build` 出 dist/）
packages/*/test/          离线测试（按包分）
test-support/             测试共享脚手架（配置家目录隔离 + 守卫）
docs/architecture/        架构现状（浏览器界面见 webui.md）
patches/                  pnpm patch：打开 pi-coding-agent 的内部子路径 + 内置的 ask_user_question
~/.pi/agent/              运行时状态：配置 / 会话 / 轨迹（与 pi 共用，不在仓库里）
```

# 装载（prompt / model）与零 token 回放

这一篇讲「内核起来时装了什么」以及「回放时怎么不重跑」。

## 两块，分开装载

`AgentState` 里有两块**会话级**状态，它们是两个独立 action 装进来的：

| 块 | 装它的 action | 装了什么 |
| --- | --- | --- |
| `state.prompt` | `prompt.init` | **拼好的整段 system prompt**（pi 的 `buildSystemPrompt`）＋它的**分段**（`sections`：后来按段 patch 的原料）＋工具的**完整定义** + `seeded` |
| `state.model` | `model.init` | provider / model / thinkingLevel / **能力** + `seeded` |

为什么分开：prompt 是「跟模型说什么」，model 是「用哪个模型说」。两者独立变
（换模型不该动 prompt，追加 prompt 片段不该动模型），落盘时也各自独立。

`seeded` 是「装过了没有」。回放时据此判断 init 段读到没有 —— 没读到就只能重新装配。

## 启动时间线：首帧不等扩展（`deferExtensions`）

### 时间都花在哪（本机实测，`ela` 带三个 npm 扩展）

| 阶段 | 量级 | 能做什么 |
| --- | --- | --- |
| 模块装载（~1600 个模块 / 8.5MB 源码，pi 那一栈 + 各家 provider SDK） | 0.9~1.4s | **打成一个文件**（见下面「打包」一节），降到 ~0.35s |
| 扩展装载（jiti，见 `extensions.md` 的串行装载） | 1~3s（视缓存与打包形态） | **推到后台**（`deferExtensions`） |
| `session_start` + `collectPromptSections`（MCP 连服务器，`direct` 服务器最多等 10s） | 0.4~0.5s | 同上 |
| prompt 拼装 + skill 扫描 + 落盘器 + web 服务 | ~0.1s | —— |

### 试过并否掉的两条

**V8 编译缓存**（`module.enableCompileCache()`，Node 22.8+）：听起来是该做的那件事（把 1600 个
模块的编译产物落盘），实测却是**净亏**。交替 A/B（同一台机器、背靠背跑）：

| | 缓存关 | 缓存开 |
| --- | --- | --- |
| 全局 `ela`（启动器） | **0.96~1.4s** | 1.9~3.7s |
| `node --import tsx src/main.ts`（开发入口） | 0.95~1.06s | 0.86~1.33s（首轮 1.97s） |

所以**没加**。两个可能的原因：一是它的默认目录是**全机器共用**的，这台机器上已经攒到
4 万个文件 / 264MB（平铺在一个目录里），查表比重新编译还贵；二是 launcher 走的是
`tsImport()`，转译后的 TS 是字符串交给 V8 的，本来就吃不到文件级缓存。

**把包根 barrel 换成 `dist/...` 深路径**：直觉上包根把整个交互层 + `main.js` 一并拉进来，换掉
应该省很多。实测**没有收益**（同一台机器，冷进程、多次交替）：

| | 量级 |
| --- | --- |
| `import('@earendil-works/pi-coding-agent')`（包根） | 390~470ms |
| 我们**真正用到**的那些深路径一起 import（resource-loader + tools + sdk + settings-manager +
agent-session + extensions + mcp/codemode/tool-search + components + theme） | 400~500ms |

原因是那 11 个文件的包根引用其实**指向同一批模块**（`sdk.js` 自己就要 provider SDK，
`components` 要 pi-tui），重叠度高到换不换一样。所以没改（改了还要跟着 pi 的目录结构升级）。

### 打包：`pnpm build:tui`（首帧 ~1.0s → ~0.35s）

真正的大头是「读 + 编译 ESM 模块」这件事本身，而不是装了什么。把入口**打成一个文件**之后：

| 量级 | 首帧（PTY 实测，交替跑） |
| --- | --- |
| `tsx` 直装（`ELA_NO_BUNDLE=1`，未打包） | 1044 / 1062 / 1077 / 1593ms |
| 打包产物（`node packages/tui/bin/ela.mjs`） | **318 / 338 / 355 / 370ms** |
| `pi` 自己（`dist/bundle/cli.js`，也是预打包的） | 470 / 471 / 670ms |

拆开看（同一台机器）：

| 测法 | 量级 |
| --- | --- |
| `import('./packages/tui/src/main.ts')`（tsx） | 982~1213ms —— 与首帧基本重合 |
| 只打**我们自己的代码**（`--packages=external`） | 25~32ms |
| 全量打包（含 pi / provider SDK） | import 158~199ms |

所以「首帧慢」和扩展、和 `getTools()` 都无关，就是装载形态。这一步**不改变任何运行时语义**：
执行路径、jiti、扩展 API 全是同一份代码，只是 V8 面对一个文件而不是 1600 个。

#### 四个必须记住的坑（都是实测踩的）

1. **CJS 依赖**（`cross-spawn` 等）：ESM 输出要 banner 补 `createRequire`，否则启动即
   `Dynamic require of "child_process" is not supported`。
2. **`PI_BUNDLED_NODE`**：pi 的扩展 loader 据此决定走「虚拟模块」还是「按 `__dirname` 推别名」。
   不给的话 `__dirname` 变成 `dist/`，**每个扩展都报 `Cannot find module 'typebox'`**（扩展装载
   全灭，而 TUI 自己还是好的）。给了之后扩展拿到的是产物里那份 pi 实例 —— 反而比别名更一致。
3. **`PI_PACKAGE_DIR`**：主题 / 文档 / README / 导出模板都从「pi 的包目录」推，打包后
   `__dirname` 不再指向它。启动器（`bin/ela.mjs` 的 `prepareBundleEnv`）算好真路径注入；
   手工运行产物时要自己带上。
4. **两处 `createRequire(import.meta.url).resolve(...)`**：patch 过的
   `@juicesharp/rpiv-ask-user-question`（问卷少一半）与 `@ela/webui` 的 dist（浏览器界面白屏）。
   同样由启动器注入 `ELA_ASK_USER_QUESTION_PATH` / `ELA_WEBUI_DIST`，两处消费方都写成
   「环境变量优先、解析不到就保持原来的降级」。

#### 什么时候跑产物

启动器按 **mtime** 判断：`packages/tui/dist/ela.mjs` 比 `packages/core` 与 `packages/tui` 的 `src`、
`package.json` 新就跑产物，否则回退 tsx 那条路（`webui` 的 `src` 不算：它只以 dist 路径被引用）。
所以「改完源码忘了构建」不会让你对着旧产物调试；要强制对比两条路用 `ELA_NO_BUNDLE=1`。产物不进仓库（全局 `dist/` 已在 `.gitignore`），`pnpm build` 会先 webui
后 tui 地构建两样。

于是交互式启动的**首帧**：**~3.9s → ~1.15s**（另一半 2.2s 在后台跑完）；
再叠上打包：**~0.35s**（扩展仍在那之后后台装完）。

### 谁先装、谁后装

`createKernel({ deferExtensions: true })`（只给交互式模式，`-p` 不给）把 `createKernel()`
切成两段：

```
store 建好
  ├─ model.init            ← **不依赖扩展**，先装（底栏首帧就要显示 `(provider) model`）
  ├─ 会话记录器（openRecorder）← 计划路径要在 session_start 时就能报出去（见下）
  └─ 后台：扩展装载 → session_start → collectPromptSections → 按 cwd 算工具表
            → 扫 skill → prompt.init                        ← 这一整块可能 1~3 秒
```

`model.init` 之所以要提到前面：底栏在首帧就要画 `(provider) model`，而那份数据只来自
runtime 与启动解析出来的档位 —— 留在后面的话，扩展装载的那几秒里底栏是 `() `（看着像坏了）。

会话记录器要提到**扩展装载之前**：状态类扩展在 `session_start` 那一刻读一次
`ctx.sessionManager.getSessionFile()`，之后不再刷新，而 Orca 这类宿主靠那个路径把
「对话记录在哪」认下来。报的是**计划路径**（空会话不建文件），第一条消息落盘后后续事件
就真的带上 `session_id` + `session_file` —— 详见 [extensions](extensions.md) 的
「agent 生命周期事件」那一节。
轨迹不受这个顺序影响：`beginTrace()` 只认 `state.prompt.seeded` / `state.model.seeded`，
而它要等用户发出第一句话才跑（见上面「推迟到第一句话」那节）。

### 门：`ready` 之前**不许发消息**

这是这一档唯一的硬约束。那一刻 `state.prompt.tools` 与 system prompt 还是「没有扩展」的形状，
先发出去的那条会定下一份**缺工具集**的 head，而 head 是不可改的历史（见 `prompt-head.ts`）——
后面补不回来（模型会在后面的回合里发现工具多了，但第一轮已经发错了）。

所以 `Kernel.ready` 是「此刻的状态能不能拿去发」的唯一定义，两处消费它：

| 谁 | 怎么用 |
| --- | --- |
| 终端（`tui/app.ts` 的 `send()`） | `await ready` 之后再 dispatch `user.message`，并提示「扩展还在装载，装载完就发出去」 |
| 浏览器（`tui/web/bridge.ts`） | 没有用户消息时等 `ready` 再 dispatch，回一条同样意思的 notice |
| 扩展命令的入口 / `pi.sendMessage` | 后者不需要：扩展装载完才有它们 |

两条都是「等」，不是「拒绝」——用户的输入一句都不丢。

### 界面要能在就绪**后**再读一次

`kernel.extensions` 因此是个**活视图**（`get` 转发到当前宿主）：就绪前指向一个空宿主
（与 `--no-extensions` 同形），就绪后指向真的那个。理由很实际 —— 界面在 `createKernel()`
返回时就把 `extensions.commands`、开场横幅那份 `entries` 抓走了，换对象等于它们永远看到空的那份
（症状：扩展的斜杠命令不见了，而没有任何报错）。

同理，`TuiOptions` 那两个字段是**取值函数**而不是值：`extensions` / `extensionCommands`。
开场横幅相应地要报**两次**：首帧那次只能报到「正在后台装载」，`ready` 之后再报一次才是真的
（`[Skills]` / `[Prompts]` / `[Extensions]` / 装载诊断都是那一刻才有的）。

### 失败怎么表现

这一档下装载失败**不抛**（界面已经在跑了，抛没人接）：收进 `kernel.extensions.errors`，
由横幅报出来。默认（不打开这一档）那条路上失败照旧往外抛 —— 一次性模式该响亮地失败。

## 为什么走 action 而不是直接写进 createInitialState

因为「装载」和「跑一轮对话」是**同一类事** —— 都是状态迁移。走 action 才能：

- 被落盘器看见（`createTracePersistence` 是个 store 订阅器，它只认 action 造成的状态变化）
- 被回放
- 在测试里逐字断言

所以 `createKernel()` 建好 store 之后，连着 dispatch 两条 init。装载节点与 init 落盘记录
**推迟到用户发出第一句话**（见下面一节）。

### 扁平别名

`state.systemPrompt` / `providerName` / `modelId` / `thinkingLevel` 仍在 —— 它们是
`prompt` / `model` 里常用字段的**扁平别名**，为了让既有代码（UI、adapter、轨迹渲染）不必到处写
`state.prompt.systemPrompt`。真相在两块里，别处只读，不算独立来源。

每条会改它们的 transition 都要同时更新两边（`prompt.init`、`model.init`、
`model.changed`、`thinking.changed`），漏一处就会出现两份不一致的真相。

## System prompt：拼装全部交给 pi

`packages/core/src/system-prompt.ts`。我们**不拼** prompt，只收集输入然后调 pi 的 `buildSystemPrompt`：

```
promptToolsFrom(cwd)                  → 每个工具的 promptSnippet / promptGuidelines
loadProjectContextFiles({cwd, agentDir}) → AGENTS.md（用户级 + 项目级 + 祖先目录）
loadSkillRegistry({cwd})              → skill 清单
                    ↓
        buildSystemPrompt(…)  ← 官方拼
                    ↓
   preamble + tools + rules + docs + project_context + skills + cwd
```

## 为什么不自己拼

早先这里手写三行中文（"你是编码助手 / 用工具查 / 简短直给"）。那不是“风格不同”，
是**信息缺失**：

| | 手写 | pi 的 |
| --- | --- | --- |
| 工具怎么用 | 「用提供的工具去查」 | 每个工具的 `promptSnippet` |
| `edit` 的坑 | **没有** | oldText 必须精确匹配、多处改动用一次调用、oldText 不要 padding… |
| `bash` 的坑 | **没有** | 用 bash 做 ls/rg/find |
| 项目上下文 | **没有** | 自动扫 `AGENTS.md` |
| 模型站在哪 | **没有** | `<cwd>` 段 |

那些 `edit` 的坑是官方**踩过才写下来的**：模型不知道就会把 `oldText` 写成一大段、
或者对同一个文件连发多次 edit，结果是改了又改不对。手写一份等于把这些经验全扔掉。

实测差别：手写版 3 行 → pi 版含工具规则 11 条、`AGENTS.md`（本机的 Windows/pwsh 约束
也会被扫进去）、`docs` 索引、skill 清单。

## 我们自己一条规则都不写

**规则住在文件里。** pi 有一套完整的文件发现机制（`resource-loader.ts`），我们原样复用：

| 文件 | 位置 | 进哪一段 |
| --- | --- | --- |
| `SYSTEM.md` | `<cwd>/.pi/SYSTEM.md` 或 `~/.pi/agent/SYSTEM.md` | 顶掉 preamble |
| `APPEND_SYSTEM.md` | 同上两个位置 | `<addendum>` 段 |
| `AGENTS.md` / `AGENTS.override.md` / `CLAUDE.md` | 家目录 + 项目 + 每一层祖先目录 | `<project_context>` 段 |

优先级与官方一致：**项目级先于全局**；文件又**优先于命令行参数**（`--system` / `appendPrompt`）。

所以「用用户的语言回答」是 `~/.pi/agent/APPEND_SYSTEM.md` 里的一行 —— 用户自己写、想改就改、
不用改代码。而 `AGENTS.md` 早就是那套机制的一部分（之前就在扫，只是没人往里面写规则）。

**为什么不留代码里的默认值**：`promptGuidelines` 参数确实存在，留一条「项目自己的默认值」
是很自然的想法。但那会让「规则在代码里」和「规则在文件里」**并存** —— 用户改了文件却发现
某条还在，排查时根本想不到去看代码。宁可一条都没有：没有就是「这个项目没配规则」，
从 prompt 一眼看得出来。

### 一处与 pi 的差异：项目信任

pi 的项目级 `SYSTEM.md` 需要 `settingsManager.isProjectTrusted()`（防止在不受信任的目录里
被文件劫持 prompt）。我们不读项目设置，所以**不实现这个判断** —— 项目级那两份一律生效。

这个取舍是安全的：我们跑在用户自己的机器上，而读一份项目内的 `.pi/SYSTEM.md` 与读同目录的
`AGENTS.md` 风险相同（后者无条件生效）。

## `--system` 的语义是 `customPrompt`

给了它就**顶掉 pi 的默认前缀**（官方定义：`replaces the default prefix`），
而默认前缀**包含** `tools` / `rules` / `docs` 三段。所以给了 `--system` 之后：

| 段 | 还在吗 |
| --- | --- |
| `preamble` | 换成你给的那句（**但 `SYSTEM.md` 存在时用它，那个优先**） |
| `tools` / `rules` / `docs` | **没了**（属于被顶掉的前缀） |
| `project_context` / `addendum` / `cwd` | 在（无条件加） |

这不是我们丢的，是官方语义。副作用要知道：如果你给一个很简短的 `--system`，
模型就**不再**知道 `edit` 的那些坑 —— 而 `.pi/APPEND_SYSTEM.md`（追加，不顶掉前缀）
没有这个副作用，所以项目级规则更应该写在那里。

## 拼好的整段会落盘

`writeInit()` 落的是**拼好的那一整段**，不是 `customPrompt` 的原文——
回放时要能重建「当时发给模型的到底是什么」，而 `AGENTS.md` 与 skill 清单都可能已经变了。

## 工具的完整定义进了 state

`prompt.init` 装的是 `PromptToolDefinition[]`：**name / description / parameters 三样**，
不是只装名字。装全的后果：

- `effects.ts` 的 `toolSchemas(state)` 直接从 state 读，不用每次 `getTools()` 现算
  （官方工具在构造时读目录、做边界计算，每次现算不便宜）
- 回放时不必重新装配工具，就知道当时发给模型的是什么

`execute` 不在里面 —— 执行用的工具和发给模型的不是一回事：
`runToolCall` 按名字从注册表取。

`label` 也不在里面（那是我们界面用的中文展示名，不发给模型），
但 `state.toolNames` 有它，因为 UI 要。

## 模型能力

`model.init` 带一个 `ModelCapabilities`，只收三个**真正影响本项目行为**的标志
（pi-ai 的 `Model` 上有几十个 `supports*`，其余对我们没意义）：

```ts
interface ModelCapabilities {
  midConvoSystemMessages: boolean;   // 对话开始后还能插 system/developer
  midConvoToolAdditions: boolean;    // system 消息能否中途引入新工具
  developerRole: boolean;            // 用 developer 而不是 system（OpenAI Responses 一族）
}
```

位置不一样，所以 `readCapabilities()` 分开取：前两个在 `BaseModel` 顶层（pi-ai 的 `Model`
类型没把它们带进公开面，所以按运行时字段读），`developerRole` 在 `compat` 里。

**读不到就当 false。** 保守是对的：「以为支持但实际不支持」会让 pi-ai 把消息发出去然后被
provider 拒；反过来「以为不支持但实际支持」只是少用了个特性。

换模型不会出现「还不知道支持什么」的中间态：`model.changed` 与 `model.init` **同一套载荷**
（`ModelSpec`，`capabilities` / `contextWindow` 都在里面），一条就把整个模型装到位，
不再需要「先清成保守值、等 `model.init` 补上」。

## 中途插入 system / developer

`prompt.segment.added` 追加一段 prompt，role 是 `system` 或 `developer`。

它落进 **`state.messages`**，不是 `state.prompt`：

- 它是 Conversation 的一部分，所以会被一起落盘、一起回放
- 它是**追加**不是替换 —— `state.prompt`（head 的原料）不受影响

带 `sections` 时就是**按段 patch**（`null` = 删段）——`before_agent_start` 的扩展改了
prompt 段就走这里（见 [extensions](extensions.md#before_agent_start发段改动真的采信)）。
形状的要点是「已有消息一个字节不动」：head 在 `state.prompt` 里、patch 在后面追加，
前缀缓存才活得下来（`prompt-head.ts`）。

模型支不支持是**模型**的事（`state.model.capabilities.midConvoSystemMessages`），
我们不自己折：provider 侧 pi-ai 的 `resolveTranscript(context, 支持吗)` 在不支持时走
`collapseSystemMessages()` —— 把整条流里的 system 消息**回放合并**成开头一条。
所以 `prompt.segment.added` 的迁移只管把消息放进去。

## thinking（reasoning）

三个概念要分清：

| | 是什么 |
| --- | --- |
| `state.model.thinkingLevel` | **请求参数**（reasoning effort）。`off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| `ThinkingContent` | **输出**。`{type: 'thinking', thinking: string}` —— 确实是文本 |
| `state.thinkingText` | 本轮流式累积的思考文本（UI 用） |

所以「思考输出是文本」—— 但它**不是 assistant 正文**。它走独立的 `thinking` content 块，
和正文 `text` 块分开，在 `AssistantMessage.content` 里是两种 entry。

它也是**请求参数而不是输出格式**：设了 `high` 不代表模型一定回馈 thinking，
很多模型直接不给。回馈时才走 `thinking_delta` 事件。

`effects.ts` 里读的是 `state.model.thinkingLevel`（不是扁平别名），因为那是 model 块的真相。

它**从哪来**（五条来源 + clamp）与**写到哪去**（settings / 会话文件）不在这篇：见
[thinking](thinking.md)。两处最常问的：「默认为什么是 high」（默认 medium + 模型只认
low/high/max + 向上取整），以及「默认值怎么存」（`/thinking` 面板的 `Ctrl+S`）。

## Hooks = 洋葱式 middleware

「Hooks」在本项目里**不是** system prompt 的附属品，而是一层横切所有 action 的拦截器
（`packages/core/src/middleware.ts`）：

```
dispatch(action)
  → m1 前 ── m2 前 ── [reducer] ── m2 后 ── m1 后
```

`before` 正序（外 → 内，最后一个离 reducer 最近），`after` **逆序**（内 → 外，最外层最后收尾）。

为什么需要两种时机：agent 里有些事必须在**状态变化之前**决定（改写 action、丢弃它），
有些必须在**之后**做（审计、追加 prompt 片段、埋点）。prompt 装载是后者的典型。

`promptSegmentMiddleware` 是唯一的实例：它看到 `user.message` 就在其后 dispatch 一条
`prompt.segment.added`。它不需要知道 prompt 是什么，也不需要改 reducer ——
**reducer 因此完全不需要知道这个扩展点存在。**

### 现在是骨架

类型与洋葱语义都在，但**没有注册表、也没挂进 dispatch 的时机** —— 那要等 store 层接上去。
在那之前 middleware 只能被手动调用（`applyMiddleware`），这也是测试里唯一能证明语义正确的方式。

测试覆盖了四件事：洋葱顺序（`外前 → 中前 → 内前 → 内后 → 中后 → 外后`）、
`before` 返回 `null` 丢弃整条 action、`before` 改写、`after` 追加。

## 落盘：一个文件

装载段写在**同一个轨迹文件里**（新会话落在开头几条之后，回放按 op 类型收集，行序无关）。
以前是分开两个文件，理由是「生命周期不同」
（装载是会话级的，轨迹节点是对话级的）—— 但那个理由不成立：回放只认自己那几种 op，
装载记录它一律忽略，不会让回放多干任何事。而每个会话多一个文件，目录里全是 jsonl 很难翻。
实测同一台机器上多个会话的 init 文件内容完全相同（prompt 和 tools 没变），一半是重复。
老会话已由一次性迁移脚本合并，回退读的代码路径（`loadInit` / `initPath` / `initPathFor`）一并删掉了。

| 文件 | 内容 | 记录类型 |
| --- | --- | --- |
| `~/.pi/agent/traces/<时间戳>_<id>.jsonl` | 装载 + 对话 + 轨迹 | `prompt.init`、`model.init`、`message`、`add`、`close` |

`message` 记录是**零 token 回放**的关键：每条对话消息（user / assistant / toolResult /
中途插的 system 段）都追加一行，回放时按顺序重放就重建出 `messages`。

## 进入会话不建节点：推迟到用户发出第一句话

`prompt.init` / `model.init` 一进来就把 state 装满，但**不开轨迹节点**。装载节点
（`prompt.base` / `prompt.tools` / `prompt.skills` / `model.init`）由 reducer 在**第一条
`user.message`** 里补上（`reducer.ts` 的 `beginTrace()`），`init` 落盘记录则由内核盯着
`state.traceBegun` 翻转的那一刻补写（`kernel.ts`）。

```
内核装配         prompt.init / model.init  → state 满了，树上 0 个节点，traces/ 里没有文件
用户发第一句话   user.message              → 装载节点补在前面，然后是 user 节点
                                       → 落盘器写出整个文件，内核补 init 记录
```

**为什么不一起做**：装载必须**立刻**可用（开场报 skill 清单、`/skill:x` 能展开、底栏显示
模型），但「留痕」不该早于「真的有对话」。进来看一眼就退出是常态，而那时：

- 切到轨迹页一打开就是一屏提示词摘要、工具名、能力标记（四个节点）；
- `traces/<时间戳>_<id>.jsonl` 已经被建出来，里面只有两条 init 记录、零条对话。

会话文件那边早就是同一个决定（`SessionWriter.start()` 记下 header 但不落盘，
见 [sessions](sessions.md)「空会话不落盘」）—— 两边的「会话」起点现在一致了：
**发过第一句话才算一段会话**。

**补出来的节点从 state 读**，所以它反映的是发第一句话那一刻**生效**的那一版装载
（期间热重载过 prompt 也算数），与模型真正看到的一致。

开局之后再来的装载分两种，口径不同：

- **`prompt.init`（热重载）**：当场**追加**一对新节点，旧的不改写（文件变了、我们重读了一遍，
  什么时候生效要看得到）。
- **`model.changed`（换模型）与 `thinking.changed`（换档位）**：只置
  `state.modelTraceDirty`，等到**下一次真要发消息**时补**一个** `model.changed` 节点
  （`flushModelChange()`），落在 user / `turn.start` 之前。理由：切换是界面动作，
  树上要回答的是「这一轮实际用的上下文是什么」；来回切三次不该留下三个节点。
  细节见 [trace](trace.md) 的「换模型 / 换思考级别」一节。

### 谁负责写 init 记录

内核，不是界面。每个调用方都记得调一次 `writeInit()` 是靠不住的 —— 忘了就等于这次会话
的 init 段永远缺失，而症状很隐蔽：回放时仍然能跑（不校验），只是**每次回放都要重新装配
工具**，而当时的目录内容可能已经变了。判据只有一个（`state.traceBegun`），与 `trace.begin`
那一步是同一个事实。

`restoreSession()` 是个例外：那个会话的轨迹文件里**已经有** init 段了，补一份只是磁盘上的
垃圾行，所以那里把标记直接置真。

## 零 token 回放

装载段和对话**在同一个文件里，所以也只有一次读取**：

```ts
const session = await loadSession(sessionId);
// { tree, messages, init: { prompt, model } }
```

一个对象里就有了：

- 当时发给模型的是什么（prompt + tools 定义）—— 不用重装配工具
- 这个模型支持什么（capabilities）—— 不用再问 provider
- 模型答了什么、工具返回了什么 —— 不用再调一次模型

**一条 token 都不花**，一整轮对话连同轨迹树原样复现。回放跳过的坏行只有一种：
崩溃时截断的半行（`JSON.parse` 失败直接丢）。

`loadTrace()` 保留着（只要树不要消息和装载段），给不想重建 messages 的调用方用。

## 相关

- 环怎么转 → [loop](loop.md)
- 轨迹树本身 → [trace](trace.md)
- 内核装配 → [kernel](kernel.md)
- 上下文满了怎么办 → [compact](compact.md)

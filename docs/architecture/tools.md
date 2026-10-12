# 工具

## 来自 `@earendil-works/pi-coding-agent`

工具不是自己写的，是 Pi 官方 coding agent 用的那一套。源码在那个仓库的
`packages/coding-agent/src/core/tools/`。

```
createCodingTools(cwd, options)     → [read, write, edit, bash]
createReadOnlyTools(cwd, options)   → [read, grep, find, ls]
```

另有 8 个单独的工厂：`createReadTool` / `createWriteTool` / `createEditTool` / `createBashTool` /
`createGrepTool` / `createFindTool` / `createLsTool` / `createPowerShellTool`，
以及对应的 `*Definition` 版本（不包装成可执行工具，只给扩展机制用）。

本项目用的是全部 8 个（下面那张表）。

## 八个工具：四个默认开，四个默认关

开关走 `settings.json` 的 `defaultTools`，**与 pi 同键同文件**：

| 工具 | 默认 | 干什么 | 外部依赖 |
| --- | --- | --- | --- |
| `read` | **开** | 读文件 | — |
| `write` | **开** | 写/覆盖文件 | — |
| `edit` | **开** | 按 oldText 精确替换 | — |
| `bash` | **开** | 执行 bash 命令 | bash |
| `powershell` | **开** | 执行 PowerShell 命令 | pwsh |
| `grep` | 关 | 按正则搜文件内容 | ripgrep |
| `find` | 关 | 按 glob 找文件 | fd |
| `ls` | 关 | 列目录内容 | — |

默认那四个从 pi 的 `DEFAULT_TOOL_NAMES` **读**（不是抄一份字面量），所以 pi 调整默认清单时
本项目跟着变。`grep` / `find` / `ls` 默认关是 pi 的判断：多数时候 `bash` 就够了。

`powershell` 在**所有平台**都开（与 pi 一致）：`bash` 仍在，powershell 只是多给模型一个选择。
少给一个会让模型在 pwsh 语法上反复失败 —— 它在 Linux 上学到的是 bash。

### 怎么开

`~/.pi/agent/settings.json`：

```json
{ "defaultTools": ["read", "bash", "edit", "write", "+grep"] }
```

规则逐条照抄 pi 的 `resolveDefaultTools()`（实现在 `tools.ts` 的 `resolveToolSelection`）：

- **不给** → 默认那四个
- 出现**不带前缀**的名字 → 整份清单**替换**默认那份（`["grep"]` = 只有 grep）
- 只有 `+name` / `-name` → 在默认那份上按顺序增删

未知名字不报错也不剔除，与 pi 一致 —— 那个工具不存在，于是没开成。

### prompt 侧与工具侧必须是同一份清单

`promptToolsFrom()`（system prompt）与 `getTools()`（注册表）**共用
`selectedBuiltinToolNames()`**。两边若各读一次配置，就会在改配置时对不上，
而症状是**静默**的：prompt 教了模型怎么用 `grep`，工具表里却没有，一调就回
「未知工具」，日志里没有任何线索指向「清单不一致」。

## 换来了什么

自己写要花很多功夫、而且容易写漏的东西：

- **路径边界检查** —— 工厂第一个参数 `cwd` 在构造时就烤进闭包，模型跑不出这个目录
- **文件变更串行化** —— `withFileMutationQueue`，并发 `edit` 不会互相踩
- **截断策略** —— `truncateHead` / `truncateTail`，大文件不会把上下文撑爆
- **bash 超时与子进程回收** —— 含 signal-killed shell 的退出码约定

## 那层适配

官方 `AgentTool`（类型来自 pi-agent-core）的 execute 是**四个**参数：

```ts
execute(toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult>
```

本项目用前四个（第五个 `ctx` 由对方运行时注入，不在公开契约里）。
`src/tools.ts` 的 `adapt()` 做两件事：

1. **签名收窄** —— 丢掉 `ctx`，并把 `onUpdate` **转成本项目的 `AgentToolUpdate`**，
   成本项目的 `AgentTool` 形状
2. **补两个字段** —— `label`（中文名，界面显示用）；
   `details` 归一（官方有些工具返回 `undefined`，本项目要求有值）

逻辑一行不改。于是 `effects.ts` 完全不知道 pi-coding-agent 存在，环的逻辑一行都不用改。

> 界面渲染用的是 `create*ToolDefinition()`（`src/tui/app.ts`），不是这里的 `AgentTool` ——
> 前者带 `renderShell`（`edit` 是 `"self"`），后者不带。两者形状不同，别混用。

## 五个参数不是公开契约

官方工具的 execute 在实现上是五个参数（末尾还有个 `ctx`，给 `bash` 传 `cwd` 用），
但 `AgentTool` 类型只声明了四个。**照类型走，只传四个**。

`bash` 的 `cwd` 是**工厂函数**的参数（`createBashTool(cwd)`），不是 execute 的第五个参数 ——
第一次接的时候传错了，报 `Working directory does not exist: undefined`。

## 注册表分两层

```ts
const registries = new Map<string, readonly AgentTool[]>();   // 官方工具，按 cwd
const extensionTools: AgentTool[] = [];                        // 扩展工具，不按 cwd

export function getTools(cwd = process.cwd()) {
  const key = path.resolve(cwd);
  let tools = registries.get(key);
  if (!tools) { tools = build(cwd); registries.set(key, tools); }
  return extensionTools.length === 0 ? tools : [...tools, ...extensionTools];
}
```

官方工具必须按 cwd 缓存，不能用单个全局值：它们在构造时就把 cwd 烤进闭包了，
换个 cwd 还复用旧实例的话，路径边界还是老的。用 `path.resolve` 做 key，免得 `'x'` 和 `'./x'`
各建一份。

扩展工具**不按 cwd**，因为它们已经自己拿到了 `ctx.cwd`（见
[extensions](extensions.md)），而且**不能**按 cwd 重建：重建等于把 jiti 已经装载好的
模块重新适配一遍，白花开销。

`registerExtraTools()` 有两个细节：

- **同名时官方工具优先** —— 否则一个扩展能把 `bash` 顶掉。判据是**官方那一层**的名字
  （不能用 `getTools()`，那个已经合并了扩展工具，会变成循环依赖）。
- **必须在 `prompt.init` 之前调**（内核保证）。反过来的话 `prompt.init` 已经把工具
  清单装进 state 了，扩展工具就只存在于注册表、模型看不见 —— 而症状是「工具调用永远
  回『未知工具』」，界面上那个工具块连参数都画不出来。

## 执行路径

工具由环自己跑，不在 effect 表里：

```
llm.done（有 toolCall）
  → 接线发 Cmd.run(executeToolCalls)
      → executeToolCalls 内部：dispatch(tool/start)   ← 开 tool.call 节点
                          await getTool(name).execute(call.id, args, signal)
                          dispatch(tool.result)      ← 开 tool.result / error 节点
      → 成功 actionCreator：tool.batch.done
```

`tool/start` 与 `tool.result` 是 `executeToolCalls` 内部 dispatch 的，所以轨迹上的工具节点
和 LLM 节点是同一套机制。

工具抛错不会炸环：`runToolCall` catch 住，包成 `isError: true` 的 `ToolResultMessage`，
在树上开一个 `error` 节点（**不推进 tip**），然后照常回到 LLM。

## 长命令边跑边显示

`npm install`、带 sleep 的脚本、编译 —— 这些动辄几十秒。**命令一开跑就什么都不显示，
直到结束才突然蹦出一块**，那几十秒的空白与「卡死了」在屏幕上没有区别。

所以 `onUpdate` 这一路是接上的（早先传的是 `undefined`，等于关掉了官方的流式通路）：

```
tool/start
  → execute(…, onUpdate)            ← 官方 bash 内部节流后每收到一块输出就回调一次
      → dispatch(tool.progress)     ← reducer 存进 state.toolProgress
          → 界面每帧重画那个「正在跑的工具块」
tool.result                        ← 终值进 messages，同时清掉 toolProgress
```

**中间输出不进 `messages`**（`state.toolProgress` 单独存）：`messages` 是发给模型的那份历史，
只该有终值。中间态进去会有三个麻烦 —— 每个增量都要去重、流式途中被 Ctrl-C 掉会在
messages 里留下一个**没有结果的 toolCall**（协议非法，provider 直接拒）、落盘器会把
中间态写进会话文件。

界面上那一块走的是官方的 `ToolExecutionComponent` + `updateResult(…, isPartial: true)`，
于是「进行中」的样子是官方给的：pending 底色、接受不完整的输出、折叠保留尾部 5 行。
**代价**：`Elapsed` 不再每秒自己跳（那需要组件跨帧活着，而我们每帧重建一次），而是跟着
输出更新 —— 对「边跑边有输出」的命令没差别。

细节见 [surfaces](surfaces.md)。

## 工具在哪执行

这四个工具全都直接摸真实文件系统、起真实子进程，所以它们**只在 Node 侧的环里**执行。
界面只是发消息、画结果，不注册任何工具。

## 加自己的工具

本项目 `AgentTool` 形状很简单（`src/agent-tool.ts`），照着写再 push 进 `build()`：

```ts
const myTool: AgentTool = {
  name: 'my_tool', label: '我的工具', description: '…',
  parameters: Type.Object({ x: Type.String() }),
  execute: async (id, params, signal) => ({
    content: [{ type: 'text', text: '…' }],
    details: null,
  }),
};
```

`details` 必须是 `JsonValue`（pi-ai 1.x 收紧了）—— 它要进消息流、存盘、发给 provider，
所以本来就得能真的 JSON 序列化。

**扩展提供的工具走另一条路**（`registerExtraTools()`，不是 `build()`）：它们由 pi 的
扩展运行时装载、拿第五个 `ctx` 参数，详见 [extensions](extensions.md)。

## Skill —— 也在 pi 那一侧（`src/skills.ts`）

skill **不是工具**，是给模型看的「遇到这类任务怎么做」的说明书：一个带 frontmatter
（`name` + `description`）的 `SKILL.md`，正文是说明书。

模型**不会自动加载**正文 —— prompt 里只列一张清单（名字 + 描述 + 文件位置），任务对上号时
它自己调 `read` 去读那个文件。省 token 是这一层的全部意义。

目录（与 pi 一致，但**比 pi 多一处**，见下）：

```
~/.pi/agent/skills/<名字>/SKILL.md    ← 用户级（pi 自己的）
~/.agents/skills/<名字>/SKILL.md      ← 跳工具约定（pi 也扫）
<工作目录>/.pi/skills/<名字>/SKILL.md ← 项目级
<工作目录>/.agents/skills/<名字>/SKILL.md
<工作目录的每一层祖先>/.agents/skills/  ← 到家目录为止
```

再加 `--skill <路径>`（可重复）。

### 扫哪几个目录：这里踩过一个真坑

**`loadSkills()` 那个便捷函数不扫 `~/.agents/skills`。** 它只扫
`<agentDir>/skills` 与 `<cwd>/.pi/skills` —— 而 pi 自己**还扫** `~/.agents/skills`
（跳工具的通用约定，见 https://agentskills.io）。

照 `loadSkills()` 的默认行为写，后果是「一个 skill 都没有」：开场没列表、`/` 补全里
也没有。实测一台机器上 **55 个 skill 全在 `~/.agents/skills`，而 `~/.pi/agent/skills`
根本不存在** —— 这是静默退化，不报任何错。

所以 `loadSkillRegistry()` 显式补扫，用**已导出的** `loadSkillsFromDir()`（它与 pi
内部私有的 `collectSkillEntries()` 规则相同：找 `SKILL.md`、认 gitignore、目录里有
SKILL.md 就不再往下递归）。

**为什么不 pnpm patch 把那两个私有函数放出来**：patch 能改文件，但这里要改的是
**运行时的资源发现语义**（多扫哪几个目录、什么条件下扫），不是 `exports` 字段。patch
一旦被 pnpm 重新生成或上游升级就丢，而丢掉的症状是「skill 又全没了」。为一个已经有
等价公开 API 的需求去改 vendor 语义，不划算。

### 祖先目录的上界：家目录，不是 git 根

pi 的 `collectAncestorAgentsSkillDirs()` 上界是 git 仓库根。但 `gitRoot` 为 null 时
（cwd 不在任何仓库里 —— 临时目录、容器、CI），那个循环会**一直走到盘符根**：于是
`C:\Users\<名>\AppData\Local\Temp\某临时目录\project` 会扫到 `C:\Users\<名>\.agents\skills`，
也就是开发者自己家目录里的几十个 skill。

测试会因此读到真实家目录，断言变成「这台机器上碰巧过」。所以这里取**家目录**作上界，
并且额外判「home 在不在 cwd 的祖先链上」—— cwd 不在 home 下面时（临时目录就是这么）
立刻停下，否则照样越界。

真实项目里 git 根在 cwd 与家目录之间，所以这个上界**不改变** pi 在项目里的行为。
要用仓库根**以上**的 `.agents`（monorepo 子目录想用上层共享 skill）请显式 `--skill`。

### 复用了 pi 的什么

整套都是官方的，本项目只做三件薄薄的事：

| 本项目 | 直接调 pi 的 |
| --- | --- |
| `loadSkillRegistry()` | `loadSkills()` |
| （没了 —— 清单进 `<skills>` 段） | `formatSkillsForPrompt()`（Agent Skills 标准的 XML） |
| `expandSkillCommand()` | 与 pi 的 `_expandSkillCommand()` 逐字同形 |

**不自己扫目录、不自己解析 frontmatter、不自己拼 XML。** 那样只会得到一个会漂移的副本：
pi 改了标准的细节，我们这边不会跟着动。

`/skill:<名字> [问题]` 展开成 `<skill name=… location=…>正文</skill>` 加在问题前面 ——
所以官方 `parseSkillBlock()` 能还原，界面用官方 `SkillInvocationMessageComponent`
画成可折叠块（Ctrl+O 展开）。形状与 pi 一致。

### 两个坑

- **家目录走 `configHome()`**（它转发 pi 的 `getAgentDir()`），而不是各处自己拼路径。
  早先本项目另有 `REDUX_AGENT_DIR` 且优先级高于 pi 的那个，而 pi 不认它 —— 那个状态下
  skill 会永远从真实家目录加载。现在只剩一个变量，两边不可能分家。
- **清单是 `prompt.init` 时定下的。** 之后往目录里加 skill 不会自动生效，要 `/new`
  换个会话（system prompt 在装载时拼好）。界面因此只认 `state.prompt.skills`，
  不重新扫目录 —— 重新扫会得到一个**模型看不到**的清单。

### 与 prompt 的关系

清单进 system prompt 的 **`<skills>` 段**，由 pi 的 `buildSystemPrompt` 拼
（`src/system-prompt.ts`）—— 不再由 reducer 接在尾巴上。

差别不只是“谁拼的”：接在尾巴上时那是一段**没有标签的裸文本**，模型不知道那是系统给的
规则还是用户说的话；`<skills>` 是有边界的段。更要紧的是**只有一处**会拼 ——
两处各拼一遍（内核拼一次、reducer 再接一次）迟早漂移，而症状是「清单出现两次」：
token 白花且模型困惑。

落盘的是**拼好的那一整段**，所以回放时读到 init 段就知道当时发给模型的完整 prompt
是什么，不必重新扫目录（那时的目录内容可能已经变了）。轨迹树上也有一个
`prompt.skills` 节点。

### 开场要报清单，而且常驻

prompt 里那份清单**用户看不见**。不报出来的话，用户既不知道有哪些 skill 可用，也不会
想到打 `/skill:<名字>` —— 功能等于没装。所以启动时打印一节 `[Skills]`，加载诊断打成
`[Skill 警告]`（pi 是 `[Skill conflicts]`）。

**常驻，永不消失** —— 与 pi 一致（那边是 `loadedResourcesContainer` 里的常驻组件，
不是会超时的提示）。名单要反复对照着打 `/skill:x`，30 秒后消失等于没有。
实现上因此有**两个独立的槽位**：`statusCards`（命令反馈卡，钉在对话流里）与 `banner`（开场那节，常驻对话区顶部）。
早先开场那节走 `notify()` + 30 秒，于是用户往上翻找刚才那条提示时它已经没了。

名单照 pi 的 `formatCompactList()`：**排序后逗号连排**，剩下交给终端折行。不排序的话
清单顺序取决于目录遍历，每次启动都不一样。55 个名字折十几行是正常的（pi 截图里也是
多行）—— 不截断，名字列表的价值就在于能扫到某一个。

诊断**原来打到 stderr**，TUI 模式下用户看不见，而「某个 skill 没加载上」正是静默退化
（模型少了能力，界面与用户都不知道原因）。所以它们进 `state.prompt.skillDiagnostics`，
由界面显示。

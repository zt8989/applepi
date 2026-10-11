import path from 'node:path';
import type { AgentTool, AgentToolResult } from './agent-tool';

/**
 * 内置工具集。
 *
 * 这里的工具**不再是自己实现的** —— 来自 `@earendil-works/pi-coding-agent`
 * （源码在那个仓库的 `packages/coding-agent/src/core/tools/`），也就是 Pi 官方
 * coding agent 用的那套：`read` / `write` / `edit` / `bash`。
 *
 * 换来的好处是实打实的：路径边界检查、文件变更串行化（`withFileMutationQueue`）、
 * 截断策略、bash 超时与进程回收 —— 这些自己写要花很多功夫，而且容易写漏。
 *
 * ## 为什么要一层适配
 *
 * 官方的 `AgentTool`（来自 pi-agent-core）execute 签名多两个尾参：
 *
 *   execute(toolCallId, params, signal, onUpdate, ctx)
 *
 * 我们自己的 effect 只需要前四个（ctx 由对方运行时注入，不在公开契约里）。
 * 所以这里把第五个丢掉、把第四个**转成本项目的 `AgentToolUpdate`**，
 * 签名收窄成本项目的形状 —— `effects.ts` 完全不知道 pi-coding-agent 的存在。
 *
 * ## `onUpdate` 这一层是干什么的
 *
 * 官方的 bash 工具有一个 `onUpdate` 回调：每收到一块输出就调一次（内部有节流），
 * 于是长命令（`npm install`、`sleep 30 && echo done`）能**边跑边显示**，
 * 而不是「卡住几十秒然后突然蹦出一坨」。
 *
 * 早先这里传的是 `undefined`，那条路完全没用上：界面直到命令结束才动 ——
 * 而「不知道它在跑什么」与「以为卡死了」只差一秒。
 *
 * `parameters` 那边也有个细节：官方用的是 typebox 的 `TObject`，本项目声明的是
 * pi-ai 的 `TSchema`。两者同源（都出自 typebox），直接给即可。
 */
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createPowerShellTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent';
import type { AgentTool as OfficialTool } from '@earendil-works/pi-agent-core';
import { loadPiSettings } from './pi-config';

/** 官方工具 → 本项目工具。只做签名收窄，逻辑一行不改。 */
function adapt(official: OfficialTool<any>, label: string): AgentTool {
  return {
    name: official.name,
    // 官方 label 就是英文工具名；这里给个中文的，界面读它。
    label,
    description: official.description,
    parameters: official.parameters as AgentTool['parameters'],
    async execute(toolCallId, params, signal, onUpdate) {
      // onUpdate 的参数形状与我们自己的 `AgentToolUpdate` 相同，只是来自不同包
      // （pi-agent-core vs 本项目）—— cast 过去即可，运行时无差别。
      //
      // **不能传 undefined**：那就等于关掉了官方的流式输出，长命令会在界面上
      // 「卡住几十秒然后突然蹦出一坨」，看起来像卡死了。
      const result = (await official.execute(
        toolCallId,
        params as never,
        signal,
        onUpdate as never,
      )) as AgentToolResult;
      // 官方有些工具的 details 是 undefined，本项目的 AgentToolResult 要求有 details。
      return {
        content: result.content ?? [],
        details: result.details ?? null,
      };
    },
  };
}

/**
 * 工具注册表。cwd 是工作目录 —— 官方工具用它做路径边界检查
 * （防止 LLM 跑到工作目录外面去读写文件）。
 */

/**
 * 八个内置工具：哪些默认开、哪些默认关。
 *
 * 与 pi 完全一致（`DEFAULT_TOOL_NAMES` + 它帮助里的那张表）：
 *
 * | 工具 | 默认 | 说明 |
 * | --- | --- | --- |
 * | `read` / `write` / `edit` / `bash` | **开** | 四个基本工具 |
 * | `powershell` | **关** | Windows 原生 shell；`bash` 走 Git Bash/WSL，用 `+powershell` 显式开 |
 * | `grep` / `find` / `ls` | **关** | 只读检索类，pi 觉得多数时候用 bash 就够了 |
 *
 * ## 为什么自己维护这张表而不调 pi 的 `createCodingTools()`
 *
 * 官方那两个工厂的分组表达不了这四件事：`powershell` 不在 `createCodingTools()`
 * 里（它在 `createAllTools()`），而 `createAllTools()` 返回的是 map 不是数组；
 * 更关键的是它**不区分默认开关** —— 语义上「有哪些工具」与「默认开哪些」是两件事。
 *
 * 默认集合从 pi 的 `DEFAULT_TOOL_NAMES` **读**（见 `resolveToolSelection`），
 * 这样一个字都不重复维护：pi 改了默认清单，我们跟着变。
 */

/** 官方工具名（与 pi 的 `ToolName` 同一套拼写）。 */
export const BUILTIN_TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'bash',
  'powershell',
  'grep',
  'find',
  'ls',
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/**
 * pi 的默认值：`["read", "bash", "edit", "write"]`。
 *
 * **从 pi 读而不是抄一份字面量**：它是个 `export const`（不是内部实现），
 * 改了会跟着变；而抄一份的后果是 pi 调整默认工具后我们无声地留在旧行为上。
 * 读不到就退回我们自己那一份（见 `resolveToolSelection` 的注释）。
 */
function piDefaultToolNames(): readonly string[] {
  try {
    // 同步 require 拿常量：`dist/core/settings-manager.js` 被主入口拉进来时要 2.6s，
    // 而这里只是要一个四元素的数组。require 走的是已加载的模块缓存，静态 import
    // 则会把整个包拖进启动路径（`pi-config.ts` 的文件头解释了那个代价）。
    const mod = require('@earendil-works/pi-coding-agent/dist/core/settings-manager.js') as {
      DEFAULT_TOOL_NAMES?: readonly string[];
    };
    if (Array.isArray(mod.DEFAULT_TOOL_NAMES) && mod.DEFAULT_TOOL_NAMES.length > 0) {
      return mod.DEFAULT_TOOL_NAMES;
    }
  } catch {
    // 读不到就用下面那个字面量 —— 见 resolveToolSelection 的注释。
  }
  return ['read', 'bash', 'edit', 'write'];
}

/**
 * 解出「默认开哪些工具」。
 *
 * ## 语义**逐条照抄** pi 的 `resolveDefaultTools()`
 *
 * 1. `entries` 为空（没有任何 `defaultTools` 配置）→ 用 `DEFAULT_TOOL_NAMES`；
 * 2. 出现**不带前缀**的名字 → 整份清单被**替换**（不是追加），`+`/`-` 再在上面打补丁；
 * 3. 只有 `+name` / `-name` → 先取默认清单，再按顺序应用增删。
 *
 * 为什么自己写而不调官方的 `SettingsManager`：那一整套要读磁盘上的多层 settings
 * （项目 / 全局 / 内置），而本项目只认 `~/.pi/agent/settings.json` 一个文件
 * （见 `pi-config.ts` 的 `loadPiSettings`）。引整个设置管理器会连它自己的
 * 多层合并规则一起引进来，而我们只用得上最后那一步 —— 两处各有一份「最终值」
 * 反而更危险。规则本身照抄，所以结果与 pi 一致。
 *
 * 未知名字**不报错也不剔除** —— 用户写错一个名字时的表现应该和 pi 一样：
 * 那个工具不存在，于是没开成。（严格剔掉反而会让人以为「写了但被禁用了」。）
 *
 * @param settings `settings.json` 的 `defaultTools`；undefined = 没配。
 */
export function resolveToolSelection(settings: readonly string[] | undefined): readonly string[] {
  const defaults = [...piDefaultToolNames()];
  if (settings === undefined) return defaults;
  const isModifier = (entry: string): boolean =>
    entry.startsWith('+') || entry.startsWith('-');
  const plain = settings.filter((entry) => !isModifier(entry));
  // 「有 plain 就替换，没有 plain 才用默认」—— 与官方 resolveDefaultTools 一致。
  // 官方那边 `entries.length === 0` 也走这一支（空数组 = 用默认）。
  const tools = plain.length > 0 ? plain : defaults;
  for (const entry of settings) {
    if (!isModifier(entry)) continue;
    const name = entry.slice(1);
    const index = tools.indexOf(name);
    if (entry.startsWith('+') && index === -1 && name) {
      tools.push(name);
    } else if (entry.startsWith('-') && index !== -1) {
      tools.splice(index, 1);
    }
  }
  return tools;
}

/**
 * 按名字建一批工具实例（cwd 烤进闭包，所以必须真的构造，不能复用别处的实例）。
 *
 * **不在这里过滤未知名字**：表里列出的是「已知存在但默认关」的那几个，
 * 开关由 `getTools()` 按 `defaultTools` 的解析结果来做。分两层是因为
 * 「造得出来」与「开不开」是两件事 —— 前者是能力问题，后者是用户配置问题。
 */
function createBuiltin(cwd: string, name: BuiltinToolName): AgentTool | undefined {
  switch (name) {
    case 'read':
      return adapt(createReadTool(cwd), '读文件');
    case 'write':
      return adapt(createWriteTool(cwd), '写文件');
    case 'edit':
      return adapt(createEditTool(cwd), '编辑文件');
    case 'bash':
      return adapt(createBashTool(cwd), '执行命令');
    // **所有平台都给**（包括没显式开它的默认配置）：与 pi 一致 —— 一旦被选中就构造，
    // 不按平台过滤。Windows 上这两个最像（bash 走 Git Bash/WSL，powershell 走 pwsh），
    // 让模型自己选；少给一个会让模型在 pwsh 语法上反复失败（它在 Linux 上学到的是 bash）。
    // 注意：这只管「造不造得出」，默认**不开**，要 `+powershell`（见 resolveToolSelection）。
    case 'powershell':
      return adapt(createPowerShellTool(cwd), '执行 PowerShell 命令');
    case 'grep':
      return adapt(createGrepTool(cwd), '搜索文件内容');
    case 'find':
      return adapt(createFindTool(cwd), '按文件名查找');
    case 'ls':
      return adapt(createLsTool(cwd), '列目录');
  }
}

/** 全部内置工具实例（**不区分默认开关**）。 */
function build(cwd: string): readonly AgentTool[] {
  return BUILTIN_TOOL_NAMES.map((name) => createBuiltin(cwd, name)).filter(
    (tool): tool is AgentTool => tool !== undefined,
  );
}

// 按 cwd 缓存：官方工具在**构造时**就把 cwd 烤进闭包（路径边界检查靠它），
// 所以同一个 cwd 复用同一批实例；换个 cwd 必须重建，否则边界还是旧的。
// 用绝对路径做 key，免得 'x' 与 './x' 各建一份。
//
// 缓存的是**全部**内置工具（不管开不开）：开关是**启动时**算一次的，
// 不该有「同一个 cwd 先取一次、后取一次拿到不同集合」的诡异行为 ——
// 那种不一致会让 prompt.tools 与实际能跑的表对不上，而症状是「模型说调了却回未知工具」。
const registries = new Map<string, readonly AgentTool[]>();

/** 全部内置工具实例，按 cwd 缓存。 */
function allBuiltins(cwd: string): readonly AgentTool[] {
  const key = path.resolve(cwd);
  let tools = registries.get(key);
  if (!tools) {
    tools = build(cwd);
    registries.set(key, tools);
  }
  return tools;
}

/**
 * 记住上次算出来的开关。
 *
 * ## 为什么需要它
 *
 * `getTool(name)` 在**每次工具执行**时都调一次（`effects.ts` 的 `runToolCall`），
 * 而它走 `getTools()`。而开关来自 `settings.json` —— 每次都 `readFileSync` 的话，
 * 「跑一次工具」就变成「多一次同步磁盘读」。长会话里工具调用几十上百次，
 * 那是白花开销，而配置文件在进程生命周期内基本不变。
 *
 * ## 什么时候重算
 *
 * 换 cwd（key 变了）→ 重算；测试调 `resetTools()` → 重算。
 * 中途手改 settings.json **不**触发重算 —— 与 pi 一致（它的 `defaultTools` 也是
 * 启动时读一次），改完重开即生效。
 */
let cachedOn: { key: string; names: ReadonlySet<string> } | undefined;

/**
 * 当前 cwd 下**开启**的内置工具名 —— prompt 侧与工具侧的唯一真相。
 *
 * `system-prompt.ts` 的 `promptToolsFrom` 与 `tools.ts` 的 `getTools` **都调它**。
 * 这不是去重，是**必需**：两边若各读一次 settings.json，其中一边还带缓存，
 * 就会在「中途改了配置 / 缓存失效时机不同」时对不上 —— 而症状是静默的
 * 「模型调了工具却回未知工具」，没有任何报错指向它。
 * 共用这一个函数，那种分叉就不可能发生。
 */
export function selectedBuiltinToolNames(cwd: string = process.cwd()): ReadonlySet<string> {
  const key = path.resolve(cwd);
  if (cachedOn?.key !== key) {
    cachedOn = { key, names: new Set(resolveToolSelection(loadPiSettings().defaultTools)) };
  }
  return cachedOn.names;
}

/**
 * 扩展提供的工具（`extension-host.ts` 装出来的）。
 *
 * ## 为什么要**单独**一份而不是直接并进 `registries`
 *
 * 官方工具在**构造时**把 cwd 烤进闭包（路径边界检查靠它），所以它们必须按 cwd 缓存。
 * 扩展工具相反 —— 它们已经自己拿到了 `ctx.cwd`（`extension-tools.ts` 里拼的），
 * 不依赖注册表的 cwd，**也不能**按 cwd 重建：重建等于把 jiti 已经装载好的模块
 * 重新适配一遍，白花开销。
 *
 * 所以分成两层：按 cwd 的官方工具（缓存）+ 一份全局的扩展工具。`getTools()` 把它们
 * 合起来，`getTool(name)` 从合并后的表里找 —— 环那边**看不出**这个区别。
 *
 * 装载顺序：内核在 `prompt.init` **之前**调 `registerExtraTools()`（见 kernel.ts）。
 * 反过来的话 `prompt.init` 已经把工具清单装进 state 了，扩展工具就只存在于注册表、
 * 模型看不见 —— 而症状是「工具调用永远回「未知工具」」。
 */
const extensionTools: AgentTool[] = [];

export function registerExtraTools(tools: readonly AgentTool[]): void {
  extensionTools.length = 0;
  for (const tool of tools) {
    // 官方工具名优先：同名时扩展工具让位，否则一个扩展能把 `bash` 顶掉。
    if (getOfficialToolNames().has(tool.name)) {
      continue;
    }
    extensionTools.push(tool);
  }
}

/** 扩展提供的工具（只读）。 */
export function getExtensionTools(): readonly AgentTool[] {
  return extensionTools;
}

export function getTools(cwd: string = process.cwd()): readonly AgentTool[] {
  const on = selectedBuiltinToolNames(cwd);
  // 开关只作用于**内置工具**。扩展工具不受 `defaultTools` 管 —— 那是用户为
  // 「装了哪些扩展」负责的事，让内置工具的开关注入去连带控制扩展会两头不讨好。
  const builtin = allBuiltins(cwd).filter((tool) => on.has(tool.name));
  return extensionTools.length === 0 ? builtin : [...builtin, ...extensionTools];
}

function getOfficialToolNames(): Set<string> {
  // **只取官方那一层** —— 不能用 `getTools()`，那个已经把扩展工具合进来了，
  // 那样就成了「扩展工具在不在表里取决于它自己有没有被装上」的循环。
  //
  // 而且要**全部**内置工具名，不只是默认开的那几个：这道门的作用是「不让扩展
  // 顶掉一个同名内置工具」，与它默认开不开无关 —— 否则 `defaultTools` 里关掉
  // `read` 之后，一个叫 `read` 的扩展就能把内置实现顶掉，而那正是我们要防的。
  return new Set(BUILTIN_TOOL_NAMES);
}

export function getTool(name: string, cwd: string = process.cwd()): AgentTool | undefined {
  // 先找扩展工具：它们是**后**装的，而名字与官方工具不冲突（`registerExtraTools` 拦了），
  // 所以顺序其实无所谓 —— 但这里写明「先扩展」是因为它是本轮新加的一层，顺序不该
  // 靠「名字碰巧不撞」维持。
  return extensionTools.find((tool) => tool.name === name) ??
    getTools(cwd).find((tool) => tool.name === name);
}

/**
 * 丢掉某个 cwd 的缓存（测试用：换目录后要能看到新目录的工具实例）。
 *
 * **不动扩展工具**：它们不属于任何 cwd（见上面那个注释）。
 */
export function resetTools(cwd: string = process.cwd()): readonly AgentTool[] {
  registries.set(path.resolve(cwd), build(cwd));
  // 顺带丢掉开关缓存 —— 测试改完 settings.json 后重取，期望看到新选择。
  // 只丢缓存，不重建别处的（工具实例按 cwd 存着，本来就该复用）。
  cachedOn = undefined;
  // 走 getTools 而不是把 build 的结果直接返回：**返回值必须与正常路径一致**。
  // 直接返回 build() 会让调用方（测试）看到一个「全部开启」的表，而 getTools()
  // 给的是按 defaultTools 过滤过的 —— 两处不一致时，测试断言的其实是另一套工具集。
  return getTools(cwd);
}

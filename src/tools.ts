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
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent';
import type { AgentTool as OfficialTool } from '@earendil-works/pi-agent-core';

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
// 按 cwd 缓存：官方工具在**构造时**就把 cwd 烤进闭包（路径边界检查靠它），
// 所以同一个 cwd 复用同一批实例；换个 cwd 必须重建，否则边界还是旧的。
// 用绝对路径做 key，免得 'x' 和 './x' 各建一份。
const registries = new Map<string, readonly AgentTool[]>();

function build(cwd: string): readonly AgentTool[] {
  return [
    adapt(createReadTool(cwd), '读文件'),
    adapt(createWriteTool(cwd), '写文件'),
    adapt(createEditTool(cwd), '编辑文件'),
    adapt(createBashTool(cwd), '执行命令'),
  ];
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
  const key = path.resolve(cwd);
  let tools = registries.get(key);
  if (!tools) {
    tools = build(cwd);
    registries.set(key, tools);
  }
  return extensionTools.length === 0 ? tools : [...tools, ...extensionTools];
}

function getOfficialToolNames(): Set<string> {
  // **只取官方那一层** —— 不能用 `getTools()`，那个已经把扩展工具合进来了，
  // 那样就成了「扩展工具在不在表里取决于它自己有没有被装上」的循环。
  return new Set(build(process.cwd()).map((tool) => tool.name));
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
  const key = path.resolve(cwd);
  const tools = build(cwd);
  registries.set(key, tools);
  return extensionTools.length === 0 ? tools : [...tools, ...extensionTools];
}

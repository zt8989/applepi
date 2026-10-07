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

export function getTools(cwd: string = process.cwd()): readonly AgentTool[] {
  const key = path.resolve(cwd);
  let tools = registries.get(key);
  if (!tools) {
    tools = build(cwd);
    registries.set(key, tools);
  }
  return tools;
}

export function getTool(name: string, cwd: string = process.cwd()): AgentTool | undefined {
  return getTools(cwd).find((tool) => tool.name === name);
}

/** 丢掉某个 cwd 的缓存（测试用：换目录后要能看到新目录的工具实例）。 */
export function resetTools(cwd: string = process.cwd()): readonly AgentTool[] {
  const key = path.resolve(cwd);
  const tools = build(cwd);
  registries.set(key, tools);
  return tools;
}

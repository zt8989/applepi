/**
 * pi 扩展工具 → 本项目的 `AgentTool`。
 *
 * 与 `tools.ts` 的 `adapt()` 同构（签名收窄 + `details` 归一），差别是一处：官方工具的
 * execute 第五个参数 `ctx` 不在公开契约里，而扩展工具的 `ctx` **就是命脉**
 * （`ask_user_question` 要 `ctx.hasUI` / `ctx.ui.custom()` / `ctx.cwd`）——
 * 所以五个参数原样传下去：我们**就是** host。
 *
 * `details` 必须能 JSON 序列化（pi-ai 收成 `JsonValue`，要进消息流、存盘、发给 provider）。
 * 扩展给的 `unknown` 只在是真 JSON 时原样放行，否则落到 `[无法序列化]` —— 而不是让整条
 * 消息在存盘那一刻炸掉（那会连带丢掉这一轮的工具结果）。
 */
import type { AgentTool, AgentToolResult } from './agent-tool';
import { activeToolNames, declaredToolset, setActiveToolNames } from './tools';
import type { PromptToolDefinition } from './actions';
import type { AgentStore } from './store';
import type { ExtensionRunner } from '@earendil-works/pi-coding-agent/dist/core/extensions/runner.js';
import type { AgentState } from './state';

/** 扩展工具的 execute 的第五个参数只需要这几个成员。 */
interface ToolCtx {
  hasUI: boolean;
  mode: string;
  cwd: string;
  ui: { custom: unknown; notify: (m: string, t?: string) => void };
  isProjectTrusted(): boolean;
}

/** pi 的 `ToolDefinition` 里本项目用到的那几样。 */
export interface ExtensionToolDefinitionLike {
  description: string;
  parameters: unknown;
  /** 有 `structuredContent` 的工具声明它（MCP）。codemode 靠它决定脚本看到的返回值形状。 */
  outputSchema?: unknown;
  /** 进 system prompt「工具怎么用」那一节的片段（没 snippet 就不列，官方语义）。 */
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((u: { content: unknown[]; details?: unknown }) => void) | undefined,
    ctx: unknown,
  ): Promise<{ content?: unknown[]; details?: unknown } | AgentToolResult>;
}

export interface AdaptOptions {
  runner: ExtensionRunner;
  store: AgentStore;
  cwd: string;
}

/**
 * 把官方 `ToolDefinition` 收成本项目的 `AgentTool`。
 *
 * 抛异常**不**在这里兜：扩展的 execute 抛了就该变成 `isError: true` 的工具结果
 * （`effects.ts` 的 `runToolCall` 有那个 catch），那与官方工具同一条路。
 */
export function adaptExtensionTool(
  name: string,
  definition: ExtensionToolDefinitionLike,
  host: AdaptOptions,
): AgentTool {
  return {
    name,
    // 官方 label 就是工具名；界面显示英文工具名，不做二次翻译。
    label: name,
    description: definition.description,
    parameters: definition.parameters as AgentTool['parameters'],
    // codemode 脚本靠它决定返回值形状（见 agent-tool.ts）；丢掉 → 脚本按对象取字段却拿到字符串。
    ...(definition.outputSchema !== undefined
      ? { outputSchema: definition.outputSchema as AgentTool['outputSchema'] }
      : {}),
    async execute(toolCallId, params, signal, onUpdate) {
      const ctx = toolContext(host, toolCallId, signal);
      const result = await definition.execute(
        toolCallId,
        params,
        signal,
        onUpdate === undefined
          ? undefined
          : // 官方 update 与本项目 `AgentToolUpdate` 同形（都是「当前完整结果」），cast 即可。
            (onUpdate as unknown as (u: { content: unknown[]; details?: unknown }) => void),
        ctx,
      );
      return normalizeResult(result);
    },
  };
}

/**
 * 给扩展拼 `ctx`。只有 `ask_user_question` 要的那几个成员是真的（`hasUI` / `mode` /
 * `cwd` / `isProjectTrusted()` / `ui`）。
 *
 * 走 `runner.createToolContext()` 而不是手搓：它会换上 runner 里绑好的 `ui`，
 * 并把 `tools` / `executeTool` 挂上；手搓的 ctx 在扩展调 `ctx.ui.custom` 时拿到 undefined。
 */
function toolContext(
  host: AdaptOptions,
  toolCallId: string,
  signal: AbortSignal | undefined,
): ToolCtx {
  // 传真的 toolCallId：codemode 靠它给嵌套调用发号（`<父 id>/<n>`）；写死的话编号会跨
  // 调用累加，MCP 的 `tool_call` handler 拿到的 `parentToolCallId` 也是错的。
  return host.runner.createToolContext(toolCallId, signal) as unknown as ToolCtx;
}

/**
 * 结果归一：`content` 兜底为空数组、`details` 兜底为 null、且保证 details 能 JSON 序列化。
 */
function normalizeResult(
  result: { content?: unknown[]; details?: unknown } | AgentToolResult,
): AgentToolResult {
  return {
    content: (result.content ?? []) as AgentToolResult['content'],
    details: jsonSafe(result.details ?? null) as AgentToolResult['details'],
  };
}

/**
 * 让一个值能真的 JSON 序列化；不能就换成占位符。
 *
 * `details` 会进 `state.messages` → 落盘 → 回放 → 下次发给 provider。带函数或循环引用的
 * `details` 在 `JSON.stringify` 那一刻抛 `TypeError`，而那正是写文件的时刻 —— 这一轮的
 * 工具结果与后面所有消息会一起丢掉。
 *
 * 判定就用 `JSON.stringify` 而不是类型扫描：那**就是**真实会挂掉的那个操作。
 */
function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return '[无法序列化]';
  }
}

/**
 * 扩展看到的「当前工具集」，两个来源按 `prompt.init` 装没装分开：
 *
 * - **装载前**（`state.prompt.tools` 为空）：读注册表的活动集。MCP 扩展在 `session_start`
 *   里就问这个，读 state 会得到空数组，于是它以为自己一个工具都没有。
 * - **装载后**：读 `state.prompt.tools` —— 那就是当前声明，与「模型能调什么」一致，
 *   会话中途变了也是新的那份。
 */
export function activeToolsFromState(state: AgentState, cwd?: string): string[] {
  if (state.prompt.tools.length === 0) return [...activeToolNames(cwd)];
  return state.prompt.tools.map((t) => t.name);
}

/**
 * 扩展要改工具集（`pi.setActiveTools()`）—— **会话中途也真的生效**。
 *
 * 两件事分开做，它们的「真相」在不同地方：
 * 1. `setActiveToolNames(names)` 更新**激活集**（模块级，`pi.getActiveTools()` 读它）；
 * 2. `dispatch(tools.changed)` 更新 `state.prompt.tools`（**当前声明**）。
 *
 * 中途换工具不会让已发出的 `messages` 对不上：`agent.run` 在请求前把「能执行的」与
 * 「已声明的」diff 成一条 `toolsAdded` / `toolsRemoved` 消息，已有消息一个字节不动。
 *
 * 拿 `declaredToolset()` 算出来的那份去 dispatch：它会去掉 `prepareLoadout` 声明的
 * `hiddenDeclarations`（codemode 靠这个藏起直调工具），自己拼就会把它们漏给模型。
 */
export function applyActiveTools(store: AgentStore, names: readonly string[], cwd: string): void {
  setActiveToolNames(names);
  const declared: readonly PromptToolDefinition[] = declaredToolset(cwd).tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  store.dispatch({ type: 'tools.changed', tools: [...declared] });
}

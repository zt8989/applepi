/**
 * pi 扩展工具 → 本项目的 `AgentTool`。
 *
 * 与 `tools.ts` 里那层 `adapt()` 同构（签名收窄 + `details` 归一），差别只有一处：
 * 官方工具的 execute **第五个参数 `ctx` 不在公开契约里**，而扩展工具的 execute
 * **第五个参数就是它的命脉** —— `ask_user_question` 要 `ctx.hasUI` 决定走
 * TUI 分支还是 `no_ui` 分支，要 `ctx.ui.custom()` 画那个对话框，还要 `ctx.cwd`
 * 找外部编辑器。所以这里**原样把五个参数都传下去**：我们**就是** host，不装看不见。
 *
 * ## `details` 必须能 JSON 序列化
 *
 * pi-ai 1.x 把 `details` 收成 `JsonValue`（要进消息流、存盘、发给 provider）。
 * 扩展给的 `details` 是 `unknown`，我们只在它是真 JSON 时原样放行；带函数、
 * Map、Set 或循环引用的对象落到 `[无法序列化]` —— 而不是让整条消息在存盘那一刻炸掉
 * （那会连带丢掉这一轮的工具结果，症状是「会话文件写到一半断了」）。
 */
import type { AgentTool, AgentToolResult } from './agent-tool';
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
    // 官方 label 就是工具名。界面现在显示英文工具名（见 `tui/app.ts` 的说明），
    // 所以这里给同一个 —— 不做二次翻译。
    label: name,
    description: definition.description,
    parameters: definition.parameters as AgentTool['parameters'],
    async execute(toolCallId, params, signal, onUpdate) {
      const ctx = toolContext(host, signal);
      const result = await definition.execute(
        toolCallId,
        params,
        signal,
        onUpdate === undefined
          ? undefined
          : // 官方 update 的形状与本项目 `AgentToolUpdate` 同形（都是「当前完整结果」），
            // 只是来自不同包 —— cast 即可，运行时无差别。
            (onUpdate as unknown as (u: { content: unknown[]; details?: unknown }) => void),
        ctx,
      );
      return normalizeResult(result);
    },
  };
}

/**
 * 给扩展拼 `ctx`。
 *
 * **只有 `ask_user_question` 要的那几个成员是真的。** 它用到：
 * `ctx.hasUI`（有没有界面）、`ctx.mode`（是不是 rpc）、`ctx.cwd`（找外部编辑器）、
 * `ctx.isProjectTrusted()`（读项目设置）、`ctx.ui.custom()` / `ctx.ui.notify()` /
 * `ctx.ui.onTerminalInput()`。
 *
 * 走 `runner.createToolContext()` 而不是手搓：那是官方造 ctx 的唯一入口，它会把
 * `ui` 换成 runner 里绑好的那个（`setUIContext` 装的那个），并把 `tools` /
 * `executeTool` 挂上。手搓的 ctx 会在扩展调 `ctx.ui.custom` 时拿到 undefined。
 */
function toolContext(host: AdaptOptions, signal: AbortSignal | undefined): ToolCtx {
  return host.runner.createToolContext('(extension)', signal) as unknown as ToolCtx;
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
 * ## 为什么要这一步
 *
 * `details` 会进 `state.messages` → 落盘（会话文件）→ 回放时再读 → 下次发给 provider。
 * 一个带函数或循环引用的 `details` 在 `JSON.stringify` 那一刻抛 `TypeError`，而那个
 * 时刻正在写文件 —— 于是这一轮的工具结果与后面所有消息**一起丢掉**。代价与「扩展
 * 顺手放了个 `Map` 进来」完全不成比例。
 *
 * 判定用 `JSON.stringify` 而不是类型扫描：那**就是**真实会挂掉的那个操作，
 * 猜类型只能近似（Proxy、getter、toJSON…）。抛了就退占位符，不抛就原样。
 */
function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return '[无法序列化]';
  }
}

// ─── 工具集（本项目的 state 侧） ───

/**
 * 扩展看到的「当前工具集」= `state.prompt.tools` 的名字。
 *
 * ## 为什么不额外维护一份
 *
 * `state.prompt.tools` **就是**发给模型的那份定义（`effects.ts` 的 `toolSchemas()` 原样
 * 读它），所以它与「模型能调什么」永远一致。扩展问 `getActiveTools()` 时想知道的正是
 * 这个 —— 读别处就会出现「扩展以为工具在、模型却看不到」。
 */
export function activeToolsFromState(state: AgentState): string[] {
  return state.prompt.tools.map((t) => t.name);
}

/**
 * 扩展要改工具集。
 *
 * ## 为什么这条在本项目里是 no-op（且要记住这一点）
 *
 * 本项目的工具集与 system prompt 一样是**装载时**定下的（`prompt.init`）。一轮对话
 * 中间换工具会让 `state.messages` 与 prompt 对不上（模型可能已经在调一个刚被摘掉的
 * 工具），而 prompt-cache 的前缀整个作废。
 *
 * 所以这里**只记诊断、不 dispatch**：不是「忘了做」，是刻意的。扩展在
 * `before_agent_start` 里按 `ctx.hasUI` 摘工具（`ask_user_question` 自带的协调器）
 * 在本项目恒为 no-op —— 本项目只有交互式一种模式，`hasUI` 恒真。
 *
 * 真要改工具集：`/new` 换会话（与 skill 清单同一个口径），或改 `settings.json` 后重启。
 */
export function applyActiveTools(_store: AgentStore, _names: readonly string[]): void {
  // 刻意空实现。见上面的「为什么这条在本项目里是 no-op」。
}

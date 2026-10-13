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
import { activeToolNames, setActiveToolNames } from './tools';
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
    // 官方 label 就是工具名。界面现在显示英文工具名（见 `tui/app.ts` 的说明），
    // 所以这里给同一个 —— 不做二次翻译。
    label: name,
    description: definition.description,
    parameters: definition.parameters as AgentTool['parameters'],
    // MCP 工具声明了 `outputSchema`：codemode 脚本靠它决定返回值形状（见 agent-tool.ts）。
    // 丢掉它 → 脚本按对象取字段却拿到一个字符串。
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
function toolContext(
  host: AdaptOptions,
  toolCallId: string,
  signal: AbortSignal | undefined,
): ToolCtx {
  // 把**真的** toolCallId 传下去：codemode 靠它给嵌套调用发号
  // （`<父 id>/<n>`，见 `extension-host.ts` 的 `ctx.executeTool`）。早先这里写死
  // `'(extension)'`，于是脚本里每次嵌套调用的 id 都是 `(extension)/1`、`(extension)/2`…
  // —— 编号跨调用累加，而 MCP 的 `tool_call` handler 拿到的 `parentToolCallId` 也是错的。
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
 * 扩展看到的「当前工具集」。
 *
 * 两个来源，按是否已经装载完分开：
 *
 * - **装载窗口内**（`prompt.init` 之前）：读注册表的活动集（`activeToolNames`）。
 *   MCP 扩展在 `session_start` 里就问这个 —— 那一刻 state 里还没有工具表，
 *   读 state 会得到空数组，于是它以为自己一个工具都没有，把 codemode 也当成
 *   “不需要激活”。
 * - **装载完**：读 `state.prompt.tools` —— 那**就是**发给模型的声明
 *   （`effects.ts` 的 `toolSchemas()` 原样读它），与「模型能调什么」永远一致。
 *
 * 判据是 `state.prompt.tools.length === 0`（装载前它就是空的）。
 */
export function activeToolsFromState(state: AgentState, cwd?: string): string[] {
  if (state.prompt.tools.length === 0) return [...activeToolNames(cwd)];
  return state.prompt.tools.map((t) => t.name);
}

/**
 * 扩展要改工具集（`pi.setActiveTools()`）。
 *
 * ## 只在**装载窗口**里真的生效
 *
 * 本项目的工具集与 system prompt 一样是**装载时**定下的（`prompt.init`）。窗口内
 * （内核还没算好声明）改它就真的改；窗口关掉之后再改就**不生效**，返回 false，
 * 由调用方记一条诊断。
 *
 * 为什么窗口外不让改：一轮对话中间换工具会让 `state.messages` 与 prompt 对不上
 * （模型可能已经在调一个刚被摘掉的工具），而 prompt-cache 的前缀整个作废。
 *
 * 这条对 `ask_user_question` 自带的协调器（在 `before_agent_start` 里按 `ctx.hasUI`
 * 摘工具）**也**成立：本项目只有交互式一种模式、`hasUI` 恒真，而那个事件在装载之后
 * 才发，所以那里恒为 no-op。
 *
 * 真要改工具集：`/new` 换会话（与 skill 清单同一个口径），或改 `settings.json` 后重启。
 *
 * @returns 真的生效了没有。false = 窗口已关（调用方该说出来，而不是假装改了）。
 */
export function applyActiveTools(_store: AgentStore, names: readonly string[]): boolean {
  return setActiveToolNames(names);
}

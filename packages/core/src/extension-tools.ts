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
import { activeToolNames, declaredToolset, setActiveToolNames } from './tools';
import type { PromptToolDefinition } from './actions';
import type { AgentStore } from './store';
import type { QuestionnaireHost } from './questionnaire';
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
  /**
   * 问卷宿主（可缺省）。**记下正在跑的工具入参**是它的需求：
   * `ask_user_question` 的题目与 `preview` 正文只在工具入参里（`ctx.ui.select` 那几次
   * 调用只给当前这一题），而问卷视图**一次要画全**（否则没有 tab）。
   *
   * 记的是"正在跑"这个状态而不是"谁调了 select"：认领时拿入参的结构 + 标题前缀
   * 当证据（见 `questionnaire.ts` 的 `QuestionnaireHost`）。
   */
  questionnaire?: QuestionnaireHost | undefined;
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
      // 记一下"这个工具正在跑、入参是什么"—— 问卷的题目与 preview 正文就从这里来。
      host.questionnaire?.noteToolCall(toolCallId, name, params);
      let result: { content?: unknown[]; details?: unknown };
      try {
        result = await definition.execute(
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
      } finally {
        // 收尾要**成功失败都记**：抛了还留着那条记录的话，下一次 `select` 会认领到一份
        // 已经死掉的问卷。
        host.questionnaire?.settleToolCall(toolCallId);
      }
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
 * 两个来源，按 `prompt.init` 装没装分开：
 *
 * - **装载前**（`prompt.init` 之前）：读注册表的活动集（`activeToolNames`）。
 *   MCP 扩展在 `session_start` 里就问这个 —— 那一刻 state 里还没有工具表，
 *   读 state 会得到空数组，于是它以为自己一个工具都没有，把 codemode 也当成
 *   “不需要激活”。
 * - **装载后**：读 `state.prompt.tools` —— 那**就是**当前声明（`declaredToolset()`
 *   算出来、`tools.changed` 更新、`effects.ts` 的 head 读它），与「模型能调什么」
 *   一致，且会话中途变了也是新的那份。
 *
 * 判据是 `state.prompt.tools.length === 0`（装载前它就是空的）。
 */
export function activeToolsFromState(state: AgentState, cwd?: string): string[] {
  if (state.prompt.tools.length === 0) return [...activeToolNames(cwd)];
  return state.prompt.tools.map((t) => t.name);
}

/**
 * 扩展要改工具集（`pi.setActiveTools()`）—— **会话中途也真的生效**。
 *
 * 两件事分开做，因为它们的「真相」在不同地方：
 *
 * 1. `setActiveToolNames(names)` 更新**激活集**（模块级）—— `pi.getActiveTools()` /
 *    运行时的可调表读它（见 `tools.ts` 的 `activeToolNames()`）。
 * 2. `dispatch(tools.changed)` 更新 `state.prompt.tools`（**当前声明**）。
 *
 * ## 为什么不再需要「装载窗口」
 *
 * 早先这里有个窗口：窗口中（`prompt.init` 之前）允许改，窗口外一律拒绝并记诊断。
 * 拒绝的理由是「中途换工具会让已发出的 `messages` 与 prompt 对不上」。那个理由现在
 * 由**声明**解决了：`reducer.ts` 的 `agent.run` 在请求前把「能执行的」与「已经声明给
 * 模型的」diff 成一条 `toolsAdded` / `toolsRemoved` 消息（pi 的 `declareToolChanges`
 * 同一步），于是**已有的消息一个字节不动**，模型也会被明确告知工具变了。
 *
 * 收益是具体的：`pi-web-access` 的 `web_enable`、`pi-subagents` 的 `subagents_enable`
 * 都是「loader 工具」—— 它们整条功能就是「运行中把工具加进来」。窗口在时它们在本项目里
 * 只能回一句「still inactive」。
 *
 * ## `hidden` 怎么处理
 *
 * `declaredToolset()` 会把 `prepareLoadout` 声明的 `hiddenDeclarations` 从给模型的数组里
 * 去掉（codemode 靠这个藏起直调工具）。所以这里拿**它算出来的那份**去 dispatch，
 * 而不是自己拼。
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

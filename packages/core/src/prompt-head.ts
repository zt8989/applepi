/**
 * 请求的**头部 system 消息**（head）—— prompt 与「初始工具声明」的唯一容器。
 *
 * ## 为什么 head 得是 messages[0]，而不是 `Context.systemPrompt`
 *
 * pi-ai 的 `normalizeContext(context)` 会拿 `Context.systemPrompt` 与 `Context.tools`
 * **每轮**造一条 head（`createInitialSystemMessage`）挂到消息流最前面。那是给
 * 「prompt 永远不变」的调用方的接口 —— 一旦中途要改 prompt，它就正好是最坏的形状：
 * 改一个字，整条 head 重造，**前面所有 token 的缓存前缀全废**。
 *
 * 所以这里跟 pi-agent-core 一样：head 是**一条普通的 system 消息**，放在 messages 最前。
 * 它一旦发出去就是历史的一部分，不能被改写 —— 中途的变更只能作为**新的** system 消息
 * 追加在后面（pi 的 `sections` patch / `toolsAdded`）。这样：
 *
 * - 支持 mid-conv system 的模型：head 原样不动 → **前缀稳定**；
 * - 不支持的模型：pi-ai 的 `resolveTranscript` → `collapseSystemMessages()` 把
 *   head 与后面的 patch **回放合并**成一条 —— 语义正确，代价是前缀必断
 *   （这是模型能力的硬约束，不是我们写坏了）。
 *
 * ## 顶层 tools 字段为什么不传
 *
 * `resolveTranscriptTools(messages, …)` 在模型支持原地加工具时，顶层只发
 * **head 里那批**（`toolsAdded`），后续新增工具在它出现的那条消息上原地声明。
 * 于是顶层字节恒定。反之（不支持）它发 `getCurrentTools(messages)` = 当前完整集，
 * 工具一改字节就变 —— 同样是能力约束。
 *
 * **所以 head 里必须带 `toolsAdded`**：不带的话顶层工具集就是空的（模型一个工具都看不到）。
 *
 * ## `content` 与 `sections` 二选一
 *
 * - 有分段（`buildPromptParts` 的产物）：`content: ''` + `sections` 全量。这是 pi 的形状，
 *   也是「以后能按段 patch」的前提（`buildSystemPromptSections` 把 preamble 之外每段
 *   包成 `<name>…</name>`，所以模型能把后来的更新对上号）。
 * - 没有分段（旧轨迹回放）：`content: systemPrompt` 整段 —— 老会话只有一整段可用。
 *
 * `tools` 一律过一遍 `toToolDeclaration`：它的 JSON 往返丢掉 typebox 的 symbol 键、
 * 统一键序，于是「同一份工具集」每轮序列化出的字节完全相同（前缀稳定的必要条件）。
 */
import type { PromptToolDefinition } from './actions';
import {
  getCurrentSystemMessage,
  getCurrentTools,
  getToolStateChanges,
  toToolDeclaration,
  type Context,
  type Message,
  type SystemMessage,
  type Tool,
  type ToolReference,
} from '@earendil-works/pi-ai';

/**
 * `PromptToolDefinition[]` → pi-ai 的 `Tool[]`：**进请求的就是这三样**。
 *
 * 放这里（而不是 `effects.ts` 里）是因为它有两个读者：请求的 head（`effects.ts`）
 * 与工具声明增量（`reducer.ts` 的 `agent.run`）。两处各写一遍 map 迟早漂移 ——
 * 而漂移的症状是「声明变了但请求没变」（或反过来），只有账单看得见。
 */
export function declaredToolSchemas(tools: readonly PromptToolDefinition[]): Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Tool['parameters'],
  }));
}

export interface PromptHeadInput {
  /** 渲染好的整段 prompt（`state.prompt.systemPrompt`）。 */
  systemPrompt: string;
  /** 分段（`state.prompt.sections`）；没有就是「只有一整段」的老会话。 */
  sections?: Record<string, string> | undefined;
  /** 初始工具声明（`effects.ts` 的 `toolSchemas`）。 */
  tools: readonly Tool[];
}

/**
 * 造**请求上下文**：head + 对话消息。这就是发给 provider 的全部内容。
 *
 * 不用 `Context.systemPrompt` / `Context.tools`：那两个字段会被 pi-ai 的
 * `normalizeContext` **每轮**重建成一条 head（`createInitialSystemMessage`）——
 * 中途改一个字，整条 head 重造，前缀缓存全废。head 进 messages 才是不可变历史，
 * 中途的变更只能作为新的 system 消息追加（见 `buildPromptHead` 的注释）。
 *
 * 单独抽成函数（而不写在 `effects.ts` 里）：形状是改动的**要害**，得能被测试直接钉住。
 */
export function buildRequestContext(input: PromptHeadInput & { messages: readonly Message[] }): Context {
  return {
    messages: [
      buildPromptHead({
        systemPrompt: input.systemPrompt,
        ...(input.sections !== undefined ? { sections: input.sections } : {}),
        tools: input.tools,
      }),
      ...input.messages,
    ],
  };
}

/** 造 head。同一份输入永远产出同一份字节（`sections` 的键序保持插入序）。 */
export function buildPromptHead(input: PromptHeadInput): SystemMessage {
  const tools = input.tools.map(toToolDeclaration);
  const head: SystemMessage = {
    role: 'system',
    content: input.sections === undefined ? input.systemPrompt : '',
    timestamp: 0,
  };
  if (input.sections !== undefined) head.sections = { ...input.sections };
  if (tools.length > 0) head.toolsAdded = tools;
  return head;
}

/**
 * **当前生效**的 sections = 装载时那份 + 已经追加过的 patch。
 *
 * 为什么基线不能直接用 `getCurrentSystemMessage([head, ...messages])`：
 * 老会话的 head 走 `content`（没有 sections），回放出来的 sections 只剩「后续 patch」
 * —— 于是每次 handler 报上来的完整 sections（MCP 的 `mcp_servers` 每轮都会写）
 * 都会被当成「变了」，**每轮多追加一条一模一样的消息**。
 *
 * 为什么基线也不能只看 `state.prompt.sections`：那会把已追加过的 patch 当成新变更，
 * 同一个症状。两个来源合起来才是「当前生效」。
 */
export function effectiveSections(input: {
  systemPrompt: string;
  sections?: Record<string, string> | undefined;
  messages: readonly Message[];
}): Record<string, string> {
  const patched = getCurrentSystemMessage(input.messages)?.sections ?? {};
  const merged: Record<string, string> = { ...(input.sections ?? {}) };
  for (const [name, text] of Object.entries(patched)) {
    if (text === null) delete merged[name];
    else merged[name] = text;
  }
  return merged;
}

/**
 * 工具**声明增量**：当前工具集与 transcript 里已声明那份的差。
 *
 * 与 pi-agent-core 的 `declareToolChanges(context, pendingMessages)` 同一步：
 * `context.tools` 是**能执行**的，transcript 里的 system 消息声明的是**模型能调**的，
 * 两者不一致时，差额就是一条新的 system 消息（`toolsAdded` / `toolsRemoved`）。
 *
 * 改过的定义会表达成「先删后加」（`getToolStateChanges` 的口径）—— 所以别去比
 * description 该不该算变化，官方已经定了。
 *
 * 返回 undefined = 没变（绝大多数轮），调用方一条消息都不该加。
 */
export function toolDeclarationDelta(input: {
  head: SystemMessage;
  /** 当前可执行的工具（`state.prompt.tools`）。 */
  currentTools: readonly Tool[];
  messages: readonly Message[];
}): { toolsAdded: Tool[]; toolsRemoved: ToolReference[] } | undefined {
  const declared = getCurrentTools([input.head, ...input.messages]);
  const changes = getToolStateChanges(declared, input.currentTools.map(toToolDeclaration));
  if (changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0) return undefined;
  return changes;
}

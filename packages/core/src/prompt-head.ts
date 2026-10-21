/**
 * 请求的**头部 system 消息**（head）—— prompt 与「初始工具声明」的唯一容器。
 *
 * head 是 messages[0] 里一条**普通 system 消息**，不用 `Context.systemPrompt` /
 * `Context.tools`：pi-ai 的 `normalizeContext()` 会拿那两个字段**每轮**重造一条 head，
 * 改一个字整条重造，前面所有 token 的缓存前缀全废。
 *
 * head 一旦发出去就是历史的一部分，不能被改写：中途变更只能作为**新的** system 消息
 * 追加在后面（pi 的 `sections` patch / `toolsAdded`）。支持 mid-conv system 的模型前缀
 * 稳定；不支持的由 pi-ai 的 `resolveTranscript` 回放合并成一条，代价是前缀必断
 * （模型能力的硬约束，不是我们写坏了）。
 *
 * **顶层 tools 不传，但 head 里必须带 `toolsAdded`**：不带的话顶层工具集是空的，
 * 模型一个工具都看不到。
 *
 * `content` 与 `sections` 二选一：有分段时 `content: ''` + `sections` 全量（pi 的形状，
 * 也是以后按段 patch 的前提），旧轨迹回放只有一整段时走 `content`。
 *
 * `tools` 一律过一遍 `toToolDeclaration`：它的 JSON 往返丢掉 typebox 的 symbol 键、
 * 统一键序，于是同一份工具集每轮序列化出的字节完全相同（前缀稳定的必要条件）。
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
 * 两个读者（请求的 head 与工具声明增量）共用这一份：各写一遍 map 迟早漂移，
 * 而漂移的症状只有账单看得见。
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
 * 造**请求上下文**：head + 对话消息，这就是发给 provider 的全部内容（见文件头）。
 *
 * 单独抽成函数而不写在 `effects.ts` 里：形状是要害，得能被测试直接钉住。
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
 * 两个来源必须合起来：只看 `getCurrentSystemMessage(...)` 的话，旧轨迹的 head 走
 * `content`（没有 sections），回放出来的 sections 只剩后续 patch；只看
 * `state.prompt.sections` 的话，已追加过的 patch 又被当成新变更 —— 两种都会让
 * handler 报上来的完整 sections（MCP 的 `mcp_servers` 每轮都写）被误判成「变了」，
 * **每轮多追加一条一模一样的消息**。
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
 * `context.tools` 是**能执行**的，transcript 里的 system 消息声明的是**模型能调**的，
 * 两者不一致时差额就是一条新的 system 消息（`toolsAdded` / `toolsRemoved`）。
 * 改过的定义由 `getToolStateChanges` 表达成「先删后加」，别去比 description。
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

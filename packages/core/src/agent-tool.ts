import type { ImageContent, JsonValue, TextContent, TSchema } from '@earendil-works/pi-ai';

/**
 * 工具执行结果（pi-ai Tool 约定的 execute 返回值形状）。
 */
export interface AgentToolResult {
  content: (TextContent | ImageContent)[];
  /** 必须真的可 JSON 序列化：要进消息流、存盘、发给 provider。 */
  details: JsonValue;
}

/**
 * 工具定义：name/description/parameters 与 pi-ai 的 `Tool` 同形，额外多 `label`
 * （中文展示名）与 `execute`（执行由本项目的 Cmd 驱动，不交给 pi 运行时）。
 */
export interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  /**
   * `structuredContent` 的 JSON Schema（只有 MCP 那类工具声明它）。
   *
   * codemode 脚本靠它决定返回值形状：有它拿到 `structuredContent`，没有只拿到文本 ——
   * 于是脚本按对象取字段会静默得到 `undefined`。
   */
  outputSchema?: TSchema | undefined;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    /** 流式增量回调（官方 bash 工具用它把长命令输出边跑边送）；不给就是跑完才返回。 */
    onUpdate?: AgentToolUpdate,
  ): Promise<AgentToolResult>;
}

/**
 * 工具执行中的部分结果。
 *
 * 每次调用给的都是**完整的当前结果**，不是增量 diff：bash 侧给「到目前为止的全部输出」，
 * 界面整体替换即可。不复用 pi-agent-core 的同名类型，是为了让 `effects.ts` 不依赖它。
 */
export type AgentToolUpdate = (partial: {
  content: (TextContent | ImageContent)[];
  details?: unknown;
}) => void;

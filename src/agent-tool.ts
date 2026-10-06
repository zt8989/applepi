import type { ImageContent, JsonValue, TextContent, TSchema } from '@earendil-works/pi-ai';

/**
 * 工具执行结果（pi-ai Tool 约定的 execute 返回值形状）。
 */
export interface AgentToolResult {
  content: (TextContent | ImageContent)[];
  /** pi-ai 1.x 要求 details 能真的 JSON 序列化（要进消息流、存盘、发给 provider）。 */
  details: JsonValue;
}

/**
 * 工具定义。name/description/parameters 与 pi-ai 的 `Tool` 同形，额外多两样：
 * `label`（CLI 的中文展示名）和 `execute`（因为工具执行由我们自己的 Cmd 驱动）。
 *
 * `label` 是 TUI 要读的：工具结果渲染时拿 tools 列表按名字找，找得到就用中文标签。
 */
export interface AgentTool {
  name: string;
  /** 展示名（CLI 里显示中文标签）。 */
  label: string;
  description: string;
  parameters: TSchema;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentToolResult>;
}

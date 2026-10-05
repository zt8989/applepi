import type { TSchema, TextContent, ImageContent } from '@earendil-works/pi-ai';

/**
 * 工具执行结果（pi-ai Tool 约定的 execute 返回值形状）。
 */
export interface AgentToolResult {
  content: (TextContent | ImageContent)[];
  details: unknown;
}

/**
 * 工具定义。name/description/parameters 与 pi-ai 的 `Tool` 同形，额外多两样：
 * `label`（CLI 的中文展示名）和 `execute`（因为工具执行由我们自己的 Cmd 驱动）。
 *
 * `label` 是 UI 要读的：pi-web-ui 的 `<tool-message>` 拿 tools 列表按名字找，
 * 找得到就用它自己的卡片，找不到就退回默认的 JSON 渲染。
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

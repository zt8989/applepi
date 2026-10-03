import type { TSchema, TextContent, ImageContent } from '@earendil-works/pi-ai';

/**
 * 工具执行结果（pi-ai Tool 约定的 execute 返回值形状）。
 */
export interface AgentToolResult {
  content: (TextContent | ImageContent)[];
  details: unknown;
}

/**
 * Agent 工具定义。name/description/parameters 与 pi-ai 的 Tool 同形，
 * 额外带 execute —— 因为 Agent Loop 是我们自己的（Redux Loop），
 * 工具执行也由我们自己的 Cmd 驱动，而不是交给 pi-agent-core。
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

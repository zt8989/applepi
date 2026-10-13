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
  /**
   * `structuredContent` 的 JSON Schema（只有 MCP 那类工具声明它）。
   *
   * **codemode 脚本靠它决定「这次调用的返回值是什么形状」**：有它 → 脚本拿到
   * `structuredContent`（MCP 工具拿到完整 `CallToolResult`）；没有 → 拿到文本那一坨。
   * 丢掉它的后果很具体：脚本里 `await tools.mcp__rea__read({...})` 返回一个字符串，
   * 而文档写的是对象 —— 脚本按对象取字段就静默拿到 `undefined`。
   */
  outputSchema?: TSchema | undefined;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    /** 流式增量（官方工具用它把长命令的输出边跑边送）。不给就是「跑完才给」。 */
    onUpdate?: AgentToolUpdate,
  ): Promise<AgentToolResult>;
}

/**
 * 工具执行中的**部分结果**（官方叫 `AgentToolUpdateCallback` 的参数）。
 *
 * ## 为什么要自己定义一个
 *
 * 官方那个类型来自 pi-agent-core，而我们的 `AgentTool` 本来就是一层适配（见 tools.ts）——
 * 让 `effects.ts` 依赖 pi-agent-core 的类型，等于让环的逻辑知道 pi-agent-core 的存在。
 * 自己声明一份形状相同的，官方实现那边 `cast` 一下就行（那边本来就全靠 cast）。
 *
 * **语义**：每次调用都是**完整的当前结果**（不是增量 diff）——
 * bash 侧给的是「到目前为止的全部输出」，所以界面直接整个替换即可。
 */
export type AgentToolUpdate = (partial: {
  /** 到目前为止的输出（文本块数组）。 */
  content: (TextContent | ImageContent)[];
  details?: unknown;
}) => void;

/**
 * 非会话数据的 HTTP 接口客户端（`/api/*`）。
 *
 * 服务端的实现在 `@ela/tui` 的 `web/api.ts`；形状定义在 `@ela/core/web-protocol`。
 * 浏览器只是拿它 —— 模型目录、命令表、作用域、settings 都在服务端，这里不抄一份。
 *
 * 与流式状态的分工：**这些接口只回答「现在是什么」**，流式状态（消息、thinking、
 * 工具）仍然走 WebSocket（那一份必须推送）。
 *
 * 一个例外：**完整历史**（`/api/history`）不是 JSON，而是服务端渲染的一页 HTML ——
 * 它不是这个模块取的，由顶栏那个按钮直接 `window.open` 打开（见 `context-panels.ts`）。
 */

import type {
  WebActionResult,
  WebAgentInfo,
  WebCommandInfo,
  WebMcpInfo,
  WebModelsInfo,
  WebPluginsInfo,
  WebSessionDeleteInfo,
  WebSessionsInfo,
  WebSettingsInfo,
  WebSkillInfo,
  WebSystemPromptInfo,
  WebThinkingInfo,
  WebToolDefinitionInfo,
} from '@ela/core/web-protocol';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return (await response.json()) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const elaApi = {
  commands: (): Promise<WebCommandInfo[]> => request('/api/commands'),
  models: (): Promise<WebModelsInfo> => request('/api/models'),
  /** 侧边栏：每个 cwd 的历史会话（恢复走 WebSocket，见 `sidebar.ts`）。 */
  sessions: (): Promise<WebSessionsInfo> => request('/api/sessions'),
  /** 侧边栏「已归档」那一栏：归档的会话明细（带 `archivedAt`）。 */
  archivedSessions: (): Promise<WebSessionsInfo> => request('/api/sessions/archived'),
  /** 归档（`archived = true`）/ 恢复一批会话。 */
  setArchived: (ids: readonly string[], archived: boolean): Promise<WebActionResult> =>
    post('/api/sessions/archive', { ids, archived }),
  /** 真删会话文件（+ 轨迹文件）—— 删了就没了，调用前必须问过用户。 */
  deleteSessions: (ids: readonly string[]): Promise<WebSessionDeleteInfo> =>
    post('/api/sessions/delete', { ids }),
  skills: (): Promise<WebSkillInfo[]> => request('/api/skills'),
  /** 设置 › 子代理：磁盘上的 agent 定义（只读）。 */
  agents: (): Promise<WebAgentInfo[]> => request('/api/agents'),
  /** 设置 › 插件：settings.json 的 packages + 已装载扩展（只读）。 */
  plugins: (): Promise<WebPluginsInfo> => request('/api/plugins'),
  /** 设置 › MCP：mcp.json 里的服务器（只读，不连接）。 */
  mcp: (): Promise<WebMcpInfo> => request('/api/mcp'),
  thinking: (): Promise<WebThinkingInfo> => request('/api/thinking'),
  settings: (): Promise<WebSettingsInfo> => request('/api/settings'),
  /** 顶栏「系统」：模型实际收到的系统提示词。 */
  systemPrompt: (): Promise<WebSystemPromptInfo> => request('/api/system-prompt'),
  /** 顶栏「工具」：模型看到的工具定义。 */
  tools: (): Promise<WebToolDefinitionInfo[]> => request('/api/tools'),
  setModel: (arg: string): Promise<WebActionResult> => post('/api/model', { arg }),
  setThinking: (level: string): Promise<WebActionResult> => post('/api/thinking', { level }),
  setSettings: (patch: {
    autoCompact?: boolean;
    hideThinking?: boolean;
    defaultThinkingLevel?: string;
  }): Promise<WebActionResult> => post('/api/settings', patch),
  setScopedModels: (ids: readonly string[] | null): Promise<WebActionResult> =>
    post('/api/scoped-models', { ids }),
  /** 扩展注册的命令（服务端跑）。内置命令各有自己的界面，不走这里。 */
  runCommand: (name: string, arg: string): Promise<WebActionResult> => post('/api/command', { name, arg }),
  /** 重载：重装扩展 + 重读 skill / prompt / 上下文文件（服务端跑）。 */
  reload: (): Promise<WebActionResult> => post('/api/reload', {}),
};

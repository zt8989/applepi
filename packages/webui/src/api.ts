/**
 * 非会话数据的 HTTP 接口客户端（`/api/*`）。
 *
 * 服务端的实现在 `@ela/tui` 的 `web/api.ts`；形状定义在 `@ela/core/web-protocol`。
 * 浏览器只是拿它 —— 模型目录、命令表、作用域、settings 都在服务端，这里不抄一份。
 *
 * 与流式状态的分工：**这些接口只回答「现在是什么」**，流式状态（消息、thinking、
 * 工具）仍然走 WebSocket（那一份必须推送）。
 */

import type {
  WebActionResult,
  WebCommandInfo,
  WebModelsInfo,
  WebSettingsInfo,
  WebSkillInfo,
  WebThinkingInfo,
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
  skills: (): Promise<WebSkillInfo[]> => request('/api/skills'),
  thinking: (): Promise<WebThinkingInfo> => request('/api/thinking'),
  settings: (): Promise<WebSettingsInfo> => request('/api/settings'),
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
};

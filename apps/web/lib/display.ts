/**
 * Pure display logic for the web UI (deepen #04). Everything here is a
 * pure function or a label constant — no React, no hooks, no 'use client' —
 * extracted out of the client components so it can be unit-tested with plain
 * node and so components render only. `contextLimit` lives here, next to the
 * model config it estimates against.
 */
import type { ComponentType } from 'react';
import { toText } from '@applepi/core/message';

export { toText };

/** Permission-level labels + descriptions (chat composer toolbar). */
export interface LevelMeta {
  label: string;
  desc: string;
}

export const LEVEL_META: Record<string, LevelMeta> = {
  readonly: { label: 'Read Only', desc: '可读任意位置，禁止所有写入' },
  workspace: { label: 'Workspace Write', desc: '可写限定在工作区内（默认）' },
  fullaccess: { label: 'Full access', desc: '读写任意位置（仍受危险命令黑名单约束）' },
};

/** Level icons are React components — kept with the components that render them. */
export type LevelIcon = ComponentType<{ className?: string }>;

/** Reasoning level display labels (model thinking strength). */
export const REASONING_META: Record<string, { label: string }> = {
  off: { label: '关闭' },
  low: { label: '低' },
  medium: { label: '中' },
  high: { label: '高' },
};
export const REASONING_KEYS = Object.keys(REASONING_META);

/** Bundle/mode picker options for a new session (ADR-0015). */
export const MODES: { id: string; label: string; desc: string }[] = [
  { id: 'standard', label: 'standard', desc: '全量能力（工具 + 记忆 + 技能）' },
  { id: 'base', label: 'base', desc: '极简：仅 bash 与文件编辑' },
];

/** Display text of a thread message (text parts + serialized non-text parts). */
export function textOf(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((p) => (p.type === 'text' ? p.text ?? '' : JSON.stringify(p)))
    .join(' ');
}

/** Rough context-window size for a model id (nearest known tier). */
export function contextLimit(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('claude')) return 200_000;
  if (m.includes('32k')) return 32_768;
  if (m.includes('128k') || m.includes('gpt-4o')) return 128_000;
  return 128_000;
}

/** Compact token-count display: 1.5K / 32K / 1.2M. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

export interface UsageEstimate {
  tokens: number;
  limit: number;
  percent: number;
  systemTokens: number;
  toolTokens: number;
  messageTokens: number;
}

/**
 * Estimate round-trip context usage from the visible message list: a fixed
 * system-prompt allowance, serialized tool parts, and text parts — each
 * token-ized at ~4 chars/token, clamped to the model's context limit.
 */
export function estimateUsage(
  messages: readonly { content: string | readonly { type: string; text?: string }[] }[],
  model: string,
): UsageEstimate {
  const limit = contextLimit(model);
  const systemTokens = 1_000;
  const toolTokens = messages.reduce((sum, m) => {
    const content = Array.isArray(m.content) ? m.content : [];
    return (
      sum +
      content
        .filter((p) => p.type === 'tool-call' || p.type === 'tool-result')
        .reduce((s, p) => s + Math.ceil(JSON.stringify(p).length / 4), 0)
    );
  }, 0);
  const messageTokens = messages.reduce((sum, m) => sum + Math.ceil(textOf(m.content).length / 4), 0);
  const tokens = Math.min(limit, systemTokens + toolTokens + messageTokens);
  const percent = Math.max(1, Math.min(100, Math.round((tokens / limit) * 100)));
  return { tokens, limit, percent, systemTokens, toolTokens, messageTokens };
}
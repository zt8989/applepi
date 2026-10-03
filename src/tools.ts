import { Type } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from './agent-tool';

/**
 * 内置工具集。围绕「本地小助手」这个骨架给三个够用的：
 * 看时间、算算术、读文件。想要 fs / shell 自己在这里加就行。
 */

const nowTool: AgentTool = {
  name: 'now',
  label: '当前时间',
  description: '获取当前的本地日期与时间。',
  parameters: Type.Object({}),
  execute: async (): Promise<AgentToolResult> => {
    const text = new Date().toLocaleString('zh-CN', { hour12: false });
    return { content: [{ type: 'text', text: `当前时间：${text}` }], details: null };
  },
};

const calcTool: AgentTool = {
  name: 'calc',
  label: '计算器',
  description:
    '计算一个算术表达式，例如 "1+2*3"、"(2**10)/4"。只支持纯算术，不要夹别的文字。',
  parameters: Type.Object({
    expression: Type.String({ description: '算术表达式，如 "1+2*3"' }),
  }),
  execute: async (_id, params): Promise<AgentToolResult> => {
    const expression = String(params.expression ?? '');
    if (!/^[0-9+\-*/().,%\s]+$/.test(expression)) {
      throw new Error(`表达式含不允许的字符：${expression}`);
    }
    const mathNames = Object.getOwnPropertyNames(Math).join(',');
    const value = new Function(
      `"use strict";const {${mathNames}}=Math;return (${expression});`,
    )() as unknown;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`计算结果不是有限数：${String(value)}`);
    }
    return {
      content: [{ type: 'text', text: `${expression} = ${value}` }],
      details: { value },
    };
  },
};

const readFileTool: AgentTool = {
  name: 'read_file',
  label: '读文件',
  description: '读取一个本地文本文件（UTF-8），返回其内容。需要绝对路径。',
  parameters: Type.Object({
    path: Type.String({ description: '文件的绝对路径' }),
  }),
  execute: async (_id, params): Promise<AgentToolResult> => {
    const { readFile } = await import('node:fs/promises');
    const path = String(params.path ?? '');
    const text = await readFile(path, 'utf8');
    const truncated = text.length > 8000 ? `${text.slice(0, 8000)}\n…（已截断）` : text;
    return { content: [{ type: 'text', text: truncated }], details: { bytes: text.length } };
  },
};

const registry: readonly AgentTool[] = [nowTool, calcTool, readFileTool];

export function getTools(): readonly AgentTool[] {
  return registry;
}

export function getTool(name: string): AgentTool | undefined {
  return registry.find((tool) => tool.name === name);
}

/**
 * 设置面板后面三页的数据源：**子代理 / 插件 / MCP**。
 *
 * 三样都是「磁盘上的配置」，不是内核状态：agent 定义是 `*.md`、插件是
 * `settings.json` 的 `packages` + 装好的扩展入口、MCP 是 `mcp.json`。所以这里只做
 * **读与摊平**，交给 `web/api.ts` 当只读接口；写仍然留给 pi（`pi install` /
 * 手改 `mcp.json`）—— 本项目没有包管理器，也不去连 MCP 服务器。
 *
 * ## 为什么 agent 用「简化发现」而不是 import pi-subagents
 *
 * pi-subagents 是本项目**通过扩展装载**的第三方包，不是 core 的依赖。为了一个只读
 * 列表把它的内部模块 import 进来，会把「扩展装没装」变成 core 的硬依赖。这里只按它
 * 的约定扫目录：包里的 `agents/`、`~/.pi/agent/agents/`、`~/.agents/`、项目
 * `.pi/agents/`、`.agents/`；同名时 project > user > package > builtin（与它的
 * `AGENT_SOURCE_PRIORITY` 同一个方向）。
 *
 * 代价是 frontmatter 只认单行标量（`name` / `description` / `tools` / `model` /
 * `thinking` / `enabled`）—— 那正是面板上要显示的几项；嵌套的 `runner:` 之类不碰。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { validateMcpServerConfig } from '@earendil-works/pi-coding-agent/dist/core/mcp-servers.js';
import type { McpServerConfig } from '@earendil-works/pi-coding-agent/dist/core/mcp-servers.js';
import { configHome, readJsonIfExists, settingsPath } from './config-home';
import type { ExtensionEntry } from './extension-host';
import type {
  WebAgentInfo,
  WebMcpInfo,
  WebMcpServerInfo,
  WebPluginInfo,
  WebPluginsInfo,
} from './web-protocol';

// ─── 子代理 ───

const AGENT_PRIORITY = { builtin: 0, package: 1, user: 2, project: 3 } as const;

/** 目录里顶层的 `*.md`（agent 定义是平铺文件；`SKILL.md` 在子目录里，不会被扫到）。 */
function markdownFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * 只解析 frontmatter 里的单行标量。
 *
 * 多行/嵌套字段（`runner:`）直接跳过：面板只显示 `name` / `description` / `tools` /
 * `model` / `thinking` / `enabled`。写坏一行不该让整个列表消失。
 */
function frontmatterFields(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const fields: Record<string, string> = {};
  for (const line of text.slice(3, end).split('\n')) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (match === null) continue;
    const [, key = '', raw = ''] = match;
    const value = raw.trim();
    if (value === '' || value.startsWith('|') || value.startsWith('>')) continue;
    if (value.startsWith('{') || value.startsWith('[')) continue;
    fields[key] = value.replace(/^["']|["']$/g, '');
  }
  return fields;
}

function readAgent(file: string, source: WebAgentInfo['source'], packageName?: string): WebAgentInfo | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const meta = frontmatterFields(text);
  const name = (meta['name'] ?? path.basename(file, '.md')).trim();
  if (name === '') return null;
  const tools = (meta['tools'] ?? '')
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool !== '');
  return {
    name,
    description: meta['description'] ?? '',
    source,
    ...(packageName !== undefined ? { packageName } : {}),
    filePath: file,
    tools,
    model: meta['model'] ?? null,
    thinking: meta['thinking'] ?? null,
    enabled: meta['enabled'] !== 'false',
  };
}

function addAgents(
  found: { info: WebAgentInfo; priority: number }[],
  dir: string,
  source: WebAgentInfo['source'],
  packageName?: string,
): void {
  for (const file of markdownFiles(dir)) {
    const info = readAgent(file, source, packageName);
    if (info !== null) found.push({ info, priority: AGENT_PRIORITY[source] });
  }
}

/**
 * 发现子代理定义。`extensions` 用来找**包自带的** agents（例如 pi-subagents 的
 * `agents/` 目录）；其他目录按 pi-subagents 的约定扫。
 */
export function agentInfos(
  cwd: string,
  extensions: readonly ExtensionEntry[],
): WebAgentInfo[] {
  const found: { info: WebAgentInfo; priority: number }[] = [];

  for (const entry of extensions) {
    if (entry.baseDir === undefined) continue;
    const packageName = npmPackageName(entry.source) ?? path.basename(entry.baseDir);
    // pi-subagents 自己的 agents 对用户就是「内置」；其他包带过来的算「包」。
    const source: WebAgentInfo['source'] = packageName === 'pi-subagents' ? 'builtin' : 'package';
    addAgents(found, path.join(entry.baseDir, 'agents'), source, packageName);
  }

  addAgents(found, path.join(configHome(), 'agents'), 'user');
  addAgents(found, path.join(homedir(), '.agents'), 'user');
  addAgents(found, path.join(homedir(), '.agents', 'agents'), 'user');

  addAgents(found, path.join(cwd, '.pi', 'agents'), 'project');
  addAgents(found, path.join(cwd, '.agents'), 'project');
  addAgents(found, path.join(cwd, '.agents', 'agents'), 'project');

  const byName = new Map<string, { info: WebAgentInfo; priority: number }>();
  for (const candidate of found) {
    const current = byName.get(candidate.info.name);
    if (current === undefined || candidate.priority > current.priority) {
      byName.set(candidate.info.name, candidate);
    }
  }
  return [...byName.values()]
    .sort((a, b) => b.priority - a.priority || a.info.name.localeCompare(b.info.name))
    .map((candidate) => candidate.info);
}

// ─── 插件 / 扩展 ───

function npmSpec(source: string): { name: string; version: string | null } | null {
  if (!source.startsWith('npm:')) return null;
  const spec = source.slice(4).trim();
  const match = /^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/.exec(spec);
  if (match === null) return null;
  const [, name = '', version] = match;
  return name === '' ? null : { name, version: version ?? null };
}

function npmPackageName(source: string): string | undefined {
  return npmSpec(source)?.name;
}

function sourceName(source: string, baseDir: string | null, entryPath: string): string {
  const npm = npmSpec(source);
  if (npm !== null) return npm.name;
  if (source.startsWith('git:')) {
    const repo = source
      .slice(4)
      .replace(/[#?].*$/, '')
      .replace(/\.git$/, '');
    return repo.split(/[\\/]/).filter((part) => part !== '').pop() ?? path.basename(entryPath);
  }
  return baseDir === null ? path.basename(entryPath) : path.basename(baseDir);
}

interface PackageMeta {
  name?: string;
  version?: string;
  description?: string;
}

function packageMeta(baseDir: string | null): PackageMeta {
  if (baseDir === null) return {};
  const raw = readJsonIfExists<Record<string, unknown>>(path.join(baseDir, 'package.json'));
  if (raw === null) return {};
  return {
    ...(typeof raw['name'] === 'string' ? { name: raw['name'] } : {}),
    ...(typeof raw['version'] === 'string' ? { version: raw['version'] } : {}),
    ...(typeof raw['description'] === 'string' ? { description: raw['description'] } : {}),
  };
}

function configuredPackages(): string[] {
  const settings = readJsonIfExists<{ packages?: unknown }>(settingsPath());
  const packages = settings?.packages;
  return Array.isArray(packages) ? packages.filter((item): item is string => typeof item === 'string') : [];
}

/** `settings.json` 的 `packages` + 真正装上的扩展入口。只读。 */
export function pluginInfos(
  extensions: readonly ExtensionEntry[],
  errors: readonly string[],
): WebPluginsInfo {
  const infos: WebPluginInfo[] = extensions.map((entry) => {
    const baseDir = entry.baseDir ?? null;
    const meta = packageMeta(baseDir);
    const npm = npmSpec(entry.source);
    return {
      name: meta.name ?? sourceName(entry.source, baseDir, entry.path),
      version: meta.version ?? npm?.version ?? null,
      description: meta.description ?? null,
      source: entry.source,
      path: entry.path,
      baseDir,
      hidden: entry.hidden,
    };
  });
  infos.sort((a, b) => a.name.localeCompare(b.name));
  return { packages: configuredPackages(), extensions: infos, errors: [...errors] };
}

// ─── MCP ───

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface McpEntry {
  name: string;
  config: McpServerConfig;
  scope: 'global' | 'project';
  source: string;
}

interface McpReadState {
  servers: Map<string, McpEntry>;
  errors: string[];
  autoEnableCodemode: boolean | undefined;
}

function readMcpFile(file: string, scope: 'global' | 'project', state: McpReadState): void {
  if (!existsSync(file)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    state.errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!isRecord(parsed)) {
    state.errors.push(`${file}: 需要一个带 "mcpServers" 的对象`);
    return;
  }
  if (typeof parsed['autoEnableCodemode'] === 'boolean') {
    state.autoEnableCodemode = parsed['autoEnableCodemode'];
  } else if (parsed['autoEnableCodemode'] !== undefined) {
    state.errors.push(`${file}: autoEnableCodemode 必须是布尔值`);
  }

  const servers = parsed['mcpServers'];
  if (servers !== undefined && !isRecord(servers)) {
    state.errors.push(`${file}: "mcpServers" 必须是一个对象`);
    return;
  }

  for (const [name, raw] of Object.entries(servers ?? {})) {
    if (!isRecord(raw)) {
      state.errors.push(`${file}: 服务器 "${name}" 必须是一个对象`);
      continue;
    }
    const overrideOnly =
      scope === 'project' &&
      raw['command'] === undefined &&
      raw['url'] === undefined &&
      raw['type'] === undefined;
    if (overrideOnly) {
      const base = state.servers.get(name);
      if (base === undefined) {
        state.errors.push(`${file}: 服务器 "${name}" 需要 command / url，或对应一个全局服务器来覆盖`);
        continue;
      }
      const validated = validateMcpServerConfig(name, { ...base.config, ...raw });
      if (typeof validated === 'string') {
        state.errors.push(`${file}: ${validated}`);
        continue;
      }
      state.servers.set(name, { ...base, config: validated, source: file });
      continue;
    }
    const validated = validateMcpServerConfig(name, raw);
    if (typeof validated === 'string') {
      state.errors.push(`${file}: ${validated}`);
      continue;
    }
    state.servers.set(name, { name, config: validated, scope, source: file });
  }
}

function describeTransport(config: McpServerConfig): string {
  if ('url' in config) return `http: ${config.url}`;
  const args = config.args ?? [];
  return `stdio: ${[config.command, ...args].join(' ')}`;
}

/** `mcp.json` 里的服务器（全局 + 项目；只读，不连接）。 */
export function mcpInfos(cwd: string): WebMcpInfo {
  const state: McpReadState = { servers: new Map(), errors: [], autoEnableCodemode: undefined };
  const globalPath = path.join(configHome(), 'mcp.json');
  const projectPath = path.join(cwd, '.pi', 'mcp.json');
  readMcpFile(globalPath, 'global', state);
  readMcpFile(projectPath, 'project', state);

  const servers: WebMcpServerInfo[] = [...state.servers.values()]
    .map(({ name, config, scope, source }) => ({
      name,
      scope,
      source,
      enabled: config.enabled !== false,
      exposure: config.exposure ?? 'codemode',
      description: config.description ?? null,
      transport: describeTransport(config),
      envKeys: 'command' in config ? Object.keys(config.env ?? {}) : [],
      headerKeys: 'url' in config ? Object.keys(config.headers ?? {}) : [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    servers,
    errors: state.errors,
    globalPath,
    projectPath,
    projectExists: existsSync(projectPath),
    autoEnableCodemode: state.autoEnableCodemode ?? null,
  };
}

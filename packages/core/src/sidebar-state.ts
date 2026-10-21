/**
 * 侧边栏自己的状态：**哪些会话被归档了**。
 *
 * 归档是**人的一个决定**，不是这次对话发生过的事，所以单存一份文件
 * （`<家目录>/ela-webui-sidebar-state.json`，键是会话 id、值是归档时刻 ms），
 * 不写进会话 `.jsonl`（pi / 终端那边会看到不认识的 entry），也不塞 `settings.json`（那是配置）。
 *
 * 存时刻而不是布尔：归档视图要按「什么时候归档的」排。没有这个键 = 没归档，
 * 于是「恢复」就是删掉这个键——没有第三种状态。
 *
 * 文件坏了当空读（并 `console.warn` 一次）：列表少几条归档标记，比整个侧边栏拉不出来强。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configHome } from './config-home';

/** 状态文件版本。读到的不是它就当空（半懂不懂不如重来）。 */
export const SIDEBAR_STATE_VERSION = 1;

export interface SidebarState {
  version: number;
  /** 会话 id → 归档时刻（ms）。没有这个键 = 没归档。 */
  archived: Record<string, number>;
}

/**
 * 合法的会话 id：与 pi 写的一致（UUIDv7 那种），也放过测试里造的 `sess-alpha`。
 *
 * 校验的理由不是洁癖：这些键会变成界面上的 data-* 与请求体，`__proto__` 这类键
 * 赋值会改掉对象的原型。
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value) && value !== '__proto__';
}

export function sidebarStatePath(): string {
  return path.join(configHome(), 'ela-webui-sidebar-state.json');
}

function emptyState(): SidebarState {
  return { version: SIDEBAR_STATE_VERSION, archived: {} };
}

/** 读状态；没有文件 / 读不懂都给空（见文件头）。 */
export function readSidebarState(file: string = sidebarStatePath()): SidebarState {
  if (!existsSync(file)) return emptyState();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.warn(
      `[ela] 侧边栏状态读不懂，当作空的：${file}（${error instanceof Error ? error.message : String(error)}）`,
    );
    return emptyState();
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyState();
  const record = raw as Record<string, unknown>;
  if (record['version'] !== SIDEBAR_STATE_VERSION) return emptyState();
  const source = record['archived'];
  const state = emptyState();
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return state;
  for (const [id, at] of Object.entries(source)) {
    if (!isSessionId(id)) continue;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue;
    state.archived[id] = at;
  }
  return state;
}

/** 写状态（临时文件 + rename：崩在写一半时不会留下一份半截 JSON）。 */
export function writeSidebarState(state: SidebarState, file: string = sidebarStatePath()): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** 归档（`at` 是时刻）或恢复（`at = null`）这一批会话，返回写下去的那份状态。 */
export function setArchivedSessions(
  ids: readonly string[],
  at: number | null,
  file: string = sidebarStatePath(),
): SidebarState {
  const state = readSidebarState(file);
  let changed = false;
  for (const id of ids) {
    if (!isSessionId(id)) continue;
    if (at === null) {
      if (state.archived[id] === undefined) continue;
      delete state.archived[id];
      changed = true;
      continue;
    }
    if (state.archived[id] === at) continue;
    state.archived[id] = at;
    changed = true;
  }
  if (changed) writeSidebarState(state, file);
  return state;
}

export function forgetArchivedSessions(
  ids: readonly string[],
  file: string = sidebarStatePath(),
): SidebarState {
  return setArchivedSessions(ids, null, file);
}

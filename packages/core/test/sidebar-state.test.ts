/**
 * 侧边栏归档状态（`sidebar-state.ts`）。
 *
 * 这一份**碰的是磁盘上的一个文件**，而错了的症状都很安静：归档过了重启又冒出来、
 * 恢复不掉、`__proto__` 把一个对象的原型改掉、「已归档 · N」数到已经不存在的会话上。
 * 所以都在这里钉住（每条用一个自己的临时文件，不碰共享的隔离家目录）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readSidebarState,
  setArchivedSessions,
  sidebarStatePath,
  writeSidebarState,
  SIDEBAR_STATE_VERSION,
} from '../src/sidebar-state';
import { configHome } from '../src/config-home';

function withTempFile(run: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'ela-sidebar-state-'));
  try {
    run(path.join(dir, 'state.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('归档状态：没这个文件 = 什么都没归档（不是报错）', () => {
  withTempFile((file) => {
    const state = readSidebarState(file);
    assert.deepEqual(state.archived, {});
    assert.equal(state.version, SIDEBAR_STATE_VERSION);
  });
});

test('归档状态：写下去能读回来，恢复就是删掉那个键', () => {
  withTempFile((file) => {
    setArchivedSessions(['sess-alpha', 'sess-beta'], 1_700_000_000_000, file);
    assert.deepEqual(readSidebarState(file).archived, {
      'sess-alpha': 1_700_000_000_000,
      'sess-beta': 1_700_000_000_000,
    });

    setArchivedSessions(['sess-alpha'], null, file);
    assert.deepEqual(readSidebarState(file).archived, { 'sess-beta': 1_700_000_000_000 });
  });
});

test('归档状态：空改动不写盘（免得每分钟把 mtime 刷新一遍）', () => {
  withTempFile((file) => {
    writeSidebarState({ version: SIDEBAR_STATE_VERSION, archived: { 'sess-alpha': 123 } }, file);
    const before = readFileSync(file, 'utf8');
    // 两条都是「什么也没变」：空的一批，与恢复一个**没归档**的。
    setArchivedSessions([], 1_700_000_000_000, file);
    setArchivedSessions(['sess-other'], null, file);
    assert.equal(readFileSync(file, 'utf8'), before);
  });
});

test('归档状态：文件坏了当空读（不让一个坏 JSON 把侧边栏拖死）', () => {
  withTempFile((file) => {
    writeFileSync(file, '{ 这不是 JSON');
    assert.deepEqual(readSidebarState(file).archived, {});
    // 坏文件之后照样能写（写下去的是完整的一份）。
    setArchivedSessions(['sess-alpha'], 42, file);
    assert.deepEqual(readSidebarState(file).archived, { 'sess-alpha': 42 });
  });
});

test('归档状态：版本不对 / 值不是时间戳 / 键名不合法的一律丢掉', () => {
  withTempFile((file) => {
    writeJson(file, { version: 99, archived: { 'sess-alpha': 42 } });
    assert.deepEqual(readSidebarState(file).archived, {}, '版本不对 → 空');

    writeJson(file, {
      version: SIDEBAR_STATE_VERSION,
      archived: {
        'sess-alpha': 42,
        'sess-beta': 'yesterday',
        'sess-gamma': -1,
        '__proto__': 42,
        'has space': 42,
      },
    });
    assert.deepEqual(readSidebarState(file).archived, { 'sess-alpha': 42 });
  });
});

test('归档状态：默认路径就在家目录里（与 pi 的 sessions/ 并排）', () => {
  const file = sidebarStatePath();
  assert.equal(path.basename(file), 'ela-webui-sidebar-state.json');
  assert.equal(path.dirname(file), configHome(), '和 pi 的配置家目录同一个（不是项目目录、也不是 cwd）');
});

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value), 'utf8');
}

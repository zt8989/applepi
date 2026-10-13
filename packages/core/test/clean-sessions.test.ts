import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cleanSessions, cleanSessionsExcept, listSessions, tracePathFor } from '../src/config-home';

/**
 * 清理历史会话。
 *
 * 背景：测试每跑一次就在 `~/.redux-agent/sessions/` 里落一个以临时目录命名的会话，
 * 用户的「恢复历史」列表因此被彻底污染（见 test-support/isolated-home.ts 的说明）。
 * 现在测试自己隔离了，但**已经堆下的那些还在**，而且以后手工作业一样会堆。
 * 所以要有一个能真删的入口 —— 这组测试守住它。
 *
 * 这些测试跑在 `test-support/isolated-home.ts` 指好的临时家目录里（PI_CODING_AGENT_DIR），
 * 碰不到真实的 `~/.redux-agent`。
 */

/** 在家目录里造一个假的会话文件（会话 + 对应轨迹），返回它的 id。 */
function fakeSession(id: string, cwd: string): string {
  const home = process.env['PI_CODING_AGENT_DIR'];
  assert.ok(home, '测试必须跑在隔离的 PI_CODING_AGENT_DIR 下');
  const dir = path.join(home, 'sessions', `--${cwd.replace(/[/\\:]/g, '-')}--`);
  mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ type: 'session', version: 1, id, timestamp: new Date().toISOString(), cwd });
  writeFileSync(path.join(dir, `${id}.jsonl`), `${header}\n`, 'utf8');
  const trace = tracePathFor(id);
  mkdirSync(path.dirname(trace), { recursive: true });
  writeFileSync(trace, '{"op":"add"}\n', 'utf8');
  return id;
}

test('cleanSessions：会话文件与轨迹文件**都**删掉', () => {
  const cwd = path.join(process.cwd(), 'proj-a');
  const id = fakeSession('sess-a', cwd);
  const sessionFile = listSessions().find((s) => s.id === id)?.file;
  assert.ok(sessionFile, '刚造的会话要能被列出来');
  assert.ok(existsSync(tracePathFor(id)), '轨迹文件在');

  const result = cleanSessions([id]);
  assert.equal(result.sessions, 1);
  assert.equal(result.removed, 2, '会话 + 轨迹，两个文件');
  assert.equal(result.failed.length, 0);
  assert.equal(existsSync(sessionFile), false, '会话文件删了');
  assert.equal(existsSync(tracePathFor(id)), false, '轨迹也删了 —— 只删会话的话 traces/ 会一直涨');
  assert.equal(listSessions().some((s) => s.id === id), false);
});

test('cleanSessionsExcept：放行 keep 里的，其余全清', () => {
  const keep = fakeSession('sess-keep', path.join(process.cwd(), 'proj-b'));
  const a = fakeSession('sess-x1', path.join(process.cwd(), 'proj-b'));
  const b = fakeSession('sess-x2', path.join(process.cwd(), 'proj-c'));

  const result = cleanSessionsExcept([keep]);
  const left = listSessions().map((s) => s.id);
  assert.ok(left.includes(keep), '当前会话必须留着（记录器正开着它的文件）');
  assert.equal(left.includes(a), false);
  assert.equal(left.includes(b), false);
  assert.equal(result.sessions, 2);
});

test('cleanSessions：删不存在的 id 不会把整批带崩', () => {
  const id = fakeSession('sess-c', path.join(process.cwd(), 'proj-d'));
  const result = cleanSessions(['根本没有这个会话', id]);
  // 找不到的记进 failed，但该删的照样删 —— 一个顽固文件不该让整批清理失败。
  assert.equal(result.sessions, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(listSessions().some((s) => s.id === id), false);
});

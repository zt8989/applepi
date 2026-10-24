import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  encodeCwd,
  migrateFlatTraces,
  traceDirFor,
  traceMigrateMarkerPath,
  tracesDir,
} from '../src/config-home';

/**
 * 旧轨迹迁移：平的 `traces/*.jsonl` 归位到 `traces/--<cwd>--/`。
 *
 * 每个用例自己把平目录文件造好（隔离的家目录里），跑 `migrateFlatTraces()`，
 * 断言文件去了该去的地方、标记文件写上了。标记的存在让第二次调用是 no-op。
 */

/** 家目录（isolated-home.ts 预先指好的临时目录）。 */
function home(): string {
  const dir = process.env['PI_CODING_AGENT_DIR'];
  assert.ok(dir, '测试必须跑在隔离的 PI_CODING_AGENT_DIR 下');
  return dir;
}

/** 标记文件是进程级一次性的；每个用例开跑前清掉，让它真的跑。 */
function resetMarker(): void {
  rmSync(traceMigrateMarkerPath(), { force: true });
}

/** 往平的 traces/ 里放一个旧布局文件。 */
function flatTrace(name: string, content: string): void {
  mkdirSync(tracesDir(), { recursive: true });
  writeFileSync(path.join(tracesDir(), name), content, 'utf8');
}

/** 在 sessions/ 里放一个带头部的会话文件（迁移靠它拿 cwd）。 */
function fakeSession(id: string, cwd: string): void {
  const dir = path.join(home(), 'sessions', encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({
    type: 'session',
    version: 1,
    id,
    timestamp: new Date().toISOString(),
    cwd,
  });
  writeFileSync(path.join(dir, `${id}.jsonl`), `${header}\n`, 'utf8');
}

const PROMPT_INIT_WITH_CWD = (cwd: string): string =>
  `${JSON.stringify({
    op: 'prompt.init',
    systemPrompt: 'x',
    sections: { cwd: `<cwd>\n${cwd}\n</cwd>` },
    tools: [],
  })}\n`;

test('迁移：sections.cwd 有 cwd 的归到对应项目目录', () => {
  resetMarker();
  const cwd = path.join(process.cwd(), 'migrate-proj-a');
  flatTrace('2026-01-01T00-00-00-000Z_aaaa1111-1111-1111-1111-111111111111.jsonl', PROMPT_INIT_WITH_CWD(cwd));

  const result = migrateFlatTraces();
  assert.ok(result, '第一次调用要真的跑');
  assert.equal(result.moved, 1);
  const target = path.join(traceDirFor(cwd), '2026-01-01T00-00-00-000Z_aaaa1111-1111-1111-1111-111111111111.jsonl');
  assert.ok(existsSync(target), '文件在新布局里');
  assert.ok(readFileSync(target, 'utf8').includes('prompt.init'), '内容原样搬过去');
  assert.ok(!existsSync(path.join(tracesDir(), 'aaaa1111-1111-1111-1111-111111111111.jsonl')));
  assert.ok(existsSync(traceMigrateMarkerPath()), '标记文件写上');
});

test('迁移：sessions header 兜底（trace 自己没有 sections）', () => {
  resetMarker();
  const cwd = path.join(process.cwd(), 'migrate-proj-b');
  const id = 'bbbb2222-2222-2222-2222-222222222222';
  fakeSession(id, cwd);
  flatTrace(`2026-01-02T00-00-00-000Z_${id}.jsonl`, '{"op":"model.init"}\n');

  const result = migrateFlatTraces();
  assert.ok(result);
  assert.equal(result.moved, 1);
  assert.ok(existsSync(path.join(traceDirFor(cwd), `2026-01-02T00-00-00-000Z_${id}.jsonl`)));
});

test('迁移：没有 cwd 线索的进 --unknown--，不丢', () => {
  resetMarker();
  const name = '2026-01-03T00-00-00-000Z_cccc3333-3333-3333-3333-333333333333.jsonl';
  flatTrace(name, '{"op":"prompt.init","systemPrompt":"x","tools":[]}\n');

  const result = migrateFlatTraces();
  assert.ok(result);
  assert.equal(result.unknown, 1);
  const target = path.join(tracesDir(), '--unknown--', name);
  assert.ok(existsSync(target));
  assert.ok(readFileSync(target, 'utf8').includes('prompt.init'));
});

test('迁移：只跑一次（标记存在直接 no-op），且幂等', () => {
  resetMarker();
  // 先让迁移真跑一次（写标记），再验第二次调用是 no-op。
  const first = '2026-01-04T00-00-00-000Z_dddd4444-4444-4444-4444-444444444444.jsonl';
  flatTrace(first, '{"op":"model.init"}\n');
  assert.ok(migrateFlatTraces(), '第一次要真跑');
  const before = readFileSync(traceMigrateMarkerPath(), 'utf8');

  // 标记在：第二次调用不动任何东西。
  const late = '2026-01-06T00-00-00-000Z_eeee5555-5555-5555-5555-555555555555.jsonl';
  flatTrace(late, '{"op":"model.init"}\n');
  assert.equal(migrateFlatTraces(), null, '标记在 = no-op');
  assert.equal(before, readFileSync(traceMigrateMarkerPath(), 'utf8'));
  assert.ok(existsSync(path.join(tracesDir(), late)), '晚来的文件不被碰');

  // 幂等：手工删掉标记再跑，晚来的那个这次会被归位（它没 cwd → --unknown--），
  // 且不会重复动已经搬走的 —— rename 过的文件不在平目录了。
  rmSync(traceMigrateMarkerPath());
  const second = migrateFlatTraces();
  assert.ok(second);
  assert.equal(second.moved, 0);
  assert.equal(second.unknown, 1);
  assert.ok(existsSync(path.join(tracesDir(), '--unknown--', late)), '晚来的文件这次进了 unknown');
});

test('迁移：新布局子目录不碰（只扫平目录的文件）', () => {
  resetMarker();
  const cwd = path.join(process.cwd(), 'migrate-proj-c');
  const dir = traceDirFor(cwd);
  mkdirSync(dir, { recursive: true });
  const existing = path.join(dir, '2026-01-05T00-00-00-000Z_eeee5555-5555-5555-5555-555555555555.jsonl');
  writeFileSync(existing, '{"op":"model.init"}\n', 'utf8');

  const result = migrateFlatTraces();
  assert.ok(result);
  assert.equal(result.moved + result.unknown + result.failed.length, 0, '平目录是空的，什么都不动');
  assert.ok(existsSync(existing), '子目录里的文件原样');
});

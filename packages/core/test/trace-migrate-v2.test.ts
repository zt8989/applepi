import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  encodeCwd,
  migrateTracesV2,
  traceDirFor,
  traceV2MigrateMarkerPath,
  tracesDir,
} from '../src/config-home';
import { replayTrace } from '../src/trace-store';

/**
 * v1 → v2 内容迁移（文件层）：扫 traces/ 的子目录，v1 原地升级成 v2，
 * v2 跳过，标记文件写上后整个迁移变成 no-op。
 */

function home(): string {
  const dir = process.env['PI_CODING_AGENT_DIR'];
  assert.ok(dir, '测试必须跑在隔离的 PI_CODING_AGENT_DIR 下');
  return dir;
}

function resetMarker(): void {
  rmSync(traceV2MigrateMarkerPath(), { force: true });
}

function projectDir(name: string): string {
  const dir = traceDirFor(path.join(process.cwd(), name));
  mkdirSync(dir, { recursive: true });
  return dir;
}

const V1 = [
  '{"op":"prompt.init","systemPrompt":"p","tools":[]}',
  '{"op":"add","node":{"id":"n1","parentId":null,"kind":"prompt.base","status":"ok","label":"p","detail":"p","createdAt":1,"endedAt":1}}',
  '{"op":"add","node":{"id":"n2","parentId":null,"kind":"user","status":"ok","label":"你好","createdAt":2,"endedAt":2}}',
  '{"op":"add","node":{"id":"n3","parentId":"n2","kind":"llm.result","status":"ok","label":"好","createdAt":3,"endedAt":3}}',
  '{"op":"close","id":"n3","status":"ok","endedAt":3}',
  '',
].join('\n');

test('v2 迁移：v1 文件原地升级（版本头 + seq + hash id + 单一根），v2 跳过', () => {
  resetMarker();
  const dir = projectDir('v2-migrate-a');
  const v1File = path.join(dir, '2026-02-01T00-00-00-000Z_aaaa1111-1111-1111-1111-111111111111.jsonl');
  writeFileSync(v1File, V1, 'utf8');
  const v2File = path.join(dir, '2026-02-01T00-00-01-000Z_bbbb2222-2222-2222-2222-222222222222.jsonl');
  writeFileSync(v2File, '{"seq":1,"op":"header","v":2}\n', 'utf8');

  const result = migrateTracesV2();
  assert.ok(result, '第一次调用要真的跑');
  assert.equal(result.upgraded, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed.length, 0);

  // v1 文件被升级：首行是版本头，每行 seq = 行号，树回放得出且只有一棵根。
  const upgraded = readFileSync(v1File, 'utf8');
  const lines = upgraded.split('\n').filter((l) => l.trim() !== '');
  assert.equal(JSON.parse(lines[0] ?? '{}').v, 2);
  lines.forEach((line, index) => {
    assert.equal(JSON.parse(line).seq, index + 1, `第 ${index + 1} 行`);
  });
  const tree = replayTrace(upgraded, 'aaaa1111-1111-1111-1111-111111111111');
  assert.equal(tree.order.length, 3);
  const root = tree.order[0] ?? '';
  assert.equal(tree.nodes[root]?.kind, 'prompt.base');
  assert.equal(tree.nodes[root]?.meta?.['role'], 'system');
  for (const id of tree.order) {
    const node = tree.nodes[id];
    assert.ok(node);
    if (id !== root) assert.ok(node.parentId !== null, `${node.kind} 不该是根`);
  }
  // .migrating 临时文件不留下来。
  assert.ok(!existsSync(`${v1File}.migrating`));

  // 标记写上：第二次调用是 no-op。
  assert.equal(migrateTracesV2(), null);
  assert.ok(existsSync(traceV2MigrateMarkerPath()));
});

test('v2 迁移：全新安装（没有 traces 目录）也写标记，且不炸', () => {
  resetMarker();
  rmSync(tracesDir(), { recursive: true, force: true });
  const result = migrateTracesV2();
  assert.ok(result);
  assert.equal(result.upgraded + result.skipped + result.failed.length, 0);
  assert.ok(existsSync(traceV2MigrateMarkerPath()));
  assert.ok(home());
});

test('v2 迁移：--unknown-- 里的 v1 同样升级', () => {
  resetMarker();
  const unknown = path.join(tracesDir(), '--unknown--');
  mkdirSync(unknown, { recursive: true });
  const file = path.join(unknown, '2026-02-02T00-00-00-000Z_cccc3333-3333-3333-3333-333333333333.jsonl');
  writeFileSync(file, V1, 'utf8');

  const result = migrateTracesV2();
  assert.ok(result);
  assert.equal(result.upgraded, 1);
  assert.equal(JSON.parse(readFileSync(file, 'utf8').split('\n')[0] ?? '{}').v, 2);
});

test('v2 迁移：升级失败不挡别的文件，失败清单报出来', () => {
  resetMarker();
  const dir = projectDir('v2-migrate-b');
  // 只读目录里造一个改不动的文件不太可移植；这里用「目录里放个同名子目录」制造 rename 失败：
  // `<file>.migrating` 是目录时 renameSync 会失败。
  const file = path.join(dir, '2026-02-03T00-00-00-000Z_dddd4444-4444-4444-4444-444444444444.jsonl');
  writeFileSync(file, V1, 'utf8');
  mkdirSync(`${file}.migrating`, { recursive: true });

  const result = migrateTracesV2();
  assert.ok(result);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0]?.file ?? '', /dddd4444/);
  // 原文件没被破坏。
  assert.equal(readFileSync(file, 'utf8'), V1);
  rmSync(`${file}.migrating`, { recursive: true, force: true });
});

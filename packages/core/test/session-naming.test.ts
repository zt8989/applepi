import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  configHome,
  encodeCwd,
  fileTimestamp,
  findFileById,
  findSessionFile,
  findSessionFileById,
  findTraceFile,
  sessionPath,
  listSessions,
  resumeCommand,
  sessionFileName,
  sessionIdFromFileName,
  traceFileName,
} from '../src/config-home';
import { newSessionId } from '../src/trace';
import { SessionWriter } from '../src/session-file';
import { readSessionMessages } from '../src/session-file';
import type { AgentAction } from '../src/actions';
import { createFileSink, tracePath } from '../src/trace-file';

/**
 * 文件名与恢复命令：`<时间戳>_<id>.jsonl`（与 pi 同一形状）+ `To resume this session`。
 *
 * ## 为什么值得一组测试
 *
 * 这两件事都是**约定**：id 是 UUIDv7、文件名是「ISO 时间戳换掉 `:` `.` 再拼下划线」
 *（与 pi 对齐），退出时那句 `ela --session <id>` 得真的能粘回去恢复。约定一旦漂了，
 * 症状是「提示的命令粘回去打不开会话」—— 而那个失败远在另一个进程里，本地测试若不
 * 盯住就无人察觉。
 */

async function withHome(fn: (home: string) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'naming-home-'));
  const previous = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

// ── id：UUIDv7 ──

test('newSessionId：UUIDv7 形状（与 pi 同形），且两次不撞', () => {
  const id = newSessionId();
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    `应是版本 7 的 UUID。实际：${id}`,
  );
  // 旧实现是 `s<base36 时间戳>`：同一毫秒内两次开新会话会撞 id，于是两次会话共用一个文件。
  const ids = new Set(Array.from({ length: 100 }, () => newSessionId()));
  assert.equal(ids.size, 100, '100 次生成 100 个不同的 id（旧实现同一毫秒会撞）');
});

// ── 文件名：`<时间戳>_<id>.jsonl` ──

test('fileTimestamp：把 `:` 与 `.` 都换成 `-`（与 pi 同一规则）', () => {
  assert.equal(fileTimestamp('2026-10-12T05:44:28.468Z'), '2026-10-12T05-44-28-468Z');
});

test('会话与轨迹文件名是 `<时间戳>_<id>.jsonl`，且能反解出 id', () => {
  const id = '01a12ea4-09d6-73ca-8dc5-8df8597cdb12';
  const ts = '2026-10-12T05:44:28.468Z';
  const expected = '2026-10-12T05-44-28-468Z_01a12ea4-09d6-73ca-8dc5-8df8597cdb12.jsonl';
  assert.equal(sessionFileName(id, ts), expected);
  assert.equal(traceFileName(id, ts), expected, '轨迹与会话同一命名规则');
  assert.equal(sessionIdFromFileName(expected), id, '从文件名反解出 id（列表要用）');
  assert.equal(sessionIdFromFileName('smv4jubkv.jsonl'), 'smv4jubkv', '旧名（无时间戳）也认');
});

test('SessionWriter 落盘用带时间戳的新名，且列得出来', async () => {
  await withHome(async () => {
    const cwd = '/proj';
    const w = new SessionWriter('01a12ea4-09d6-73ca-8dc5-8df8597cdb12', cwd);
    w.start();
    w.appendMessage({ role: 'user', content: '你好', timestamp: Date.now() });

    const name = path.basename(w.path);
    assert.match(
      name,
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_01a12ea4-09d6-73ca-8dc5-8df8597cdb12\.jsonl$/,
      `文件名应是 <时间戳>_<id>.jsonl。实际：${name}`,
    );

    const dir = path.join(configHome(), 'sessions', encodeCwd(cwd));
    assert.deepEqual(
      (await readdir(dir)).filter((f) => f.endsWith('.jsonl')),
      [name],
      '盘上就是这个新名',
    );
    assert.deepEqual(
      listSessions().map((s) => s.id),
      ['01a12ea4-09d6-73ca-8dc5-8df8597cdb12'],
      '按 id 列出来（id 从 header 读，不靠文件名）',
    );
  });
});

test('findFileById：找到新名，也认旧名，找不到返回 null', async () => {
  await withHome(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'findbyid-'));
    try {
      // 新名。
      writeFileSync(path.join(dir, '2026-10-12T05-44-28-468Z_new-1.jsonl'), '{}\n', 'utf8');
      assert.equal(
        path.basename(findFileById(dir, 'new-1') ?? ''),
        '2026-10-12T05-44-28-468Z_new-1.jsonl',
      );
      // 旧名（改名之前建的会话）仍然认。
      writeFileSync(path.join(dir, 'old-1.jsonl'), '{}\n', 'utf8');
      assert.equal(path.basename(findFileById(dir, 'old-1') ?? ''), 'old-1.jsonl');
      // 没有就是 null。
      assert.equal(findFileById(dir, 'nope'), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('listSessions：head 有 100KB+ 时 firstMessage 仍取得到（64KB 窗口那个坑）', async () => {
  await withHome(async () => {
    // pi v3 的 head（system prompt 分段 + 工具表）本身就能到 ~64KB，用户的第一句话紧跟其后。
    // 早先侧边栏按 64KB 单独扫一遍找标题，于是**新会话全都扫不到**、显示成一串 uuid。
    // 现在那句由 `listSessions()` 的 512KB 读顺手带出来，这条钉住它。
    const id = 'big-head';
    const cwd = '/proj-big';
    const file = sessionPath(id, cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    const stamp = new Date().toISOString();
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id, timestamp: stamp, cwd }),
        JSON.stringify({
          type: 'message',
          id: 'e1',
          parentId: null,
          timestamp: stamp,
          message: {
            role: 'system',
            content: '',
            timestamp: 1,
            sections: { rules: 'x'.repeat(70_000), docs: 'y'.repeat(40_000) },
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'e2',
          parentId: 'e1',
          timestamp: stamp,
          message: { role: 'user', content: 'head 之后的第一句话\n换行也要压掉', timestamp: 2 },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const summary = listSessions().find((session) => session.id === id);
    assert.equal(summary?.firstMessage, 'head 之后的第一句话 换行也要压掉', '压成一行，且没被 64KB 截掉');
  });
});

test('findSessionFileById：只知道 id 也能找到（不在这个 cwd 里的会话同样找到）', async () => {
  await withHome(async () => {
    // 两个 cwd、两个会话：`/proj-a` 一条、`/proj-b` 一条。
    const a = new SessionWriter('by-id-a', '/proj-a');
    a.start();
    a.appendMessage({ role: 'user', content: 'a', timestamp: 1 });
    const b = new SessionWriter('by-id-b', '/proj-b');
    b.start();
    b.appendMessage({ role: 'user', content: 'b', timestamp: 1 });

    // 关键那条：调用方只拿到 id（`?sessionId=` 就是这么来的），不知道它当初在哪个 cwd。
    assert.equal(findSessionFileById('by-id-a'), a.path);
    assert.equal(findSessionFileById('by-id-b'), b.path);
    assert.equal(findSessionFileById('nobody'), null, '没有就是 null，不猜路径');
    assert.equal(findSessionFileById(''), null, '空 id 不扫目录');
  });
});

test('findSessionFile / findTraceFile 指向实际文件（恢复、删会话靠它）', async () => {
  await withHome(async () => {
    const cwd = '/proj';
    const id = 'find-1';
    const w = new SessionWriter(id, cwd);
    w.start();
    w.appendMessage({ role: 'user', content: 'x', timestamp: 1 });
    assert.equal(findSessionFile(id, cwd), w.path);

    const trace = tracePath(id);
    mkdirSync(path.dirname(trace), { recursive: true });
    await createFileSink(trace).append('{"op":"add"}');
    assert.equal(findTraceFile(id), trace, '轨迹文件的实际路径也找得到');
  });
});

// ── 恢复命令 ──

test('resumeCommand：会话落过盘时给 `ela --session <id>`', async () => {
  await withHome(async () => {
    // 这条测试跑在 node:test 里，stdout 不是 TTY —— 而 `resumeCommand` 在非 TTY 下
    // **有意**返回 null（管道/重定向没人看那一行，与 pi 同一判断）。
    // 所以这里临时把 isTTY 伪造成 true，专门测「TTY 且文件在」这一条路。
    const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      const cwd = '/proj';
      const id = 'resume-1';
      assert.equal(resumeCommand(id, cwd), null, '一句话没说（还没建文件）时不提示');

      const w = new SessionWriter(id, cwd);
      w.start();
      w.appendMessage({ role: 'user', content: '说了', timestamp: 1 });
      assert.equal(resumeCommand(id, cwd), `ela --session ${id}`, '落过盘就给这一行');

      assert.equal(resumeCommand(undefined, cwd), null, '没有 id 不提示');
    } finally {
      if (original) Object.defineProperty(process.stdout, 'isTTY', original);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });
});

test('resumeCommand：非 TTY 不提示（管道/重定向没人看那一行）', async () => {
  await withHome(async () => {
    const cwd = '/proj';
    const id = 'resume-2';
    const w = new SessionWriter(id, cwd);
    w.start();
    w.appendMessage({ role: 'user', content: '说了', timestamp: 1 });
    const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    try {
      assert.equal(resumeCommand(id, cwd), null);
    } finally {
      if (original) Object.defineProperty(process.stdout, 'isTTY', original);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });
});

test('恢复一个旧名会话：写回**原文件**，不另建一个带时间戳的新文件', async () => {
  await withHome(async () => {
    const cwd = '/proj';
    const id = 'legacy-1';
    const dir = path.join(configHome(), 'sessions', encodeCwd(cwd));
    mkdirSync(dir, { recursive: true });
    const legacy = path.join(dir, `${id}.jsonl`);
    writeFileSync(
      legacy,
      `${JSON.stringify({ type: 'session', version: 1, id, timestamp: new Date().toISOString(), cwd })}\n`,
      'utf8',
    );

    const w = new SessionWriter(id, cwd);
    w.start();
    w.appendMessage({ role: 'user', content: '续写', timestamp: 1 });
    assert.equal(w.path, legacy, '已有文件就用它 —— 同一个会话不该在盘上分成两份');
    assert.equal(
      existsSync(path.join(dir, sessionFileName(id))),
      false,
      '没有另建一个带时间戳的新文件',
    );
  });
});

// ── `--session <id>` 真的能恢复（不是只把 id 安上去） ──
//
// 这条盯的是「退出提示与实际行为对称」：退出时打的是 `ela --session <id>`，那把同一个
// id 交给本项目自己（`ela --session <id>`）也必须能恢复 —— 否则界面上那行提示换成
// `ela` 就成了谎话，而用户看不出区别（界面起来了、只是空空如也）。
// tui.ts 的 `--session` 路径就是「findSessionFile(id) → kernel.restoreSession(file)」。
test('按 id 找到文件后 restoreSession：历史灌回来，之后的消息追加进**同一个**文件', async () => {
  await withHome(async () => {
    const { createKernel } = await import('../src/kernel');
    const cwd = process.cwd();

    // 第一次：造一个有内容的会话，记下 id 与文件名。
    const first = await createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd,
      demo: true,
      sessionId: 'resume-by-id',
      traceDir: null,
    });
    first.store.dispatch({ type: 'user.message', text: '第一句' } as AgentAction);
    await new Promise((r) => setTimeout(r, 60));
    first.dispose();
    await new Promise((r) => setTimeout(r, 100));

    const file = findSessionFile('resume-by-id', cwd);
    assert.ok(existsSync(file), '第一次的会话文件应该在');
    const before = readSessionMessages(file);

    // 第二次：模拟 `--session <id>` —— 先建内核（用这个 id），再按 id 找到文件恢复。
    const second = await createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd,
      demo: true,
      sessionId: 'resume-by-id',
      traceDir: null,
    });
    try {
      const restored = await second.restoreSession(findSessionFile('resume-by-id', cwd));
      assert.equal(restored.id, 'resume-by-id');
      assert.equal(restored.restored, before.length, '历史全部灌回来');
      assert.equal(second.store.getState().messages.length, before.length);

      // 发一句新的：追加进**同一个**文件，不是另建一个。
      second.store.dispatch({ type: 'user.message', text: '第二句' } as AgentAction);
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      second.dispose();
      await new Promise((r) => setTimeout(r, 100));
    }

    const after = readSessionMessages(file);
    assert.ok(
      after.some((m) => String((m as { content: unknown }).content).includes('第一句')),
      '第一句还在那个文件里',
    );
    assert.ok(
      after.some((m) => String((m as { content: unknown }).content).includes('第二句')),
      '第二句也追加进了同一个文件',
    );
    assert.equal(
      listSessions().filter((s) => s.id === 'resume-by-id').length,
      1,
      '盘上只有这一个会话（没有分成两份）',
    );
  });
});
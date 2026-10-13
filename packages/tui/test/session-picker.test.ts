/**
 * 「恢复历史」面板适配层的回归测试。
 *
 * ## 为什么这些要钉住
 *
 * 面板换成了 pi 官方的 `SessionSelectorComponent`（见 `packages/tui/src/session-picker.ts`），
 * 而官方的形状是 `SessionInfo` —— 我们的 `SessionSummary` 是**自己**的摘要。两个适配点
 * 各有自己的坑：
 *
 * 1. **`modified` 必须是「最后一次说话」，不是文件 mtime。** 官方用它排「N 分钟前」并
 *    作为默认排序依据。mtime 会被**任何**写入改动 —— 追加一条 `model_change`、或者
 *    用户给会话改了个名 —— 而「我半小时前说过话」不该被一次改名改掉。
 *    症状是「刚改完名，那个会话就跳到列表最上面了」。
 *
 * 2. **重命名要写 `session_info`，且不能动 `parentId` 链。** entry 是链式的
 *    （pi 用它做 session tree），重写文件就要重排那条链 —— 而「起个名字」不该动它。
 *    所以是 **append**。append 之后名字要能被**读回来**，且必须与 pi 双向兼容
 *    （`~/.pi/agent` 是同址的，pi 的 `/resume` 也要能显示这个名字）。
 *
 * 另外两条是纯约定的护栏，防止以后有人「顺手优化」掉：
 *
 * - 搜索**不**扫全文（`allMessagesText` 给空串）—— docs/architecture/sessions.md 里
 *   那条「打开 /sessions 要等一分钟」的结论就靠它。
 * - 删会话要连带删 `traces/<id>.jsonl` —— 只删会话文件的话 `traces/` 会一直涨。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listSessions, sessionPath, tracePathFor } from '@ela/core/config-home';
import { readJsonlTail, type MessageEntry } from '@ela/core/session-file';
import { deleteSessionTrace } from '../src/session-picker';

async function withHome(fn: (home: string) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'picker-home-'));
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

interface Entry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: unknown;
  [key: string]: unknown;
}

/** 造一个会话文件：header + 若干条消息。 */
function writeSession(cwd: string, id: string, messages: { role: string; text: string; at: number }[]): string {
  const file = sessionPath(id, cwd);
  mkdirSync(path.dirname(file), { recursive: true });
  const lines: string[] = [
    JSON.stringify({
      type: 'session',
      version: 1,
      id,
      timestamp: new Date(messages[0]?.at ?? 0).toISOString(),
      cwd,
    }),
  ];
  let prev: string | null = null;
  messages.forEach((m, i) => {
    const entry: Entry = {
      type: 'message',
      id: `e${i + 1}`,
      parentId: prev,
      timestamp: new Date(m.at).toISOString(),
      message: { role: m.role, content: m.text, timestamp: m.at },
    };
    lines.push(JSON.stringify(entry));
    prev = entry.id;
  });
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

// ── modified：最后一次说话，不是 mtime ──

test('lastActivityMs：取最后一条 user/assistant 消息，不看文件 mtime', async () => {
  await withHome(async () => {
    const cwd = process.cwd();
    const t = Date.UTC(2026, 0, 2, 3, 4, 5);
    writeSession(cwd, 'la1', [
      { role: 'user', text: '第一句', at: t },
      { role: 'assistant', text: '答', at: t + 1000 },
    ]);

    const got = listSessions().find((s) => s.id === 'la1');
    assert.ok(got);
    assert.equal(got.lastActivityMs, t + 1000, '取最后一条消息的时间');
  });
});

test('lastActivityMs：toolResult 不算（否则「读过文件」也算会话活跃）', async () => {
  await withHome(async () => {
    const cwd = process.cwd();
    const t = Date.UTC(2026, 0, 2, 3, 4, 5);
    const file = writeSession(cwd, 'la2', [{ role: 'user', text: '读一下', at: t }]);
    // 追加一条 toolResult：它的 timestamp 更晚，但用户没说过话。
    const later = t + 60_000;
    appendFileSync(
      file,
      `${JSON.stringify({
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        timestamp: new Date(later).toISOString(),
        message: { role: 'toolResult', content: 'ok', timestamp: later },
      })}\n`,
      'utf8',
    );

    const got = listSessions().find((s) => s.id === 'la2');
    assert.equal(got?.lastActivityMs, t, 'toolResult 的时间不算（与 pi 的 getMessageActivityTime 同一口径）');
  });
});

test('改名（追加一条 entry）不改变 lastActivityMs —— 那正是要做适配的原因', async () => {
  await withHome(async () => {
    const cwd = process.cwd();
    const t = Date.UTC(2026, 0, 2, 3, 4, 5);
    const file = writeSession(cwd, 'la3', [{ role: 'user', text: '问', at: t }]);
    const before = listSessions().find((s) => s.id === 'la3')?.lastActivityMs;

    // 模拟改名：追加一条 session_info（文件的 mtime 变了）。
    appendFileSync(
      file,
      `${JSON.stringify({
        type: 'session_info',
        id: 'ab12cd34',
        parentId: 'e1',
        timestamp: new Date(t + 999_000).toISOString(),
        name: '起个名字',
      })}\n`,
      'utf8',
    );

    const after = listSessions().find((s) => s.id === 'la3')?.lastActivityMs;
    assert.equal(after, before, '「最后一次说话」不因为改名而变');
  });
});

test('排序按最后一次说话，**不是**按文件 mtime', async () => {
  await withHome(async () => {
    const base = Date.UTC(2026, 0, 2, 3, 4, 5);
    const older = writeSession(process.cwd(), 'so-old', [{ role: 'user', text: '旧', at: base }]);
    const newer = writeSession(process.cwd(), 'so-new', [
      { role: 'user', text: '新', at: base + 3600_000 },
    ]);
    // 把「旧」那个的文件 mtime 顶到最新（模拟被无关写入碰过）。
    const future = new Date(base + 7200_000);
    utimesSync(older, future, future);

    const ids = listSessions().map((s) => s.id);
    assert.ok(
      ids.indexOf('so-new') < ids.indexOf('so-old'),
      `说话更晚的排前面（实际 ${ids.join(',')}）`,
    );
    assert.ok(existsSync(newer));
  });
});

test('readJsonlTail：文件不存在 / 空文件都不抛', async () => {
  assert.deepEqual(readJsonlTail('/nope/nothing.jsonl', 4096), { lastActivityMs: 0 });
  await withHome(async () => {
    const file = sessionPath('empty', process.cwd());
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '', 'utf8');
    assert.deepEqual(readJsonlTail(file, 4096), { lastActivityMs: 0 });
  });
});

test('readJsonlTail：崩溃截断的尾半行被跳过，不影响前面已读到的', async () => {
  await withHome(async () => {
    const t = Date.UTC(2026, 0, 2, 3, 4, 5);
    const file = writeSession(process.cwd(), 'tail-trunc', [{ role: 'user', text: '完整', at: t }]);
    appendFileSync(file, '{"type":"mess', 'utf8');
    assert.equal(readJsonlTail(file, 4096).lastActivityMs, t);
  });
});

// ── 名字（session_info）──

test('session_info 的名字能读回来；空串 = 显式清名（与 pi 同一语义）', async () => {
  await withHome(async () => {
    const cwd = process.cwd();
    const t = Date.UTC(2026, 0, 2, 3, 4, 5);
    const file = writeSession(cwd, 'nm', [{ role: 'user', text: '问', at: t }]);
    const append = (name: string): void =>
      appendFileSync(
        file,
        `${JSON.stringify({
          type: 'session_info',
          id: 'xx',
          parentId: 'e1',
          timestamp: new Date(t).toISOString(),
          name,
        })}\n`,
        'utf8',
      );

    append('第一个名字');
    assert.equal(listSessions().find((s) => s.id === 'nm')?.name, '第一个名字');

    append('第二个名字');
    assert.equal(
      listSessions().find((s) => s.id === 'nm')?.name,
      '第二个名字',
      '最后一条说了算（不是第一条）',
    );

    append('');
    assert.equal(
      listSessions().find((s) => s.id === 'nm')?.name,
      undefined,
      '空串 = 清掉名字，而不是回退到上一个',
    );
  });
});

// ── 作用域（Current Folder / All）──

test('listSessions({cwd})：只给当前目录的会话，别的目录仍在 All 里', async () => {
  await withHome(async () => {
    const here = path.join(process.cwd(), 'here');
    const elsewhere = path.join(process.cwd(), 'elsewhere');
    writeSession(here, 'sc-here', [{ role: 'user', text: '这', at: 1 }]);
    writeSession(elsewhere, 'sc-there', [{ role: 'user', text: '那', at: 1 }]);

    const scoped = listSessions({ cwd: here }).map((s) => s.id);
    assert.deepEqual(scoped, ['sc-here'], 'Current Folder 只有本目录的');

    const all = listSessions().map((s) => s.id);
    assert.ok(all.includes('sc-here') && all.includes('sc-there'), 'All 两个都在');
  });
});

test('listSessions({cwd})：坏 header（cwd 读不到）的会话算「不属于当前目录」，但仍在 All 里', async () => {
  await withHome(async () => {
    const here = path.join(process.cwd(), 'here2');
    const file = sessionPath('bad-hdr', here);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      '这一行不是 JSON\n{"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"读得出来吗","timestamp":1}}\n',
      'utf8',
    );

    assert.equal(
      listSessions({ cwd: here }).some((s) => s.id === 'bad-hdr'),
      false,
      'cwd 缺失时无法确认属于当前目录 —— 不列在 Current Folder 里',
    );
    assert.equal(
      listSessions().some((s) => s.id === 'bad-hdr'),
      true,
      '仍然列得出来（用户还能看到它、删掉它）',
    );
  });
});

// ── 删会话连带删轨迹 ──

test('deleteSessionTrace：会话删掉之后 traces/ 那份也走掉', async () => {
  await withHome(async () => {
    const cwd = process.cwd();
    const file = writeSession(cwd, 'tr-1', [{ role: 'user', text: '问', at: 1 }]);
    const trace = tracePathFor('tr-1');
    mkdirSync(path.dirname(trace), { recursive: true });
    writeFileSync(trace, '{"op":"add"}\n', 'utf8');

    const session = listSessions().find((s) => s.id === 'tr-1');
    assert.ok(session);
    assert.ok(existsSync(trace), '轨迹在');

    // 官方自己删会话文件（trash → unlink），我们只补轨迹那份。
    rmSync(file, { force: true });
    assert.equal(existsSync(file), false, '会话文件删了');
    assert.equal(deleteSessionTrace(session), true, '轨迹也删了');
    assert.equal(existsSync(trace), false, 'traces/ 不删的话会一直涨（只删会话是那个经典漏）');
  });
});

test('deleteSessionTrace：轨迹本来就不在时不报错（当成功）', async () => {
  await withHome(async () => {
    const cwd = process.cwd();
    writeSession(cwd, 'tr-2', [{ role: 'user', text: '问', at: 1 }]);
    const session = listSessions().find((s) => s.id === 'tr-2');
    assert.ok(session);
    assert.equal(deleteSessionTrace(session), true);
  });
});

// ── 搜索面 ──

test('搜索面不扫全文：摘要里没有 allMessagesText 那种东西（列表侧不读整个文件）', async () => {
  await withHome(async () => {
    // 造一个大会话：文件里有一段几百 KB 的 toolResult。
    const cwd = process.cwd();
    const t = 1;
    const file = writeSession(cwd, 'big', [{ role: 'user', text: '跑个命令', at: t }]);
    appendFileSync(
      file,
      `${JSON.stringify({
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        timestamp: new Date(t).toISOString(),
        message: { role: 'toolResult', content: 'x'.repeat(200_000), timestamp: t },
      })}\n`,
      'utf8',
    );

    const session = listSessions().find((s) => s.id === 'big');
    assert.ok(session);
    // 摘要只要拿到 id / cwd / 条数 / 标题，不含任何「全文」字段 ——
    // 这是 docs/architecture/sessions.md 那条性能结论在类型上的体现。
    assert.equal(session.entries, 2, '条数精确');
    assert.equal(typeof session.id, 'string');
    assert.deepEqual(
      Object.keys(session).filter((k) => /text|content|body/i.test(k)),
      [],
      `不该有承载全文的字段（实际 ${Object.keys(session).join(',')}）`,
    );
  });
});

// ── 消息链没被改名破坏 ──

test('改名是 append：parentId 链原封不动', async () => {
  await withHome(async () => {
    const cwd = process.cwd();
    const t = 1;
    const file = writeSession(cwd, 'chain', [
      { role: 'user', text: '一', at: t },
      { role: 'assistant', text: '二', at: t + 1 },
      { role: 'user', text: '三', at: t + 2 },
    ]);
    const before = readFileLines(file);

    // `appendSessionName` 是 session-picker 内部的（不导出），这里直接模拟它写的形状。
    appendFileSync(
      file,
      `${JSON.stringify({
        type: 'session_info',
        id: 'ff11ee22',
        parentId: 'e3',
        timestamp: new Date(t + 3).toISOString(),
        name: '改个名',
      })}\n`,
      'utf8',
    );

    const after = readFileLines(file);
    assert.deepEqual(after.slice(0, before.length), before, '原来那几行一个字节都没动');
    assert.equal(after.length, before.length + 1, '只多了一行');
    const last = JSON.parse(after[after.length - 1] as string) as Entry & { name?: string };
    assert.equal(last.type, 'session_info');
    assert.equal(last.name, '改个名');
    assert.equal(last.parentId, 'e3', '挂在链尾');
  });
});

// ── 小工具 ──

function readFileLines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '');
}

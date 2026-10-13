/**
 * 内置工具的**默认开关**（`defaultTools`）。
 *
 * ## 这组测试守的是什么
 *
 * 八 个内置工具里只有四个默认开，另外四个（`powershell` / `grep` / `find` / `ls`）
 * 要靠 `settings.json` 的 `defaultTools` 才开。两处一旦对不上，症状都**不报错**：
 *
 * - prompt 说了 `grep` 而工具表里没有 → 模型一调就回「未知工具」，日志里干干净净；
 * - 工具表里有而 prompt 不说 → 模型不知道有它，白装。
 *
 * 所以这里测的是**两个清单永远一致**，以及开关规则与 pi 一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import {
  BUILTIN_TOOL_NAMES,
  getTool,
  getTools,
  resetTools,
  resolveToolSelection,
} from '../src/tools';
import { promptToolsFrom } from '../src/system-prompt';
import { piSettingsPath } from '../src/pi-config';
import { assertIsolatedHome } from '../../../test-support/isolated-home-guard';

/**
 * 写一份 settings.json 再取工具。
 *
 * 两个「必须」：
 * 1. 走 `resetTools()` —— 开关按 cwd 缓存（见 `tools.ts`），只写文件不重取
 *    的话拿到的是上一轮的缓存，测试会**假绿**。
 * 2. 用完**把原文件原样写回去** —— 配置家目录是整个测试进程共享的，残留会让后面的
 *    用例继承上一条的选择（「不给 defaultTools」那个用例靠「文件不存在」来表示默认，
 *    所以残留对它杀伤最大）。
 *
 * ## 为什么是**备份还原**而不是删掉（这里真出过事）
 *
 * 早先这里是 `finally { rm(file, { force: true }) }`。它的前提是「配置家目录一定是
 * 测试的临时目录」—— 那个前提靠 `PI_CODING_AGENT_DIR`，而它由 `test-support/isolated-home.ts`
 * 在**`pnpm test` 的脚本里**用 `--import` 装上。
 *
 * 于是**单独跑一个测试文件**就绕过了隔离：
 *   `npx tsx --test packages/core/test/tools.test.ts` ← 没带 isolated-home.ts
 * 而 `piSettingsPath()` 于是解析到真实家目录 `~/.pi/agent/settings.json`，
 * 那个 `rm` 把**用户真的配置文件**删掉了（provider / model / packages 全没了）。
 *
 * 删文件之所以危险还不只是「删掉」：它把用户那份**也**删了，而那与测试要造的
 * 「文件不存在」根本不是一回事。现在改成备份/还原，两种情况下都不碰用户那份。
 * `assertIsolatedHome` 再加一道闸：万一又有人单独跑，它会直接报错而不是默默删。
 */
async function withSettings<T>(settings: unknown, fn: () => T | Promise<T>): Promise<T> {
  const cwd = process.cwd();
  const file = piSettingsPath();
  assertIsolatedHome(file, 'packages/core/test/tools.test.ts');
  // 备份原文件（可能不存在 —— 那正是「不给 defaultTools」要表达的状态）。
  let backup: string | undefined;
  try {
    backup = await readFile(file, 'utf8');
  } catch {
    backup = undefined;
  }
  try {
    if (settings !== undefined) {
      await writeFile(file, JSON.stringify(settings), 'utf8');
    }
    resetTools(cwd);
    return await fn();
  } finally {
    // 还原：**删掉我们写的，恢复原来那份**。不写回会让下一个用例看到一个
    // 与进入时不同的配置家目录（比「多一个文件」更难查）。
    try {
      if (backup === undefined) await rm(file, { force: true });
      else await writeFile(file, backup, 'utf8');
    } finally {
      resetTools(cwd);
    }
  }
}

// ─── 开关规则（语义照抄 pi 的 resolveDefaultTools） ───

test('默认开四个：read / bash / edit / write', () => {
  // 不给 defaultTools = 用 pi 的 DEFAULT_TOOL_NAMES。
  assert.deepEqual(resolveToolSelection(undefined), ['read', 'bash', 'edit', 'write']);
  assert.deepEqual(resolveToolSelection([]), ['read', 'bash', 'edit', 'write']);
});

test('`+name` 在默认那份上追加，`-name` 删除', () => {
  assert.deepEqual(resolveToolSelection(['+grep']), ['read', 'bash', 'edit', 'write', 'grep']);
  assert.deepEqual(resolveToolSelection(['-bash']), ['read', 'edit', 'write']);
  assert.deepEqual(
    resolveToolSelection(['+powershell', '+grep', '+find', '+ls']),
    ['read', 'bash', 'edit', 'write', 'powershell', 'grep', 'find', 'ls'],
  );
  // 顺序按列表走：`+grep` 再 `-grep` = 什么都没发生（与 pi 的逐条应用同序）。
  assert.deepEqual(resolveToolSelection(['+grep', '-grep']), ['read', 'bash', 'edit', 'write']);
});

test('出现不带前缀的名字 = 整份替换默认清单', () => {
  // 这是 pi 的规则，也是最容易误解的一条：`["grep"]` 不是「默认 + grep」，
  // 而是「只有 grep」。
  assert.deepEqual(resolveToolSelection(['grep']), ['grep']);
  assert.deepEqual(resolveToolSelection(['ls', 'find']), ['ls', 'find']);
});

test('未知名字不报错也不剔除（与 pi 一致：写了但那工具不存在）', () => {
  assert.deepEqual(resolveToolSelection(['+nope']), ['read', 'bash', 'edit', 'write', 'nope']);
  // `-` 一个不在表里的名字：官方 `index === -1` 时不动，这里照抄。
  assert.deepEqual(resolveToolSelection(['-nope']), ['read', 'bash', 'edit', 'write']);
});

// ─── 真的接到注册表上 ───

test('默认只装四个：grep / find / ls / powershell 都不在表里', async () => {
  await withSettings(undefined, () => {
    const names = getTools(process.cwd()).map((t) => t.name);
    assert.deepEqual(names, ['read', 'write', 'edit', 'bash']);
    // 「不在表里」与「getTool 找得到」必须是同一件事：模型报未知工具就是这么来的。
    assert.equal(getTool('grep'), undefined);
    assert.equal(getTool('find'), undefined);
    assert.equal(getTool('ls'), undefined);
  });
});

test('`+grep` 之后 grep 能真被调起来', async () => {
  await withSettings({ defaultTools: ['+grep'] }, () => {
    assert.equal(getTool('grep') !== undefined, true, 'grep 应该能用');
    // 只加 grep，不该顺带把另外几个也带上。
    assert.equal(getTool('find'), undefined);
    assert.equal(getTool('ls'), undefined);
  });
});

test('四个只读工具全开时都在表里，且带中文 label', async () => {
  await withSettings(
    { defaultTools: ['read', 'bash', 'edit', 'write', '+powershell', '+grep', '+find', '+ls'] },
    () => {
      const tools = getTools(process.cwd());
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        [...BUILTIN_TOOL_NAMES].sort(),
        '八个内置工具应该齐了',
      );
      // label 是界面显示用的；为空会让工具块画不出标题。
      for (const tool of tools) {
        assert.ok(tool.label && tool.label.length > 0, `${tool.name} 缺 label`);
      }
    },
  );
});

test('关掉默认工具也认（`-read` 之后模型看不到 read）', async () => {
  await withSettings({ defaultTools: ['-read'] }, () => {
    assert.equal(getTool('read'), undefined, 'read 应该被关掉');
    assert.equal(getTool('bash') !== undefined, true, '其余默认工具还在');
  });
});

// ─── prompt 侧必须与工具表一致 ───

test('prompt 的工具清单与真能跑的表一致（否则模型一调就是「未知工具」）', async () => {
  await withSettings(
    { defaultTools: ['read', 'bash', 'edit', 'write', '+powershell', '+grep'] },
    () => {
      const fromPrompt = promptToolsFrom(process.cwd()).map((t) => t.name).sort();
      const fromRegistry = getTools(process.cwd()).map((t) => t.name).sort();
      assert.deepEqual(
        fromPrompt,
        fromRegistry,
        'prompt 侧与工具侧必须是同一份清单 —— 不一致时症状是静默的「未知工具」',
      );
      // 这一组具体开了 grep / powershell：确认 `+` 真的传到了 prompt 侧。
      assert.ok(fromPrompt.includes('grep'));
      assert.ok(fromPrompt.includes('powershell'));
      assert.ok(!fromPrompt.includes('find'), '没开 find，prompt 就不该说它存在');
    },
  );
});

test('默认配置下 prompt 只提那四个（不泄露默认关掉的工具）', async () => {
  await withSettings(undefined, () => {
    const names = promptToolsFrom(process.cwd()).map((t) => t.name);
    assert.deepEqual(names, ['read', 'write', 'edit', 'bash']);
  });
});
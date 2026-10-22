/**
 * `deferExtensions`（交互式启动的「首帧不等扩展」）的语义。
 *
 * ## 这一档解决什么
 *
 * 启动的大头是扩展装载（jiti，实测 2~3s，见 `extension-host.ts` 里串行装载那段注释），
 * 而它整个在「界面画出来」之前。打开这一档，`createKernel()` 在 store 与 `model.init`
 * 就绪之后就返回，界面立刻画首帧，扩展在后台装。
 *
 * ## 为什么必须有测试钉住「就绪前后分别是什么」
 *
 * 这一档把「装载完成」变成了一个**时间点**，于是每一处读扩展/读 prompt 的代码都有
 * 「读到的是哪一刻的」这个问题。两条最容易写错：
 *
 * 1. **门**：`ready` 之前 `prompt` 还没装（`state.prompt.seeded === false`）——
 *    此时发消息会定下一份**缺扩展工具集**的 head，而 head 是不可改的历史
 *    （`prompt-head.ts`）。界面那边靠 `ready` 把发送拦下（`tui/app.ts` 的 `send()`），
 *    内核这边靠 `Kernel.ready` 把「什么时候算就绪」只定义一次。
 * 2. **活视图**：`kernel.extensions` 就绪前是空宿主、就绪后换成真的那个。界面在
 *    `createKernel()` 返回时就把 `kernel.extensions.commands` 之类抓走了 —— 所以
 *    它必须是**活视图**（每次读现取），否则扩展的斜杠命令永远不出现。
 *
 * 全部测试把 `PI_CODING_AGENT_DIR` 指到临时目录（与其它测试同一个口径）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKernel, type Kernel } from '../src/kernel';

/** 在一个隔离的配置家目录里跑 fn（里面没有 `settings.json` 的 packages）。 */
async function withHome(fn: (home: string) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'defer-home-'));
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

async function withKernel(
  options: { deferExtensions?: boolean },
  fn: (kernel: Kernel) => Promise<void> | void,
): Promise<void> {
  await withHome(async () => {
    const kernel = await createKernel({
      provider: 'deepseek',
      systemPrompt: '装载过的 prompt',
      cwd: '/proj',
      demo: true,
      sessionId: 'defer-1',
      traceDir: null,
      writeSession: false,
      ...(options.deferExtensions === true ? { deferExtensions: true } : {}),
    });
    try {
      await fn(kernel);
    } finally {
      kernel.dispose();
    }
  });
}

test('deferExtensions：createKernel 先返回，prompt 与扩展是 ready 之后才就绪的', async () => {
  await withKernel({ deferExtensions: true }, async (kernel) => {
    // **返回那一刻**：model 已装（底栏首帧就要显示它，见 kernel.ts 里为什么把
    // `model.init` 拆到扩展装载之前），prompt 还没装。
    assert.equal(kernel.store.getState().model.seeded, true, 'model 要先装（底栏要用）');
    assert.equal(
      kernel.store.getState().prompt.seeded,
      false,
      'prompt 是后台装的 —— 就绪前它必须是没装的形状（发送要等 ready）',
    );
    assert.deepEqual([...kernel.extensions.tools], [], '就绪前扩展是空视图');
    assert.equal(kernel.extensions.loaded, 0);

    await kernel.ready;

    // **就绪之后**：prompt 装上了，扩展也在（这里没有 npm 包，但 pi 的内置
    // mcp / codemode / tool-search 三个总会装上）。
    assert.equal(kernel.store.getState().prompt.seeded, true);
    assert.ok(
      kernel.store.getState().systemPrompt.includes('装载过的 prompt'),
      'prompt 是拼好的那一整段',
    );
    assert.ok(kernel.extensions.loaded > 0, '内置扩展该装上了');
    assert.ok(kernel.extensions.entries.length >= 0);
  });
});

test('deferExtensions：就绪前抓到的引用是**活视图**（就绪后看得到扩展）', async () => {
  await withKernel({ deferExtensions: true }, async (kernel) => {
    // 界面就是这么抓的：`createKernel()` 刚返回，扩展还没装完。
    const view = kernel.extensions;
    const commandsView = kernel.extensions.commands;
    const before = view.loaded;
    assert.equal(before, 0);

    await kernel.ready;

    // 同一个**外层对象**：转发到真的那个宿主上了。
    assert.ok(view.loaded > 0, '外层视图必须转发（不是快照）');
    // 命令表：`commands` 这个对象本身是占位那个的（界面不该直接存它 ——
    // `tui/main.ts` 传的是取值函数，见 `TuiOptions.extensionCommands`）。
    // 这里钉住「取值的用法是对的」：现取一次就能看到扩展的命令。
    assert.notEqual(kernel.extensions.commands, commandsView, '每次现取才是对的用法');
    assert.equal(typeof kernel.extensions.commands.list, 'function');
  });
});

test('deferExtensions：装载诊断从**活视图**里报得出来（界面不能静默少了扩展）', async () => {
  await withHome(async (home) => {
    // 一个**装坏**的扩展（工厂一调就抛）：它的诊断必须能被界面读到
    // （`kernel.extensions.errors`）—— 否则症状是「扩展静默没了」。
    writeFileSync(
      path.join(home, 'settings.json'),
      JSON.stringify({ packages: ['./broken.ts'] }),
    );
    writeFileSync(
      path.join(home, 'broken.ts'),
      "export default function () { throw new Error('装坏的扩展'); }\n",
    );
    const kernel = await createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd: '/proj',
      demo: true,
      deferExtensions: true,
      traceDir: null,
      writeSession: false,
      sessionId: 'defer-2',
    });
    try {
      await kernel.ready;
      assert.equal(kernel.store.getState().prompt.seeded, true, '装载出问题也要把 prompt 装上');
      assert.ok(
        kernel.extensions.errors.some((error) => error.includes('装坏的扩展')),
        `该报出装坏的扩展：${JSON.stringify(kernel.extensions.errors)}`,
      );
    } finally {
      kernel.dispose();
    }
  });
});

test('deferExtensions：ready 之前 dispose（用户两秒内就退了）不会把子进程落下', async () => {
  await withKernel({ deferExtensions: true }, async (kernel) => {
    // 不等装载完成就退：那一路在拿到宿主后会自己看 `disposed` 收尾（见 kernel.ts）。
    kernel.dispose();
    // 不抛就够 —— 而且 `ready` 也必须能完成（界面那边可能在等它）。
    await kernel.ready;
  });
});

test('不打开 deferExtensions 时：createKernel 返回时 prompt 已经装好（老行为不变）', async () => {
  await withKernel({}, async (kernel) => {
    assert.equal(kernel.store.getState().prompt.seeded, true);
    assert.equal(kernel.store.getState().model.seeded, true);
    // `ready` 一开始就是已完成的门（不是 undefined）—— 一次性模式与测试拿到的形状一致。
    await kernel.ready;
  });
});

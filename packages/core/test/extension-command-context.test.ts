/**
 * 扩展命令拿到的 `ctx` 必须是**真的** `ExtensionCommandContext`。
 *
 * 回归：以前 `makeCtx()` 手搭了一个只含 `ui` / `hasUI` / `isIdle` / `cwd` / `model`
 * 的对象，`pi-background-tasks` 的 `/bg` 一敲就是
 * `Cannot read properties of undefined (reading 'getSessionId')` —— 而它把错误 catch
 * 成一条界面提示，看着像「扩展坏了」，实际是宿主给了个缺字段的 ctx。
 *
 * 钉三件事：
 * 1. `sessionManager` / `cwd` / `thinkingLevel` / `modelRegistry` / `getSystemPrompt` 是真的；
 * 2. `waitForIdle()` 真的等（`pi.sendMessage()` 之后环跑完才 resolve）；
 * 3. 五个**改会话**的操作仍然是 undefined（本项目的会话层不归扩展调）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKernel } from '../src/kernel';
import { waitForIdle } from '../src/store';

const SESSION_OPS = ['newSession', 'fork', 'navigateTree', 'switchSession', 'reload'] as const;

const PROBE_SOURCE = `
export default function (pi) {
  pi.registerCommand('ctx-probe', {
    description: '检查命令 ctx 的成员',
    handler: async (_args, ctx) => {
      const g = globalThis;
      const probe = {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        branchIsArray: Array.isArray(ctx.sessionManager.getBranch()),
        cwd: ctx.cwd,
        hasUI: ctx.hasUI,
        thinkingLevel: ctx.thinkingLevel,
        // demo / 降级装配本来就没有主路径 ModelRuntime（见 extension-models.ts），
        // 所以这里验「成员在不在」而不是「值是不是对象」。
        hasModelRegistry: 'modelRegistry' in ctx,
        hasSystemPrompt:
          typeof ctx.getSystemPrompt === 'function' && ctx.getSystemPrompt().length > 0,
        waitForIdle: typeof ctx.waitForIdle,
        sessionOpsPresent: ${JSON.stringify([...SESSION_OPS])}.filter((key) => ctx[key] !== undefined),
        idleAtEntry: ctx.isIdle(),
        idleAfterWait: undefined,
      };
      g.__ctxProbe = probe;
      // 先让环跑起来，再等它 —— 这才是 waitForIdle 的真实用法。
      pi.sendMessage(
        { customType: 'ctx-probe', content: '让这一轮跑起来', display: true },
        { deliverAs: 'followUp' },
      );
      await ctx.waitForIdle();
      probe.idleAfterWait = ctx.isIdle();
    },
  });
}
`;

type Probe = {
  sessionId: string;
  sessionFile: string | undefined;
  branchIsArray: boolean;
  cwd: string;
  hasUI: boolean;
  thinkingLevel: string;
  hasModelRegistry: boolean;
  hasSystemPrompt: boolean;
  waitForIdle: string;
  sessionOpsPresent: string[];
  idleAtEntry: boolean;
  idleAfterWait: boolean | undefined;
};

async function withKernel(
  run: (kernel: Awaited<ReturnType<typeof createKernel>>, paths: { cwd: string }) => Promise<void>,
): Promise<void> {
  const agentDir = mkdtempSync(path.join(tmpdir(), 'cmdctx-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'cmdctx-cwd-'));
  mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
  writeFileSync(path.join(agentDir, 'extensions', 'probe.ts'), PROBE_SOURCE);
  const saved = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  delete (globalThis as { __ctxProbe?: Probe }).__ctxProbe;
  try {
    const kernel = await createKernel({ provider: 'faux', demo: true, cwd, traceDir: null });
    try {
      await run(kernel, { cwd });
    } finally {
      await kernel.dispose();
    }
  } finally {
    if (saved !== undefined) process.env['PI_CODING_AGENT_DIR'] = saved;
    else delete process.env['PI_CODING_AGENT_DIR'];
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('命令 ctx：真的 sessionManager / cwd / thinkingLevel / modelRegistry / systemPrompt', async () => {
  await withKernel(async (kernel, { cwd }) => {
    await kernel.extensions.commands.run('ctx-probe', '');
    const probe = (globalThis as { __ctxProbe?: Probe }).__ctxProbe;
    assert.ok(probe, '命令该跑过');

    assert.equal(probe.sessionId, kernel.store.getState().trace.sessionId, 'getSessionId 报的是当前会话');
    assert.equal(
      probe.sessionFile,
      kernel.session?.file,
      'getSessionFile 报的是当前会话的计划路径（/bg 靠它定 runtime 目录）',
    );
    assert.equal(probe.branchIsArray, true, 'getBranch 要能调（空会话就是 []）');
    assert.equal(probe.cwd, cwd, 'ctx.cwd 是内核的 cwd，不是 process.cwd()');
    assert.equal(typeof probe.thinkingLevel, 'string');
    assert.equal(probe.hasModelRegistry, true, 'modelRegistry 这个成员要在（值可能是 undefined 的降级装配）');
    assert.equal(probe.hasSystemPrompt, true, 'getSystemPrompt 要在');
    assert.equal(probe.hasUI, false, '没给 uiOptions = 没有界面（与 pi 的 print 模式同形）');
  });
});

test('命令 ctx：waitForIdle 真的等（sendMessage 之后环跑完才 resolve）', async () => {
  await withKernel(async (kernel) => {
    await kernel.extensions.commands.run('ctx-probe', '');
    const probe = (globalThis as { __ctxProbe?: Probe }).__ctxProbe;
    assert.ok(probe);
    assert.equal(probe.waitForIdle, 'function');
    assert.equal(probe.idleAtEntry, true, '命令进来时是 idle（run() 自己先拦了非 idle）');
    assert.equal(probe.idleAfterWait, true, 'waitForIdle 返回时环真的停了');
    // 让环形真的跑完（命令返回那一刻 state 已经是 idle，但保险起见）。
    await waitForIdle(kernel.store, 20_000);
    assert.ok(
      kernel.store.getState().messages.some((message) => message.role === 'assistant'),
      'sendMessage 真的开了新回合',
    );
  });
});

test('命令 ctx：改会话的五个操作仍然不给（undefined，而不是假装取消）', async () => {
  await withKernel(async (kernel) => {
    await kernel.extensions.commands.run('ctx-probe', '');
    const probe = (globalThis as { __ctxProbe?: Probe }).__ctxProbe;
    assert.ok(probe);
    assert.deepEqual(
      probe.sessionOpsPresent,
      [],
      'newSession / fork / navigateTree / switchSession / reload 不该出现在命令 ctx 上',
    );
  });
});

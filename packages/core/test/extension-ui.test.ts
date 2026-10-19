import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostUi, type DialogHost, type HostUiOptions, type TuiDialogs } from '../src/extension-ui';

/**
 * `ctx.ui.select/confirm/input` 的**双端分发**。
 *
 * 这两端（终端 / 浏览器）各自可能先给出答案，谁先答谁算数、另一端立刻撤掉 —— 这条
 * 不是纯形状，是行为：写错了的症状是「一个弹窗没人关，输入区被占着」或者
 * 「答案回来了但 Promise 永远不 resolve」。
 */

/** 造一份最小的宿主：终端与浏览器两侧都用假的，记下谁被挂/被拆。 */
function makeUi(options: { tui?: boolean; browser?: boolean } = {}) {
  const log: string[] = [];
  let tuiDone: ((value: string | undefined) => void) | undefined;
  let browserSettle: ((value: string | undefined) => void) | undefined;
  let browserSignal: AbortSignal | undefined;
  const tuiDialogs: TuiDialogs = {
    select: (_title, _choices, done) => {
      log.push('tui:select');
      tuiDone = done;
      return () => log.push('tui:teardown');
    },
    confirm: (_title, _message, _done) => {
      log.push('tui:confirm');
      return () => log.push('tui:teardown');
    },
    input: (_title, _placeholder, done) => {
      log.push('tui:input');
      tuiDone = done;
      return () => log.push('tui:teardown');
    },
  };
  const dialogs: DialogHost = {
    available: () => options.browser === true,
    select: (_title, _choices, signal) => {
      log.push('browser:select');
      browserSignal = signal;
      return new Promise<string | undefined>((resolve) => {
        browserSettle = resolve;
      });
    },
    confirm: () => {
      log.push('browser:confirm');
      return Promise.resolve(true);
    },
    input: () => Promise.resolve(undefined),
  };
  const source: HostUiOptions = {
    tui: {} as never,
    theme: {} as never,
    addInputListener: () => () => {},
    onNotice: () => {},
    ...(options.tui === false ? {} : { tuiDialogs }),
    dialogs: () => (options.browser === true ? dialogs : undefined),
  };
  return {
    ui: createHostUi(() => source),
    log,
    answerTui: (value: string | undefined) => tuiDone?.(value),
    answerBrowser: (value: string | undefined) => browserSettle?.(value),
    browserSignal: () => browserSignal,
  };
}

test('select：终端先答 —— 浏览器那一份被 abort', async () => {
  const ctx = makeUi({ tui: true, browser: true });
  const pending = ctx.ui.select('选一个', ['a', 'b']);
  assert.deepEqual(ctx.log, ['tui:select', 'browser:select']);
  ctx.answerTui('a');
  assert.equal(await pending, 'a');
  assert.equal(ctx.browserSignal()?.aborted, true, '浏览器那一份要收到取消信号');
  assert.ok(ctx.log.includes('tui:teardown'));
});

test('select：浏览器先答 —— 终端那一份被拆掉', async () => {
  const ctx = makeUi({ tui: true, browser: true });
  const pending = ctx.ui.select('选一个', ['a', 'b']);
  ctx.answerBrowser('b');
  assert.equal(await pending, 'b');
  assert.ok(ctx.log.includes('tui:teardown'), `终端组件要被卸下：${ctx.log.join(',')}`);
});

test('select：只有终端一侧时不给浏览器发（available 为 false）', async () => {
  const ctx = makeUi({ tui: true, browser: false });
  const pending = ctx.ui.select('选一个', ['a']);
  assert.deepEqual(ctx.log, ['tui:select']);
  ctx.answerTui(undefined);
  assert.equal(await pending, undefined);
});

test('select：两端都没有 → reject（不静默给假值）', async () => {
  const ctx = makeUi({ tui: false, browser: false });
  await assert.rejects(ctx.ui.select('选一个', ['a']), /没有可用的对话框/);
});

test('confirm：浏览器那一份回 `true` → 结果是 `true`（终端那份一起被拆）', async () => {
  const ctx = makeUi({ tui: true, browser: true });
  const pending = ctx.ui.confirm('继续？', '这会删掉文件');
  assert.equal(await pending, true);
  assert.ok(ctx.log.includes('tui:teardown'), `终端组件要被卸下：${ctx.log.join(',')}`);
});

// ─── 底栏状态段（`ctx.ui.setStatus`）───

/**
 * 这一组盯的是一个**真发生过的报错**：
 *
 *     [background-tasks] UI update failed: ctx.ui.setStatus is not a function
 *
 * `pi-background-tasks` 在 `updateUi()` 里无条件是 `ctx.ui.setStatus(...)`，而我们的
 * `ctx.ui` 当时没有这个成员 —— 于是它在自己的 catch 里打一行日志、顺手把 `currentCtx`
 * 清成 `undefined`，之后**所有**后台任务事件都不再更新界面（任务还在跑，底栏再也不说）。
 */
test('setStatus：转发给宿主，并把文本压成单行', () => {
  const calls: (string | undefined)[][] = [];
  const ui = createHostUi(() => ({
    tui: {} as never,
    theme: {} as never,
    addInputListener: () => () => {},
    onNotice: () => {},
    setStatus: (key, text) => calls.push([key, text]),
  }));
  ui.setStatus('background-tasks', ' bg 2 running \n (试试 tab)  ');
  // 与 pi 的 `sanitizeStatusText()` 逐字同口径：换行变空格、连续空格压掉、两头 trim
  // （那是底栏的单行契约 —— 带 `\n` 的状态会把固定行数的底栏撑歪）。
  assert.deepEqual(calls, [['background-tasks', 'bg 2 running (试试 tab)']]);
});

test('setStatus：`undefined` 与空串都是「清掉那一格」', () => {
  const calls: (string | undefined)[][] = [];
  const ui = createHostUi(() => ({
    tui: {} as never,
    theme: {} as never,
    addInputListener: () => () => {},
    onNotice: () => {},
    setStatus: (key, text) => calls.push([key, text]),
  }));
  ui.setStatus('background-tasks', undefined);
  ui.setStatus('background-tasks', '   ');
  // 两种写法都得落成 `undefined` —— 界面的 Map 只认「有」与「没有」两态，
  // 留一个空串就是多一种反例（底栏于是可能多出一格空白）。
  assert.deepEqual(calls, [
    ['background-tasks', undefined],
    ['background-tasks', undefined],
  ]);
});

test('setStatus：宿主没有底栏时不抛（探针 / 一次性模式）', () => {
  // 关键：**不抛也不 reject**。状态段只是显示，而扩展在这里通常没有 try ——
  // 抛出去会把整轮对话带崩（`pi-subagents` 的 /agents 面板就在命令 handler 里调它）。
  const ui = createHostUi(() => ({
    tui: {} as never,
    theme: {} as never,
    addInputListener: () => () => {},
    onNotice: () => {},
  }));
  assert.doesNotThrow(() => ui.setStatus('background-tasks', ' bg 1 running '));
});

test('getToolsExpanded / setToolsExpanded：转发给宿主', () => {
  let expanded = false;
  const ui = createHostUi(() => ({
    tui: {} as never,
    theme: {} as never,
    addInputListener: () => () => {},
    onNotice: () => {},
    getToolsExpanded: () => expanded,
    setToolsExpanded: (value) => {
      expanded = value;
    },
  }));
  assert.equal(ui.getToolsExpanded(), false);
  ui.setToolsExpanded(true);
  assert.equal(ui.getToolsExpanded(), true, '读回来的必须是刚设的那个值（同一个展开开关）');
});

test('getToolsExpanded / setToolsExpanded：宿主没有时默认 false 且不抛', () => {
  // `pi-subagents` 的 subagent 工具在 `hasUI` 时**无条件**调 `setToolsExpanded(false)`
  // （`executeSubagentCollapsed()`），所以这里抛一次就是「一跑 subagent 就挂」。
  const ui = createHostUi(() => ({
    tui: {} as never,
    theme: {} as never,
    addInputListener: () => () => {},
    onNotice: () => {},
  }));
  assert.equal(ui.getToolsExpanded(), false);
  assert.doesNotThrow(() => ui.setToolsExpanded(true));
});

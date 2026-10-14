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

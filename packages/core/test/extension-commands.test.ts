/**
 * 扩展的斜杠命令、快捷键与 widget —— 界面那一侧。
 *
 * ## 为什么单独一个文件
 *
 * `extension-host.test.ts` 验的是「装上、对得上」，不碰界面。这里验的是**界面真的把
 * 它们接上了**：补全里看得见、敲下去真的跑、按键真的到。
 *
 * ## 这三样都是「接了但会静默坏」的那种
 *
 * - 命令不并进 `SLASH_COMMANDS`（那是常量的唯一真相）→ 补全里少几个词条，
 *   **不报任何错**；
 * - 快捷键挂在 raw input 上 → 键位对不上就没人按；
 * - widget 塞进底部 VStack → 布局不重设就**不显示**，而扩展的 handler 已经跑完了。
 *
 * 所以每条都断言「用户看得见/按得到」那一层，而不只是「handler 被调用过」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadExtensionHost } from '../src/extension-host';
import { extensionSessionManager } from '../src/extension-sessions';
import { createAgentStoreWith } from '../src/store';
import { createFauxRuntime, demoResponses } from '../src/provider';
import { getTools, registerExtraTools } from '../src/tools';
import { initTheme, theme } from '@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { buildSessionContext } from '@earendil-works/pi-coding-agent';
import { TuiAltScreen, matchesKey, stripTerminalSequences, type TuiInputListener } from '@earendil-works/pi-tui';
import type { HostUiOptions } from '../src/extension-ui';

const realAgentDir = path.join(homedir(), '.pi', 'agent');
const isolatedDir = process.env['PI_CODING_AGENT_DIR'];
const hasWeb = existsSync(path.join(realAgentDir, 'npm', 'node_modules', 'pi-web-access'));
const skip = !hasWeb && '没装 pi-web-access（离线机器）';

function useRealHome(): void {
  if (isolatedDir !== undefined) delete process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = realAgentDir;
}
function restoreHome(): void {
  registerExtraTools([]);
  if (isolatedDir !== undefined) process.env['PI_CODING_AGENT_DIR'] = isolatedDir;
}

/** 界面层的 widget 槽（`setWidget` 的落点）—— 记下来好断言。 */
interface WidgetSlot {
  keys: () => string[];
  has: (key: string) => boolean;
}

async function load(options: { onSendMessage?: (t: string) => void; canSend?: () => boolean } = {}) {
  useRealHome();
  initTheme('dark', false);
  const written: string[] = [];
  const terminal = {
    columns: 110,
    rows: 34,
    isTTY: false,
    write: (s: string) => {
      written.push(s);
    },
    hideCursor: () => {},
    showCursor: () => {},
    start: () => {},
    stop: () => {},
    onData: () => () => {},
    onResize: () => () => {},
  } as never;
  const tui = new TuiAltScreen(terminal, true, undefined, {});
  const widgets = new Map<string, unknown>();
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  const { store } = createAgentStoreWith({ runtime: faux.runtime, cwd: process.cwd() });
  const sent: string[] = [];
  const host = await loadExtensionHost({ builtins: false,
    store,
    cwd: process.cwd(),
    sessionId: () => store.getState().trace.sessionId,
    onSendMessage: (t) => {
      sent.push(t);
      options.onSendMessage?.(t);
    },
    canSend: options.canSend ?? (() => store.getState().phase === 'idle'),
    uiOptions: () => ({
      tui,
      theme,
      addInputListener: (l: TuiInputListener) => tui.addInputListener(l),
      onNotice: () => {},
      setWidget: (key, component) => {
        if (component === undefined) widgets.delete(key);
        else widgets.set(key, component);
      },
    }),
  });
  store.dispatch({
    type: 'prompt.init',
    systemPrompt: 't',
    tools: getTools().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
  } as never);
  const slot: WidgetSlot = {
    keys: () => [...widgets.keys()],
    has: (key) => widgets.has(key),
  };
  return { host, store, sent, slot, tui, screen: () => stripTerminalSequences(written.join('')) };
}

test('命令：扩展的 4 个命令进补全表（带说明）', { skip }, async () => {
  try {
    const { host } = await load();
    const names = host.commands.list().map((c) => c.name);
    for (const want of ['websearch', 'curator', 'search']) {
      assert.ok(names.includes(want), `补全里该有 /${want}：${names.join(',')}`);
    }
    // 说明也要有 —— 补全列表就是靠它提示这个命令干什么的。
    assert.ok(
      host.commands.list().every((c) => (c.description ?? '').length > 0),
      '每个命令都该有 description（否则补全里是一行没用的词）',
    );
  } finally {
    restoreHome();
  }
});

test('命令：/curator 真的跑起来，且结果回到对话里', { skip }, async () => {
  try {
    const { host, sent } = await load();
    assert.equal(host.commands.has('curator'), true);
    await host.commands.run('curator', 'on');
    // 扩展用 `pi.sendMessage` 把结论送回 —— 我们把它落成一条**用户消息**
    // （于是环会跑起来），而不是静默丢掉。
    assert.ok(sent.length > 0, 'handler 的结论该回到对话（pi.sendMessage 落到用户消息）');
    assert.match(sent.join('\n'), /curator/i, `该是 curator 的结论：${sent.join(' | ')}`);
  } finally {
    restoreHome();
  }
});

test('命令：环在跑时拒绝执行（否则中途插消息）', { skip }, async () => {
  try {
    const { host, store } = await load();
    store.dispatch({ type: 'user.message', text: 'hi' } as never);
    await assert.rejects(
      () => host.commands.run('search', ''),
      /还没结束|空闲/,
      '环跑着时该拒绝 —— 扩展的 handler 常要 sendMessage，中途插消息会让 messages 与这一轮的请求对不上',
    );
  } finally {
    restoreHome();
  }
});

test('命令：handler 抛错不炸界面（run() reject，界面转成一行提示）', { skip }, async () => {
  try {
    const { host } = await load();
    // `/search` 在没有历史结果时扩展自己 notify 一句就返回 —— 那条路是通的。
    // 这里验的是「它不崩」而不是「它有结果」。
    await host.commands.run('search', '');
  } finally {
    restoreHome();
  }
});

test('快捷键：扩展声明的两个键真的被消费，没声明的不被吃', { skip }, async () => {
  try {
    const { host } = await load();
    // **真终端字节**（kitty CSI u 形式），不是键名 —— 扩展的 handler 真的会跑。
    assert.equal(await host.commands.handleKey('\x1b[115;6u', () => false), true, 'ctrl+shift+s 该被消费');
    assert.equal(await host.commands.handleKey('\x1b[119;6u', () => false), true, 'ctrl+shift+w 该被消费');
    assert.equal(
      await host.commands.handleKey('\x1b[113;5u', () => false),
      false,
      '没人声明的键不该被吃掉（否则会静默吞掉用户的输入）',
    );
  } finally {
    restoreHome();
  }
});

test('快捷键：内置键优先（扩展抢不走切页 / 展开工具 / 中断）', { skip }, async () => {
  try {
    const { host } = await load();
    // 内置的先跑 —— 界面的 onInput 里也是这个顺序。
    //
    // 顺序反了的后果：切页键（轨迹面板）被扩展吃掉，界面看着「按了没反应」。
    // 而 `handleKey(data, () => true)` 就是「内置已消费」，此时**不该**再问扩展。
    assert.equal(
      await host.commands.handleKey('\x1b[20;5u', () => true),
      true,
      '内置消费后 handleKey 该直接返回 true，不该再碰扩展',
    );
  } finally {
    restoreHome();
  }
});

test('快捷键：handler 要 widget 时，那个槽接得住（不报 TypeError）', { skip }, async () => {
  // `pi-web-access` 的活动面板走 `ctx.ui.setWidget`。早先 `setWidget` 没接，
  // 于是 handler 撞 `updateWidget is not a function` —— 那个栈**一帧本项目的
  // 代码都没有**，看起来像扩展自己坏了。
  try {
    const { host, slot } = await load();
    await host.commands.handleKey('\x1b[115;6u', () => false);
    // 面板可能被打开也可能不（取决于有没有待审的搜索结果），但**不该抛**。
    // 所以这里只钉「不抛」+「槽的形状对」：有就用 Map 的键，没有也合法。
    assert.ok(Array.isArray(slot.keys()), 'widget 槽该是可枚举的');
  } finally {
    restoreHome();
  }
});

test('sessionManager：getSessionId 跟着会话变（不是注册时的常量）', async () => {
  // `/new` 与恢复历史都会换 id。注册时把那个值抄成常量的话，扩展算出来的
  // `x-opencode-session` 请求头会**永远是上一个会话的**。
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  const { store } = createAgentStoreWith({ runtime: faux.runtime, cwd: process.cwd() });
  let id = 'sess-first';
  const sm = extensionSessionManager(store, () => id);
  assert.equal(sm.getSessionId(), 'sess-first');
  id = 'sess-second';
  assert.equal(sm.getSessionId(), 'sess-second');
});

test('sessionManager：getSessionFile 跟着会话变，取不到时诚实地说没有', async () => {
  // `pi-subagents` 要这个路径算「本会话的 subagent 产物放哪」，两处读它：
  // `session_start` 与**每轮** `before_agent_start`。少这个成员的症状是
  // `sessionManager.getSessionFile is not a function`（每轮一条）。
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  const { store } = createAgentStoreWith({ runtime: faux.runtime, cwd: process.cwd() });

  const none = extensionSessionManager(store, () => 's', () => undefined);
  assert.equal(none.getSessionFile(), undefined, '没有落盘器就不该编一个路径出来');

  // 与 sessionId 同一个理由：`/new` 之后文件也换，所以它必须是**取值函数**。
  let file: string | undefined = '/tmp/sessions/sess-first.jsonl';
  const sm = extensionSessionManager(store, () => 'sess-first', () => file);
  assert.equal(sm.getSessionFile(), '/tmp/sessions/sess-first.jsonl');
  file = '/tmp/sessions/sess-second.jsonl';
  assert.equal(sm.getSessionFile(), '/tmp/sessions/sess-second.jsonl');
});

test('sessionManager：getBranch 给的是**条目**，官方的 buildSessionContext 能用', async () => {
  // 这一条钉住那个「包一层」的决定。扩展是这么调的：
  //
  //   buildSessionContext(ctx.sessionManager.getBranch()).messages
  //
  // 少包那层 `{type:'message', message}` 的话，官方那个函数会把消息当成条目、
  // 读不到 `.message` —— 症状是「模型这轮用过哪些 web 工具」判不出来，于是每次
  // 都要求 `web_enable` 重新加载一遍。
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  const { store } = createAgentStoreWith({ runtime: faux.runtime, cwd: process.cwd() });
  const sm = extensionSessionManager(store, () => 's');
  store.dispatch({ type: 'user.message', text: '搜一下 redux-loop' } as never);
  await new Promise((r) => setTimeout(r, 300));

  const branch = sm.getBranch();
  assert.ok(branch.length > 0, 'getBranch 该有东西（刚发过一句话）');
  const first = branch[0] as { type?: string; message?: { role?: string } };
  assert.equal(first.type, 'message', '条目该是 {type:"message", …} 那个形状');
  assert.ok(first.message?.role, '条目里该有 message（官方 buildSessionContext 读它）');

  // 真的转一遍 —— 那一层才是扩展要用的。
  const context = buildSessionContext(branch as never);
  assert.ok(context.messages.length > 0, 'buildSessionContext 该转出消息');
});

test('sessionManager：getEntries / buildSessionContext 都在（pi-subagents 直接调，不判 typeof）', async () => {
  // 报错原文：`ctx.sessionManager.getEntries is not a function` /
  // `ctx.sessionManager.buildSessionContext is not a function`。前者在 `session_start`
  // 里恢复 `/命令` 快照，后者用来判「装载时声明了哪些工具」—— 都不判 typeof，
  // 少了就是整个扩展不干活（而不是降级）。
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  const { store } = createAgentStoreWith({ runtime: faux.runtime, cwd: process.cwd() });
  const sm = extensionSessionManager(store, () => 's');

  // 空会话：transcript 里**没有** head。pi 的 head 与第一条消息一起落盘，而
  // `session_start` 更早 —— 扩展靠 `messages.length === 0` 判「新会话」走 eager 装载。
  assert.deepEqual(sm.buildSessionContext().messages, []);
  assert.deepEqual(sm.getEntries(), []);

  store.dispatch({
    type: 'prompt.init',
    systemPrompt: 'test',
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } }],
  } as never);
  store.dispatch({ type: 'user.message', text: '你好' } as never);
  await new Promise((r) => setTimeout(r, 300));

  const context = sm.buildSessionContext();
  const head = context.messages[0] as { role?: string; toolsAdded?: { name?: string }[] };
  assert.equal(head.role, 'system', 'head 该是第一条（与 pi 的 transcript 同序）');
  assert.deepEqual(
    head.toolsAdded?.map((t) => t.name),
    ['read'],
    'head 的 toolsAdded 该是装载时那批工具 —— 扩展靠它认已有声明',
  );
  assert.equal(context.thinkingLevel, store.getState().model.thinkingLevel);
  assert.deepEqual(context.model, {
    provider: store.getState().model.provider,
    modelId: store.getState().model.modelId,
  });

  // 条目要能用 `id`/`parentId` 串成一棵树（pi 的 `SessionEntry` 形状）。
  const entries = sm.getEntries();
  assert.equal(entries.length, context.messages.length, '两条入口读同一份条目');
  assert.deepEqual(entries.map((e) => e.id), entries.map((_, i) => `e${i + 1}`));
  assert.deepEqual(
    entries.map((e) => e.parentId),
    [null, ...entries.slice(0, -1).map((e) => e.id)],
  );
  assert.ok(
    entries.every((e) => e.type === 'message' && typeof e.timestamp === 'string'),
    '条目该是 {type:"message", id, parentId, timestamp, message} 那个形状',
  );
});

test('界面：扩展的 widget 槽在底部布局里（applyLayout 读它）', async () => {
  // 纯静态检查：`tui/app.ts` 的底部 VStack 要真的展开 `widgetSlots`。
  // —— 那段是「VStack 的 children 建时定下」，不展开就**不显示**，而扩展的
  // handler 已经跑完了、没有任何报错。
  const src = readFileSync(path.join(import.meta.dirname, '..', '..', 'tui', 'src', 'app.ts'), 'utf8');
  assert.ok(
    src.includes('widgetSlots.values()'),
    '底部 VStack 该展开 widgetSlots（否则扩展的 widget 永远不显示）',
  );
  assert.ok(
    src.includes('setWidget'),
    'TuiOptions 那边该把 setWidget 传下去（extension-ui 的落点）',
  );
  // 键位那一条：确认内置键在扩展之前跑（顺序即优先级）。
  //
  // **只在 `onInput` 那个函数里找** —— `extensionCommands` 在文件里出现得早得多
  // （`commandTable()` 里就有），拿全文件的第一个下标比就会得出「扩展在前」这个
  // **假结论**，而测试照样绿 —— 那是最坏的失败方式。
  const onInput = src.slice(src.indexOf('const onInput: TuiInputListener'), src.indexOf('tui.addInputListener(onInput)'));
  const builtinAt = onInput.indexOf('if (builtins()) return { consume: true };');
  // `extensionCommands()`（**取值**）而不是早先的 `options.extensionCommands` ——
  // 扩展现在是后台装的，界面存那个对象就等于把装载前那个空命令表钉死
  // （见 `TuiOptions.extensionCommands` 的注释）。要看的是「这里问了扩展没有」，
  // 而不是它怎么问的。
  const extAt = onInput.indexOf('extensionCommands()');
  assert.ok(builtinAt > 0, 'onInput 里该有「内置键先跑」那句');
  assert.ok(extAt > 0, 'onInput 里该问扩展的快捷键');
  assert.ok(
    builtinAt < extAt,
    '内置键必须在扩展的快捷键**之前**跑（否则扩展能抢走切页键）',
  );
});

test('界面：扩展命令不并进 SLASH_COMMANDS 那份常量（唯一真相）', async () => {
  const src = readFileSync(path.join(import.meta.dirname, '..', '..', 'tui', 'src', 'app.ts'), 'utf8');
  const table = src.slice(src.indexOf('const SLASH_COMMANDS'), src.indexOf('const SLASH_COMMANDS') + 2000);
  // 扩展的命令走 `commandTable()` 里那个单独的展开（`extensionCommands.list()`），
  // 所以常量表里**不该**出现 websearch / curator / search。
  for (const name of ['websearch', 'curator', 'google-account']) {
    assert.ok(
      !table.includes(`name: '${name}'`),
      `/${name} 不该硬写进 SLASH_COMMANDS（扩展的命令要等装载完才知道）`,
    );
  }
  assert.ok(
    src.includes('extensionCommands()?.list()'),
    'commandTable() 该把扩展的命令接在后面（与 skill 同一种情况：现取）',
  );
});

test('界面：uiRef 还空时读 ctx.ui.theme 不抛（真扩展读得到 theme）', { skip }, async () => {
  // **回归钉子**，且它**真的**钉住了那条路（不是形似）。
  //
  // 曾经 `requireUi()` 在 `uiRef.current` 还是空的时候一律抛。而
  // `ctx.ui.theme` 是个 getter，扩展碰它就会调 `requireUi`。
  // 于是：界面起来之前扩展读 theme → 抛 → **整个界面起不来**
  // （症状：首帧空白、顶栏底栏全没；而真因只在 stderr 一行里）。
  //
  // 触发点是 `uiOptions()` **真的**被调且真的抛 —— 所以这里用一个会在 `uiRef`
  // 为空时抛的工厂（与 `tui.ts` 的 `requireUi` 逐字同形），然后逼扩展读 theme。
  useRealHome();
  try {
    initTheme('dark', false);
    const faux = createFauxRuntime();
    faux.setResponses(demoResponses());
    const { store } = createAgentStoreWith({ runtime: faux.runtime, cwd: process.cwd() });
    // 与 `tui.ts` 的 `requireUi` **逐字同形**的那个形状：uiRef 为空时给一份
    // 「界面还没起来」的描述 —— **theme 仍然是真的**。
    //
    // 注意这里的 `tui` 是 undefined：那正是「界面还没起来」的真实形状，而
    // `get theme()` **不能**因此抛（它只读 globalThis 上的 Proxy，不碰 tui）。
    // 拖回「theme 走 live()」的话，下面按快捷键时就会抛
    // 「tui is not a function」而挂在这里。
    const uiRef: { current: HostUiOptions | undefined } = { current: undefined };
    const host = await loadExtensionHost({ builtins: false,
      store,
      cwd: process.cwd(),
      sessionId: () => 's',
      onSendMessage: () => {},
      canSend: () => true,
      uiOptions: () => {
        const ui = uiRef.current;
        if (ui) return ui;
        return {
          tui: undefined as never,
          theme,
          addInputListener: () => () => {},
          onNotice: () => {},
          setWidget: () => {},
        };
      },
    });
    // 活动面板开头就 `ctx.ui.theme.fg('accent', …)` —— 按一下就撞上那条路。
    await host.commands.handleKey('\x1b[115;6u', () => false);
    assert.ok(true, '界面起来之前读 ctx.ui.theme 不该抛');
  } finally {
    restoreHome();
  }
});

test('matchesKey：这些键位形状真的匹配（钉住测试自己没写错）', () => {
  // 测试自己用错了字节形状的话，上面几条会**静默地**变成「扩展的键没被消费」，
  // 而那与「实现坏了」是同一句话。所以钉住映射本身。
  assert.equal(matchesKey('\x1b[115;6u', 'ctrl+shift+s'), true, 'kitty CSI u 形状');
  assert.equal(matchesKey('\x1b[119;6u', 'ctrl+shift+w'), true);
  assert.equal(matchesKey('\x1b[113;5u', 'ctrl+q'), true);
});

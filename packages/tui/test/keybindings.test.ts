import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  getKeybindings,
  setKeybindings,
  stripTerminalSequences,
  matchesKey,
} from '@earendil-works/pi-tui';
import {
  ALL_KEYBINDINGS,
  PROJECT_KEYBINDINGS,
  actionKeys,
  actionMatches,
  createProjectKeybindings,
  formatKeyId,
  installProjectKeybindings,
  keyLabel,
  loadUserKeybindings,
  keybindingsPath,
} from '../src/keybindings';
import { hotkeysMarkdown, renderHotkeys } from '../src/hotkeys';
import { legacySequence } from './key-sequences';
import { setupTheme } from '../src/theme';
import path from 'node:path';

/**
 * 键位表与 `/hotkeys`。
 *
 * ## 这一组测试盯的是什么
 *
 * 1. **本项目自己的三个动作真的在表里**。少了的话症状是「那个键静默失效」，
 *    而顶行的 `(Ctrl+R)` 会变成 `()` —— 两处都是「看起来像没绑」，不是报错。
 * 2. **pi 的动作 id 没有被我们覆盖掉**。本项目用 `app.tools.expand` / `app.model.select`
 *    这些 pi 的 id（好处是同一份 `keybindings.json` 两边生效），一旦把默认键改成
 *    与 pi 不同，pi 那边的提示与本项目就会开始不一致。
 * 3. **`ctrl+t` 的含义与 pi 一致**。它是 pi 的 `app.thinking.toggle`，而本项目现在
 *    也实现了「展开/收起思考块」—— 两边共用一份键位文件，同一个键必须是同一个意思。
 *    （轨迹页仍在 `ctrl+r`，不复用这个 id，见 `app.trace.toggle`。）
 * 4. **用户的覆盖真的生效**（`keybindings.json`），且**提示文字跟着变** ——
 *    手写 `'(Ctrl+T)'` 的写法正是死在这里。
 * 5. `/hotkeys` 的表里出现的是**解析后**的键名，而且不为「本项目没实现的动作」凑行。
 */

/** 每个测试后把全局键位表恢复到默认（它是个进程级单例，污染会串到别的文件）。 */
function withDefaultKeybindings(body: () => void): void {
  const before = getKeybindings();
  installProjectKeybindings();
  try {
    body();
  } finally {
    setKeybindings(before);
  }
}

test('本项目自己的动作都在定义表里', () => {
  for (const action of Object.keys(PROJECT_KEYBINDINGS)) {
    assert.ok(action in ALL_KEYBINDINGS, `${action} 应该合并进 ALL_KEYBINDINGS`);
  }
  // 默认有键的那个：键名解析得出来 = 这个 id 真的能被 `matches()` 用。
  // 空串说明表里没有它。
  assert.notEqual(keyLabel('app.trace.toggle'), '', 'app.trace.toggle 应该有键名');
  // 排队那一列**不该**再有本项目自己的键位：与 pi 同一套（回车 = steer，
  // `app.message.followUp` = followUp）。它属于 pi 的 id，不该出现在 PROJECT_KEYBINDINGS 里。
  assert.ok(!('app.queue.cycle' in PROJECT_KEYBINDINGS), '入队模式那个键位已删（见 app.ts 的 queue()）');
  // **`app.abort` 默认不绑**（`ctrl+c` 已归 pi 的 `app.clear`，见 `keybindings.ts`）。
  // 但它仍是一个可用的 id —— 写进 `keybindings.json` 就该生效。
  assert.equal(keyLabel('app.abort'), '', 'app.abort 默认不该有键名（ctrl+c 归 pi）');
  const rebound = createProjectKeybindings();
  rebound.setUserBindings({ 'app.abort': 'ctrl+c' });
  assert.deepEqual(rebound.getKeys('app.abort'), ['ctrl+c']);
});

/**
 * 每个 followUp 键 id 对应的**字节序列样本**。
 *
 * 为什么按字节测：`alt+enter` 在不同终端发的不是同一串字节 —— 传统终端 `ESC CR`、
 * kitty 键盘协议 `ESC[13;3u`、xterm 的 modifyOtherKeys `ESC[27;3;13~`。少认一种，
 * 那个终端里 followUp 就「按了没反应」，而这正是最难归因的一类症状（用户不知道
 * 自己终端开了什么协议，只知道自己按了键没反应）。`ctrl+q` 是普通控制字符
 * （`DC1`），只有一种字节。
 *
 * `legacySequence()` 负责从**键 id** 推字节（所以断言里不写死 mac 的默认键），
 * 这里只额外补 `alt+enter` 的另外两种协议形状。
 */
function followUpSequences(key: string): readonly string[] {
  const forms = [legacySequence(key)];
  if (key === 'alt+enter') forms.push('\u001b[13;3u', '\u001b[27;3;13~');
  return forms;
}

/**
 * 排队走哪一列由**按哪个键**定，与 pi 同一套：回车 = steer（编辑器提交），
 * `app.message.followUp` = followUp。
 *
 * ## 键名因平台而异，所以这里**问键位表**而不是写死
 *
 * pi 的默认键按平台分叉（它的 `useWindowsKeybindings()`：`win32` 与 WSL 都算 Windows）：
 * macOS/Linux 是 `alt+enter`，**Windows 是 `ctrl+q`** —— Windows Terminal 把
 * `Alt+Enter` 当全屏开关，那一串根本到不了应用（按下去只整屏放大，看起来就像
 * 「Windows 上没有这个快捷键」）。
 *
 * 写死 `Option+Enter` 的断言在 Windows 上必挂，而挂的原因不是代码坏了，是断言在替
 * pi 决定平台。所以这里从 `actionKeys()` 拿**这一台机器上真正生效**的键，再逐个验字节序列。
 *
 * 早先本项目是 `ctrl+q` 切「入队模式」（`app.queue.cycle`），已删：模式是**状态**，
 * 切过之后每条都按新列走，而屏幕上看不出自己现在在哪个模式里 —— 症状是
 * 「我明明按的回车，怎么排到 followUp 去了」。
 */
test('排队键位与 pi 一致：followUp 键（mac 是 Option+Enter，Windows 是 Ctrl+Q）命中 app.message.followUp，裸回车归「提交」', () => {
  withDefaultKeybindings(() => {
    const keys = actionKeys('app.message.followUp');
    assert.ok(keys.length > 0, 'app.message.followUp 该有默认键');
    for (const key of keys) {
      for (const seq of followUpSequences(key)) {
        assert.ok(
          actionMatches(seq, 'app.message.followUp'),
          `${JSON.stringify(seq)} 该命中 app.message.followUp（${key}）`,
        );
      }
    }
    if (process.platform === 'win32') {
      // 钉住 Windows 的这一个具体键：`Ctrl+Q` 是本项目在 Windows 上唯一能按的
      // followUp 键（`Alt+Enter` 被终端吃掉），键名同时出现在 `/hotkeys` 与底栏提示。
      assert.deepEqual(keys, ['ctrl+q'], 'win32 上 followUp 是 pi 的 ctrl+q');
      assert.ok(!actionMatches('\u001b\r', 'app.message.followUp'), 'Alt+Enter 在 Windows 上不归 followUp');
      assert.equal(keyLabel('app.message.followUp'), 'Ctrl+Q');
    }
    assert.ok(!actionMatches('\r', 'app.message.followUp'), '裸回车是「提交」，不该被当成 followUp');
    assert.ok(actionMatches('\r', 'tui.input.submit'), '裸回车要能提交（= steer）');
    assert.ok(!('app.queue.cycle' in PROJECT_KEYBINDINGS), '入队模式那个键位已删');
  });
});

test('冲突以 pi 为准：ctrl+c 是 pi 的 app.clear，不再是本项目的中断', () => {
  withDefaultKeybindings(() => {
    // 本项目的中断动作 id 还在（可被覆盖），但**默认不占 ctrl+c**。
    assert.ok(!actionMatches('\x03', 'app.abort'), 'ctrl+c 不该再绑到 app.abort');
    // 它归 pi 的 app.clear（清空编辑器，连按两次退出）。
    assert.ok(actionMatches('\x03', 'app.clear'), 'ctrl+c 应当命中 pi 的 app.clear');
    // 中断改由 pi 的 app.interrupt（escape）负责。
    assert.ok(actionMatches('\x1b', 'app.interrupt'), 'escape 应当命中 pi 的 app.interrupt');
  });
});

test('默认键：轨迹页是 ctrl+r，而 ctrl+t 留给 pi 的 thinking.toggle', () => {
  withDefaultKeybindings(() => {
    assert.equal(keyLabel('app.trace.toggle'), 'Ctrl+R');
    assert.ok(actionMatches('\x12', 'app.trace.toggle'), 'ctrl+r 应当切轨迹页');
    // **关键的负向断言**：ctrl+t 不再属于本项目。它仍然属于 pi 的动作 ——
    // 两边共用一份 keybindings.json，所以这个键的含义不能有两套。
    assert.ok(!actionMatches('\x14', 'app.trace.toggle'), 'ctrl+t 不该再切轨迹页');
    assert.ok(actionMatches('\x14', 'app.thinking.toggle'), 'ctrl+t 仍是 pi 的 thinking.toggle');
  });
});

test('复用了 pi 的动作 id（同一份 keybindings.json 两边同时生效）', () => {
  withDefaultKeybindings(() => {
    // 这两个键在 pi 与本项目里是**同一个语义**，所以用同一个 id。
    assert.ok(actionMatches('\x0f', 'app.tools.expand'), 'ctrl+o = 展开工具输出');
    assert.ok(actionMatches('\x0c', 'app.model.select'), 'ctrl+l = 打开模型面板');
    assert.equal(keyLabel('app.tools.expand'), 'Ctrl+O');
    assert.equal(keyLabel('app.model.select'), 'Ctrl+L');
  });
});

test('写进 keybindings.json 的覆盖对「本项目的动作」也生效', () => {
  // 用的就是 pi 那个文件（同一台机器一份键位），所以这里直接把一条覆盖写进隔离的
  // 家目录，然后断言**读回来的那份**里有它。`app.trace.toggle` 不在 pi 的定义表里 ——
  // 若加载器照 pi 的 KEYBINDINGS 过滤，这一条会被悄悄丢掉（症状：改了键没反应，
  // 而且只有本项目的动作这样）。
  const file = keybindingsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const original = (() => {
    try {
      return loadUserKeybindings();
    } catch {
      return {};
    }
  })();
  writeFileSync(
    file,
    JSON.stringify({ 'app.trace.toggle': 'alt+r', 'app.tools.expand': ['ctrl+o', 'f2'] }),
    'utf8',
  );
  try {
    const loaded = loadUserKeybindings();
    assert.equal(loaded['app.trace.toggle'], 'alt+r');
    assert.deepEqual(loaded['app.tools.expand'], ['ctrl+o', 'f2']);

    const manager = createProjectKeybindings();
    assert.deepEqual(manager.getKeys('app.trace.toggle'), ['alt+r']);
    assert.deepEqual(manager.getKeys('app.tools.expand'), ['ctrl+o', 'f2']);

    // 装到全局之后，**提示文字**也换成了覆盖值（这是「手写键名」写法会死掉的地方）。
    setKeybindings(manager);
    assert.equal(keyLabel('app.trace.toggle'), formatKeyId('alt+r'));
  } finally {
    // 把文件恢复成原样（别的测试也读它）。
    writeFileSync(file, JSON.stringify(original), 'utf8');
    installProjectKeybindings();
  }
});

test('坏 JSON 的 keybindings.json 不会让界面炸掉（退到默认值）', () => {
  const file = keybindingsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const original = loadUserKeybindings();
  writeFileSync(file, '{ 这不是 JSON', 'utf8');
  try {
    assert.deepEqual(loadUserKeybindings(), {});
    // 而且默认值照旧可用 —— 界面在「用户键位文件坏了」时不该变成一副按不动的样子。
    assert.equal(keyLabel('app.trace.toggle'), 'Ctrl+R');
  } finally {
    writeFileSync(file, JSON.stringify(original), 'utf8');
    installProjectKeybindings();
  }
});

test('keybindings.json 里的未知动作名被忽略（不是报错）', () => {
  const file = keybindingsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const original = loadUserKeybindings();
  writeFileSync(file, JSON.stringify({ 'app.没这个动作': 'ctrl+z', 数字: 42 }), 'utf8');
  try {
    const manager = createProjectKeybindings();
    // 未知 id 不会进到 `keysById`（`KeybindingsManager` 内部按定义表过滤），
    // 也不会把别的动作弄坏。
    assert.deepEqual(manager.getKeys('app.没这个动作' as never), []);
    assert.equal(keyLabel('app.trace.toggle'), 'Ctrl+R');
  } finally {
    writeFileSync(file, JSON.stringify(original), 'utf8');
    installProjectKeybindings();
  }
});

test('actionMatches 在没装全局键位表时也能用（测试与首帧路径）', () => {
  // 模拟「pi-tui 自己建了一份只含 TUI_KEYBINDINGS 的默认表」—— 那时
  // `getKeys('app.trace.toggle')` 是空的，若不做兜底，键会静默失效。
  const before = getKeybindings();
  setKeybindings({
    matches: () => false,
    getKeys: () => [],
  } as never);
  try {
    assert.ok(actionMatches('\x12', 'app.trace.toggle'), '兜底那份里也该认 ctrl+r');
    assert.equal(keyLabel('app.trace.toggle'), 'Ctrl+R');
  } finally {
    setKeybindings(before);
  }
});

// ─── /hotkeys 的内容 ───

test('/hotkeys：分节与 pi 一致（Navigation / Editing / Other）', () => {
  const md = hotkeysMarkdown();
  for (const section of ['**Navigation**', '**Editing**', '**Other**']) {
    assert.ok(md.includes(section), `缺少小节 ${section}：\n${md}`);
  }
  assert.ok(md.includes('| Key | Action |'), md);
});

test('/hotkeys：表里的键名是解析出来的，不是写死的', () => {
  withDefaultKeybindings(() => {
    const md = hotkeysMarkdown();
    // 本项目自己的动作在里面，键名来自 `app.trace.toggle`（默认 Ctrl+R）。
    assert.ok(md.includes('`Ctrl+R`'), md);
    assert.ok(md.includes('切换'), md);
  });

  // 改了覆盖之后，同一张表说的是新键。
  const patched = createProjectKeybindings();
  patched.setUserBindings({ 'app.trace.toggle': 'alt+r' });
  setKeybindings(patched);
  try {
    const md = hotkeysMarkdown();
    assert.ok(md.includes(`\`${formatKeyId('alt+r')}\``), md);
    assert.ok(!md.includes('`Ctrl+R`'), `不该还写着默认键：\n${md}`);
  } finally {
    installProjectKeybindings();
  }
});

test('/hotkeys：与 pi 对齐的动作都列在表里（它们现在真的能按）', () => {
  const md = hotkeysMarkdown();
  // `feat/pi-keybindings-parity` 之后，这批 pi 的动作本项目都实现了 ——
  // 它们**应当**出现在表里（以前这条断言是反的：那时它们按不动，列出来会误导）。
  for (const live of [
    'app.suspend',
    'app.editor.external',
    'app.message.dequeue',
    'app.message.followUp',
    'app.message.copy',
    'app.clipboard.pasteImage',
    'app.thinking.cycle',
    'app.model.cycleForward',
    'app.interrupt',
    'app.clear',
    'app.exit',
  ] as const) {
    const keys = actionKeys(live);
    if (keys.length === 0) {
      // 这一台机器上 pi 的默认**本来就是空**：`app.suspend` 在 Windows 上是 `[]`
      // （`ctrl+z` 在那儿不是「挂到后台」）。这时表里不该给它凑一行 —— 那行会是
      // 「空键名 + 描述」，读的人只会以为表格坏了。
      assert.ok(!md.includes('| `` |'), `解绑的动作不该留空键名的行：\n${md}`);
      continue;
    }
    const label = keyLabel(live);
    assert.notEqual(label, '', `${live} 有键就该解析得出键名`);
    // 循环模型那一行是「两个键一个单元格」（`Ctrl+P / Shift+Ctrl+P`），所以
    // 只要行里出现这个键名就算列了 —— 直接包含整个 `` `label` `` 会漏掉合行。
    assert.ok(md.includes(label), `表里该出现 ${live}（${label}）：\n${md}`);
  }
  // 本项目自己的开关也在；**入队模式那行不在**（那个键位已删 —— 表里只有
  // `app.message.followUp` / `app.message.dequeue` 这两条与排队有关的）。
  assert.ok(md.includes(`\`${keyLabel('app.trace.toggle')}\``), md);
  assert.ok(md.includes('to edit all queued messages') === false, '卡片那句提示只在底区，不进键位表');
  // `app.abort` 默认不绑（`ctrl+c` 已归 pi 的 `app.clear`）—— 它的那一行不该出现在表里。
  assert.ok(!md.includes('app.abort'), md);
});

test('/hotkeys：Extensions 一节只在有扩展快捷键时出现', () => {
  assert.ok(!hotkeysMarkdown().includes('**Extensions**'));
  const md = hotkeysMarkdown([{ key: 'ctrl+shift+s', description: '发一张截图给模型' }]);
  assert.ok(md.includes('**Extensions**'), md);
  assert.ok(md.includes('`Ctrl+Shift+S`'), md);
  assert.ok(md.includes('发一张截图给模型'), md);
  // 没写描述也不能出现空单元格（读的人会以为表格坏了）。
  const noDesc = hotkeysMarkdown([{ key: 'ctrl+shift+x' }]);
  assert.ok(noDesc.includes('（扩展没写描述）'), noDesc);
});

test('/hotkeys：解绑成空数组的动作不出现在表里（空键名 = 一行假表格）', () => {
  const patched = createProjectKeybindings();
  // 解绑轨迹切换与模型面板。
  patched.setUserBindings({ 'app.trace.toggle': [], 'app.model.select': [] });
  setKeybindings(patched);
  try {
    const md = hotkeysMarkdown();
    assert.ok(!md.includes('` | 在「对话」与「轨迹」两页之间切换'), `解绑的动作不该留空键名：\n${md}`);
    assert.ok(!md.includes('打开模型选择面板'), md);
  } finally {
    installProjectKeybindings();
  }
});

test('/hotkeys：渲染出来有标题与上下边框（形状与 pi 相同）', () => {
  // pi 的 theme 是 globalThis 上的 Proxy，没 init 时读任何属性都抛 —— 渲染路径
  // （标题色、表格框线色）全都经过它。
  setupTheme();
  const lines = renderHotkeys(80);
  const plain = stripTerminalSequences(lines.join('\n'));
  assert.ok(plain.includes('Keyboard Shortcuts'), plain.slice(0, 200));
  // 表格框线：pi 用 Markdown 渲染表格，所以行里会有 `│` 与 `─`。
  assert.ok(plain.includes('│'), plain.slice(0, 400));
  assert.ok(plain.includes('─'), plain.slice(0, 400));
  // 每一行都不能超过宽度（超了会在终端里折行，把表格撕成两半）。
  for (const line of lines) {
    assert.ok(stripTerminalSequences(line).length <= 80, `超宽：${JSON.stringify(line)}`);
  }
});

test('/hotkeys：Kitty 协议的 release 序列不会命中这些键（与 app.ts 的过滤同一前提）', () => {
  // 这条是「mac 上快捷键触发两次」那个 bug 的另一面：release 序列（`:3u`）能匹配
  // `matchesKey`，所以 `app.ts` 必须在最前面滤掉它。这里只把**前提**钉住 ——
  // 键位表里的动作确实会被 release 命中，所以「滤掉」不是可选的。
  withDefaultKeybindings(() => {
    const esc = String.fromCharCode(27);
    for (const [, code] of [['r', 114]] as const) {
      assert.ok(matchesKey(`${esc}[${code};5:3u`, 'ctrl+r'), 'release 也能匹配 ctrl+r');
    }
    assert.ok(actionMatches(`${esc}[114;5:3r`, 'app.trace.toggle') === false, '半个序列不算按键');
  });
});

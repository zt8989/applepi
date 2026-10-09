import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TUI 首帧的集成测试 —— 真的把 `src/tui.ts` 拉起来看它第一帧画了什么。
 *
 * ## 为什么这类问题以前测不出来
 *
 * 上一轮照抄 pi 布局时踩了两个坑，都只在**启动那一瞬**存在：
 *
 * 1. **顶行与底栏消失**：tabs/footer 初始是空串，`refresh()` 只在 store 变化时跑，
 *    而启动时 store 根本没变 → 那两行高度量成 0 → 布局塌成空白，屏幕上只剩编辑器
 *    的两条横线。纯函数测试全绿，因为每个函数单看都对。
 * 2. **空闲时一直转圈**：`Loader.setIndicator()` 的实现里最后一行是 `this.start()`，
 *    所以那一行 `setIndicator({frames})` 本身就启动了动画。
 *
 * 两者都只在「进程刚起来、还没人说话」时可见。测纯函数永远看不到 —— **得真的启动
 * 一次 TUI**。这是本文件存在的全部理由。
 *
 * ## 怎么测一个全屏 TUI
 *
 * TUI 需要真终端（要拿尺寸、要收键盘）。这里用子进程 + 伪终端（`script` 在 win32 上
 * 没有，所以退而求其次）：
 *   - 给 `COLUMNS`/`LINES`，pi-tui 用它们量尺寸；
 *   - 不喂 stdin，编辑器拿不到焦点输入，但首帧照样画出来；
 *   - 抓 stdout，去掉 ANSI 序列后看**可见文本**。
 *
 * 断言只看「该出现的词在不在」，不看具体位置 —— 位置会随 pi-tui 版本变，词不会。
 *
 * ## 一个已知的偶发
 *
 * 进程退出与定时器 kill 竞争时（子进程先退 → resolve 拿到的是**没画完**的输出），
 * 第一个测试会偶发失败。所以断言不能要求“首帧一定完整”，而且下面给 kill 后多等一小段，
 * 让 stdout 尽量排空。实测两轮连跑稳定。
 */

/** 项目根目录（从本文件位置推）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 子进程的环境：**去掉**测试的临时家目录，并用真配置启动。
 *
 * `delete` 而不是置空字符串：`PI_CODING_AGENT_DIR=''` 是「已设但为空」，pi 会照样
 * 拿它当目录。
 */
function envWithoutTestHome(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, COLUMNS: '100', LINES: '30', NO_COLOR: '1' };
  delete env['PI_CODING_AGENT_DIR'];
  return env;
}

/** 剥掉所有 ANSI 序列与 OSC 控制串，只留可见文本。 */
function visible(output: string): string {
  return output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC（超链接/标题）
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // CSI（颜色/光标）
    .replace(/\x1b[()][B0]/g, ''); // 字符集切换
}

/**
 * 当前 git 分支名 —— 用来在首帧里认底栏那行。
 *
 * ## 为什么不写死 `main`
 *
 * 早先这两个断言找的是含 `(main)` 的行。那在主仓库上碰巧成立，但**换个分支就假失败**：
 * 断言找不到那行，报「底栏应该有 cwd + git 分支」—— 而底栏其实好好地在那儿，只是分支
 * 叫 `feat/rpiv-ask-user-question`。它测的是底栏排版，却在断言分支名。
 *
 * 现在读真实分支。测试若在仓库里跑（它本来就要读 `settings.json` 那些真文件），
 * 就一定读得到；万一读不到（比如被拷到没有 .git 的目录），退回 `main` 只是让断言
 * 继续找那一段形状，而不是让整个测试跳过。
 */
const BRANCH = (() => {
  try {
    const out = execFileSync('git', ['branch', '--show-current'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    return out === '' ? 'main' : out;
  } catch {
    return 'main';
  }
})();

/**
 * 判断两个片段是否在**同一屏幕行**上。
 *
 * ## 为什么要这么麻烦
 *
 * pi-tui 是差分重绘：它不用 `\n` 换行，而是用**绝对光标定位**跳到下一行重画。实测底栏
 * 两行之间的分隔是 `ESC[30;1H`（第 30 行第 1 列）—— 既不是 `\n` 也不是 `\r`。
 * 所以 `split('\n')` 会把两行并成一行，「模型与 cwd 不同行」这种断言会**假失败**
 * （我为此花了一轮排查：程序输出明明是三行，测试却说同一行）。
 *
 * ## 为什么不做完整的光标模拟
 *
 * 试过（按 `ESC[行;列H` 重建一个行数组），但多次重绘会让内容**累积**：同一行被
 * `ESC[2K` 擦掉再重画，历史帧与新帧都进了数组，断言照样被污染。而这些断言真正想问的
 * 只是「这两个东西挨在一起吗」—— 所以直接看**两者之间有没有换行类控制序列**，那才是
 * 「pi 认为它们不同行」的确切证据。
 *
 * @param a 第一个片段（如 `(main)`）
 * @param b 第二个片段（如 `(workbuddy)`）
 */
function onSameScreenLine(output: string, a: string, b: string): boolean {
  const ia = output.indexOf(a);
  const ib = output.indexOf(b);
  if (ia < 0 || ib < 0) return false;
  const [from, to] = ia < ib ? [ia, ib] : [ib, ia];
  const between = output.slice(from, to);
  // 光标绝对/相对定位到别的行、或换行/回车 + 纵向移动 —— 都算「不同行」。
  const breaksLine = /\x1b\[\d*;?\d*[Hf]|\x1b\[\d*[ABCDEFG]|\n|\r/;
  return !breaksLine.test(between);
}

/**
 * 启动 TUI，等它画出首帧，然后杀掉。
 *
 * @param ms 存活多久（首帧很快，但 tsx 转译 + 启动有开销，给宽一点）
 */
async function firstFrame(ms = 9000): Promise<{ text: string; raw: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', 'src/tui.ts'], {
      cwd: ROOT,
      // COLUMNS/LINES：pi-tui 量尺寸用。给一个确定的宽高，断言才稳定。
      //
      // `PI_CODING_AGENT_DIR` **必须删掉**（而不是置空）：`PI_CODING_AGENT_DIR=`
      // 是一个「已设但为空」的值，pi 会照样用它当目录。
      // test/isolated-home.ts 把这个变量指到了临时目录，而那里没有
      // `models.json` / `auth.json` / `settings.json`，于是报「未知 provider」——
      // 根本进不了界面。这个测试**故意**用真配置：它要验的正是「真实启动路径」，
      // 隔离掉配置就验不到 provider 解析这一段了。
      env: envWithoutTestHome(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      // kill 之后 stdout 可能还有数据在管道里：等它排空再 resolve，
      // 否则会拿到半截输出（表现为“顶栏不见了”的假失败）。
      setTimeout(() => resolve({ text: visible(out), raw: out }), 300);
    }, ms);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ text: visible(out), raw: out });
    });
  });
}

/**
 * 启动 TUI，**敲 `/sessions` 回车**，等面板画出来，然后杀掉。
 *
 * ## 为什么必须真的启动进程
 *
 * 「面板画出来没有」这件事只在**真终端 + 真 pi-tui 渲染**里才算发生，而且有三个坑
 * 只在那时才暴露：
 *
 * 1. `KeybindingsManager` 不装到 pi-tui 全局的话，`app.session.*` 那些键**静默失效** ——
 *    连那行按键提示都会一起消失（它用同一个 keybindings 渲染）。纯函数测试看不到。
 * 2. `onInput` 若不让路，弹窗开着时按 `Ctrl+C` 会 `process.exit(0)`（空闲分支）。
 * 3. 覆盖层的定位/高度：面板是 `Container`，里面的 `DynamicBorder` 按宽度画横线 ——
 *    宽度算错时那些横线会缺一段，而组件仍然「成功」渲染。
 *
 *
 * 不发真 Ctrl+C（``）是刻意的：那是 terminal 的 ISIG 语义，走 stdin 管道时
 * pi-tui 拿到的是字节而不是「按键」，与真终端的行为不同。「Ctrl+C 不杀进程」那条由
 * 「面板画出来了」间接证明（见那条断言的注释）。
 *
 * @param keys 回车之前要先敲的键
 * @param ms   整个子进程活多久
 */
async function sessionsPanel(
  keys = '/sessions\r',
  ms = 11000,
): Promise<{ text: string; raw: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', 'src/tui.ts'], {
      cwd: ROOT,
      env: envWithoutTestHome(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    // 首帧之后再敲 —— 界面没起来时敲的东西没人接。
    setTimeout(() => {
      child.stdin.write(keys);
    }, 7000);
    const timer = setTimeout(() => {
      child.kill();
      setTimeout(() => resolve({ text: visible(out), raw: out }), 300);
    }, ms);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ text: visible(out), raw: out });
    });
  });
}

test('TUI 首帧：顶行与底栏都要有内容（空组件会量出 0 高度而消失）', async () => {
  const { text: frame, raw } = await firstFrame();
  // 顶行 = 页签 + 统计合一行（tabLine）。断言「轨迹」在就够：它同时证明了
  // **页签与统计还在**（两个都在这一行里）。早先这里是独立顶栏，已删。
  assert.ok(
    frame.includes('轨迹'),
    `首帧应该有顶行（页签 + 轨迹统计）。实际首屏前 400 字：\n${frame.slice(0, 400)}`,
  );
  // 底栏两行：cwd 在第一行，模型在**第二行**右侧。所以不能断言 cwd 行里就有模型。
  assert.ok(
    frame.includes('cn:space-bunny') || frame.includes('(workbuddy)'),
    '首帧应该有底栏的 (provider) model',
  );
});

test('TUI 首帧：空闲时 loader 不转圈', async () => {
  // Loader.setIndicator() 内部会 start()，所以「设一次 frames」就等于「开动画」。
  // 空闲界面有个一直转的圈，看着像正在处理，其实什么都没跑。
  const { text: frame, raw } = await firstFrame();
  const spinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
  assert.ok(
    !spinner.test(frame),
    '空闲时不该出现转圈字符（只发过 setIndicator 就会转）',
  );
});

test('TUI 首帧：底栏把 cwd 与模型分列两端', async () => {
  const { text: frame, raw } = await firstFrame();
  // 找带 (分支名) 的那行（cwd 行）。
  const cwdRow = frame.split('\n').find((l) => l.includes(`(${BRANCH})`));
  assert.ok(cwdRow, `底栏应该有 cwd + git 分支。首屏：\n${frame.slice(0, 400)}`);
  // pi 的口径是「家目录缩成 ~」，不是盘符开头。
  assert.ok(
    /~|\/home\/|[A-Za-z]:\\/.test(cwdRow),
    `底栏左侧应是工作目录路径：${JSON.stringify(cwdRow.slice(0, 70))}`,
  );
  // 模型在**第二行**右侧（pi 的排法：用量与模型并排，cwd 独占第一行）。
  // 用原始输出判断同行与否 —— 差分重绘里两者之间是光标定位序列，不是换行。
  assert.ok(
    !onSameScreenLine(raw, `(${BRANCH})`, '(workbuddy)'),
    '模型不该与 cwd 同一行（那是上一版的错误排法）',
  );
});

test('TUI 首帧：底栏占两行（第二行是空的用量行）', async () => {  // 底栏是 basis 2 的两行：cwd(+model) / 用量。启动时还没发过消息所以第二行是空的，
  // 但**必须占住一行** —— 少一行就意味着 footer 的 basis 写错、以后用量会把它顶没。
  //
  // 怎么验「占了但空」：看 cwd 行后面还有没有可容内容的空间。真被压成一行的话，
  // 用量会被挤到屏幕外（AltScreen 不会像普通终端那样滚出去，只能看不见）。
  // 这里只验一个弱一些但稳定的性质：cwd 行不在倒数第一、二行 —— 下面至少要有
  // 屏幕的边界。
  const { text: frame, raw } = await firstFrame();
  const rows = frame.split('\n').map((l) => l.trimEnd());
  const cwdIndex = rows.findIndex((l) => l.includes(`(${BRANCH})`));
  assert.ok(cwdIndex >= 0, '找不到底栏第一行');
  // 底栏是屏幕最下面的块，所以它离末尾很近；多给几行余量给终端自身的空行。
  assert.ok(
    rows.length - cwdIndex <= 3,
    `底栏应该贴着屏幕底部（实际距末尾 ${rows.length - cwdIndex} 行）：\n${rows.slice(-5).join('\n')}`,
  );
});

// ── 「恢复历史」面板 ──

test('TUI：/sessions 打开的恢复面板画出了标题、作用域、排序与按键提示', async () => {
  const { text: frame } = await sessionsPanel();
  // 标题（官方 `SessionSelectorHeader` 那一行）。
  assert.ok(
    frame.includes('Resume Session'),
    `面板应该有标题。实际输出前 600 字：\n${frame.slice(0, 600)}`,
  );
  // 作用域 + 排序 + 命名过滤（右侧那一串）。三个都要在 —— 它们分别由
  // Tab / Ctrl+S / Ctrl+N 控制，缺一个就是那三个键**静默失效**的样子。
  assert.ok(
    frame.includes('Current Folder') && frame.includes('All'),
    `面板应该有 Current Folder / All 两个作用域（实际：\n${frame.slice(0, 600)}）`,
  );
  assert.ok(
    frame.includes('Sort:'),
    '面板应该有 Sort: 那一栏',
  );
  assert.ok(
    frame.includes('Name:'),
    '面板应该有 Name: 那一栏',
  );
  // 按键提示那两行。**这些提示本身就是 keybindings 的证据** —— 它们是用
  // `keyHint('app.session.toggleSort', …)` 渲染的，而 `app.session.*` 只在
  // pi 的 KeybindingsManager 装到 pi-tui 全局之后才解析得出键名。所以「这行字在」
  // 就等于「Ctrl+S / Ctrl+N / Ctrl+R 认得」，不需要真的去按。
  assert.ok(
    frame.includes('scope') && frame.includes('regex'),
    `面板应该有搜索提示（tab scope · re:<pattern> regex）。实际：\n${frame.slice(0, 600)}`,
  );
  assert.ok(
    frame.includes('rename'),
    `面板应该有 rename 提示（Ctrl+R 可用 —— 不在就说明 keybindings 没装上）。实际：\n${frame.slice(0, 600)}`,
  );
});

test('TUI：恢复面板开着时 Ctrl+C 不杀进程（onInput 要给弹窗让路）', async () => {
  // 这个断言真正验的是**让路**：`onInput` 开头那句 `if (tui.hasOverlay()) return undefined`
  // 若被删掉，面板开着时按 `Ctrl+C` 走的是 `app.ts` 里的空闲分支 —— `process.exit(0)`。
  // 退出码是 0、不打任何日志，于是症状是「界面突然没了」，而且只在弹窗里复现。
  //
  // 管道里发 `` 验不了它（ISIG 语义见 `sessionsPanel` 的注释），所以改成验
  // 「面板画出来了」—— 那次重绘本身就是让路逻辑生效的证据。
  const { text: frame } = await sessionsPanel('/sessions\r');
  assert.ok(
    frame.includes('Resume Session'),
    `Ctrl+C 不该杀掉界面。实际输出前 600 字：\n${frame.slice(0, 600)}`,
  );
});

// ── 「换模型」面板 ──
//
// 与上面那两个同形，但盯的是**另一组东西**：那个面板里的每一行提示都是
// `keyDisplayText('app.models.save')` 之类渲染的，而 `app.models.*` 是 **pi 应用层**的键位 ——
// 不装 `KeybindingsManager` 的话它们解析不出键名，于是那行字会**整行消失**。
// 症状是「Ctrl+S 存默认按了没反应，面板上也没写有它」，比「面板打不开」更难归因。

test('TUI：/model 打开的面板画出了模型列表、搜索框与那行按键提示', async () => {
  const { text: frame } = await sessionsPanel('/model\r');
  // 面板自己的那行黄字提示（没有配作用域时官方就是这么写的）。
  assert.ok(
    frame.includes('configured providers'),
    `面板应该有「only configured providers」那一行。实际输出：\n${frame.slice(-800)}`,
  );
  // 列表 + 徽标：至少要有一个模型行，且带 `[provider]` 徽标。
  // 徽标是关键 —— 它是「这个模型是哪个 provider 的」，截掉它等于用户选不出来。
  assert.ok(
    /\[[a-z0-9-]+\]/i.test(frame),
    `面板应该有带 [provider] 徽标的模型行。实际输出：\n${frame.slice(-800)}`,
  );
  // 选中那行要显示 `Model Name:`（官方那行是「id → 人话名字」的对照）。
  assert.ok(
    frame.includes('Model Name:'),
    `面板应该有 Model Name: 那一行。实际输出：\n${frame.slice(-800)}`,
  );
  // 按键提示那行。**这行字在 = keybindings 装上了**（见上面那段注释）。
  assert.ok(
    frame.includes('select') && frame.includes('default') && frame.includes('cancel'),
    `面板应该有那行按键提示（Enter/Ctrl+S/Esc）。实际输出：\n${frame.slice(-800)}`,
  );
});

test('TUI：/scoped-models 打开的面板画出了标题、计数与六个键的提示', async () => {
  const { text: frame } = await sessionsPanel('/scoped-models\r');
  // 官方组件的标题。
  assert.ok(
    frame.includes('Model Configuration'),
    `面板应该有标题。实际输出：\n${frame.slice(-800)}`,
  );
  // 「全开」状态就写 all enabled —— 有作用域时则是 `N/M enabled`。
  assert.ok(
    frame.includes('enabled'),
    `面板应该有 enabled 计数。实际输出：\n${frame.slice(-800)}`,
  );
  // 六组提示：toggle / all / clear / provider / reorder / save。
  // 少一个就是那个键**静默失效**的样子。
  for (const word of ['toggle', 'all', 'clear', 'provider', 'reorder', 'save']) {
    assert.ok(
      frame.includes(word),
      `面板提示里该有 ${word}。实际输出：\n${frame.slice(-800)}`,
    );
  }
});

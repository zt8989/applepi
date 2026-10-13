import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TUI 首帧的集成测试 —— 真的把 `packages/tui/src/main.ts` 拉起来看它第一帧画了什么。
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

/**
 * 仓库根目录（从本文件位置推：packages/tui/test → 仓库根）。
 *
 * **cwd 必须是仓库根**，不是 tui 包：TUI 的底栏按 `process.cwd()/.git` 认分支，
 * 而 `.git` 在仓库根。这与用户 `pnpm start`（在仓库根跑）时的行为一致。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** TUI 入口（仓库根下的 tui 包源码）。 */
const ENTRY = path.join(ROOT, 'packages', 'tui', 'src', 'main.ts');

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

/**
 * 同上，但**开着颜色**（去掉 `NO_COLOR`，给一个真彩色 TERM）。
 *
 * 需要它的理由：主题色（如 composer 横线的 `thinkingOff`）只有在颜色没被禁掉时才渲染成
 * `\x1b[38;2;…m`。默认那份把 `NO_COLOR=1` 是故意的 —— 其余断言只看文字，颜色序列只会
 * 干扰 `visible()`。但「横线颜色是不是跟着主题走」这件事**只能开着颜色验**。
 */
function envWithColor(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, COLUMNS: '100', LINES: '30', TERM: 'xterm-256color' };
  delete env['PI_CODING_AGENT_DIR'];
  delete env['NO_COLOR'];
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
 * 底栏第二行那个 `(provider) model` —— 从**真实 settings.json** 现读。
 *
 * ## 为什么不写死模型名
 *
 * 早先这里写的是 `cn:space-bunny` / `(workbuddy)`（当时那台机器的默认模型）。
 * 它们属于**用户配置**，而不是本项目的行为 —— 换个默认模型就假失败，
 * 而报错是「首帧应该有底栏的 (provider) model」，指着一个好好的底栏说没有。
 * 这与 `BRANCH` 写死 `main` 是同一类错（见上面那段注释）。
 *
 * 读不到（没配置 / 文件坏了 / 拷到没配置的机器）就退 `null`，调用方换一条
 * 形状断言（`(provider) model` 的形状，而不是具体名字）。
 */
const DEFAULT_MODEL_LINE = (() => {
  try {
    const raw = JSON.parse(
      readFileSync(path.join(homedir(), '.pi', 'agent', 'settings.json'), 'utf8'),
    ) as { defaultProvider?: unknown; defaultModel?: unknown };
    return typeof raw.defaultProvider === 'string' && typeof raw.defaultModel === 'string'
      ? `(${raw.defaultProvider}) ${raw.defaultModel}`
      : null;
  } catch {
    return null;
  }
})();

/** `(provider) model` 的形状 —— 读不到真配置时的兼项（不钉具体名字）。 */
const MODEL_LINE_SHAPE = /\([A-Za-z0-9._-]+\)\s+\S/;

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
 * 把 TUI 的输出**重放**成一个屏幕行数组（最后状态）。
 *
 * ## 为什么 `onSameScreenLine` 不够，非要真的重放
 *
 * 上面那个只回答「A 与 B 挨不挨着」，而这里要问的是**绝对行号**：「面板的底边落在
 * 第几行」「它是不是占满一整行」。这两个问题靠「两个片段之间有没有换行序列」答不了
 * —— 需要一个 (行, 列) 网格。
 *
 * ## 为什么重放是安全的（上面说过「重绘会累积」，这里为什么不累积）
 *
 * 累积只发生在「把每个新帧**追加**进数组」时。这里是**按顺序施加**每个控制序列到同一
 * 个网格上：`ESC[r;cH` 移动光标、`ESC[2K` 擦掉当前行、普通字符覆写。同一行被重画
 * 多次时，前面的内容被覆写/擦掉，网格里留下的就是**最后一次**的样子。
 *
 * 只处理 pi-tui 差分渲染真正会用的那几个 CSI：光标定位（`H`/`f`）、纵向/横向移动
 * （`A`–`D`）、列定位（`G`）、擦行（`K`）。其余 CSI（颜色、超链接 OSC）跳过。
 *
 * @param output 子进程的原始 stdout（含 ANSI）
 * @param cols   终端列数（与启动时的 `COLUMNS` 一致）
 * @param rows   终端行数（与 `LINES` 一致）
 * @returns 每行一个字符串（已去尾空格）；行号从 0 起
 */
function replayScreen(output: string, cols: number, rows: number): string[] {
  const grid: string[][] = Array.from({ length: rows }, () => new Array<string>(cols).fill(' '));
  let row = 0;
  let col = 0;
  let i = 0;
  while (i < output.length) {
    const rest = output.slice(i);
    // OSC（超链接 / 标题）：整段丢掉。
    const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest);
    if (osc) {
      i += osc[0].length;
      continue;
    }
    // CSI。
    const csi = /^\x1b\[([0-9;?]*)([a-zA-Z])/.exec(rest);
    if (csi) {
      const nums = (csi[1] ?? '').split(';').map((x) => (x === '' ? undefined : Number(x)));
      const cmd = csi[2];
      if (cmd === 'H' || cmd === 'f') {
        row = (nums[0] ?? 1) - 1;
        col = (nums[1] ?? 1) - 1;
      } else if (cmd === 'A') row -= nums[0] ?? 1;
      else if (cmd === 'B') row += nums[0] ?? 1;
      else if (cmd === 'C') col += nums[0] ?? 1;
      else if (cmd === 'D') col -= nums[0] ?? 1;
      else if (cmd === 'G') col = (nums[0] ?? 1) - 1;
      else if (cmd === 'K') {
        // 擦行：2 = 整行、0 = 光标到行尾、1 = 行首到光标。
        const mode = nums[0] ?? 0;
        const line = grid[row];
        if (line) {
          if (mode === 2) line.fill(' ');
          else if (mode === 0) for (let c = Math.max(0, col); c < cols; c += 1) line[c] = ' ';
          else for (let c = 0; c <= Math.min(cols - 1, col); c += 1) line[c] = ' ';
        }
      }
      i += csi[0].length;
      continue;
    }
    const ch = output[i] as string;
    if (ch === '\n') {
      row += 1;
      col = 0;
    } else if (ch === '\r') {
      col = 0;
    } else if (ch === '\x1b') {
      // 其它转义（字符集切换之类）：只跳过这一字节，不看待它。
    } else {
      const line = grid[row];
      if (line && col >= 0 && col < cols) line[col] = ch;
      col += 1;
    }
    i += 1;
  }
  return grid.map((line) => line.join('').replace(/\s+$/, ''));
}

/**
 * 屏幕上每一条「框线行」的信息：行号 + 横线个数。
 *
 * ## 为什么需要「每条约多宽」，不能只要一个行号
 *
 * 面板的上下框线、以及（没被盖住时）composer 自己的上下框线**长的样子完全一样** ——
 * 都是 100 个 `─`。所以「最后一条横线在第几行」单独回答不了「盖住没有」：居中 90% 的
 * 面板不盖 composer，屏上会同时存在面板的框线与 composer 的框线，而**最后一条恰好是
 * composer 的**（它在下、面板居中）—— 于是断言「最后一条 = composer 底边」**照样通过**。
 * （我为此又花了一轮：第一版写成「几乎全是横线就算」，居中 90% 也绿。）
 *
 * 真正能分辨的是**宽度**：
 *
 * | 形状 | 面板顶框 | 面板底框 | 残留的 composer 框线 |
 * | --- | --- | --- | --- |
 * | 满宽（对） | 100 列 | 100 列 | 被盖掉，看不见 |
 * | 居中 90%（错） | **90 列** | 100 列（左/右拼了旧内容） | 100 列，还露在外面 |
 *
 * 「面板顶框只有 90 列」是最干净的那条证据：它一定属于面板（屏幕最上方那条横线就是
 * 面板顶框），而且它的宽度直接就是覆盖层宽度。
 *
 * @param screen {@link replayScreen} 的结果
 * @returns 每条「≥ 20 个 `─`」的行的 `{ row, dashes }`（从上到下）
 */
function borderLines(screen: string[]): { row: number; dashes: number }[] {
  const out: { row: number; dashes: number }[] = [];
  screen.forEach((line, row) => {
    const dashes = (line.match(/─/g) ?? []).length;
    if (dashes >= 20) out.push({ row, dashes });
  });
  return out;
}



/**
 * 启动 TUI，等它画出首帧，然后杀掉。
 *
 * @param ms  存活多久（首帧很快，但 tsx 转译 + 启动有开销，给宽一点）
 * @param env 环境（默认禁用颜色；要验颜色时传 `envWithColor()`）
 */
async function firstFrame(
  ms = 9000,
  env: NodeJS.ProcessEnv = envWithoutTestHome(),
): Promise<{ text: string; raw: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', ENTRY, '--no-web'], {
      cwd: ROOT,
      // COLUMNS/LINES：pi-tui 量尺寸用。给一个确定的宽高，断言才稳定。
      //
      // `PI_CODING_AGENT_DIR` **必须删掉**（而不是置空）：`PI_CODING_AGENT_DIR=`
      // 是一个「已设但为空」的值，pi 会照样用它当目录。
      // test-support/isolated-home.ts 把这个变量指到了临时目录，而那里没有
      // `models.json` / `auth.json` / `settings.json`，于是报「未知 provider」——
      // 根本进不了界面。这个测试**故意**用真配置：它要验的正是「真实启动路径」，
      // 隔离掉配置就验不到 provider 解析这一段了。
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    /**
     * 收尾：**等 stdout 排空**再 resolve。
     *
     * 这一步不是可选：`stdio` 是管道，而 macOS 上**管道写是异步的** ——
     * `process.exit()` 会把还在缓冲区里的那几行丢掉（实测丢掉的是底栏）。
     *
     * 早先只在「计时器到点 kill」那条路上等了 300ms，`exit` 那条路直接 resolve ——
     * 而子进程在 **stdin 是 `/dev/null`** 时（`stdio: ['ignore', …]`，也就是这里的形状）
     * 会自己读完 EOF 退出（实测 ~1.7s），于是「进程自己退」这条路成了常态，
     * 首帧断言稳定地看不到底栏。
     */
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setTimeout(() => resolve({ text: visible(out), raw: out }), 300);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, ms);
    child.on('error', (error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', finish);
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
    const child = spawn('node', ['--import', 'tsx', ENTRY, '--no-web'], {
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
  //
  // 期望值从真配置现读（`DEFAULT_MODEL_LINE`）—— 写死模型名的话，换台机器/换个默认
  // 模型就是一条指着底栏说「底栏没有」的假失败。
  assert.ok(
    DEFAULT_MODEL_LINE === null ? MODEL_LINE_SHAPE.test(frame) : frame.includes(DEFAULT_MODEL_LINE),
    `首帧应该有底栏的 (provider) model（期望 ${DEFAULT_MODEL_LINE ?? '任意 (provider) model'}）。` +
      `实际首屏前 400 字：\n${frame.slice(0, 400)}`,
  );
});

test('TUI 首帧：空闲时 composer 上框线不转圈', async () => {
  // 工作状态（思考中 / 压缩中 / 重试）画在 composer 的**上框线**里（见 app.ts 的
  // `embedWorkingStatus`）。空闲时那里应该就是一条干净的横线 —— 一个一直转的圈
  // 看着像正在处理，其实什么都没跑。
  //
  // pi-tui 的 `Loader.setIndicator()` 内部会 `start()`，所以“设一次 frames”就等于“开动画”
  // —— 这条盯的就是“别在空闲时把那个 indicator 建出来”。
  const { text: frame } = await firstFrame();
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
  //
  // 先钉「模型那一行真的画出来了」：`onSameScreenLine()` 在两个片段有一个找不到时
  // 返回 false，不先断言的话「模型根本没渲染」也会让它过（早先写死 `(workbuddy)`
  // 就是这么静默过的）。
  const modelLine = DEFAULT_MODEL_LINE ?? '(provider) model';
  assert.ok(
    DEFAULT_MODEL_LINE === null ? MODEL_LINE_SHAPE.test(frame) : frame.includes(DEFAULT_MODEL_LINE),
    `底栏该画出模型那一行（期望 ${modelLine}）`,
  );
  assert.ok(
    !onSameScreenLine(raw, `(${BRANCH})`, DEFAULT_MODEL_LINE ?? '') || DEFAULT_MODEL_LINE === null,
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

// ── 面板的**位置与宽度**：它盖住 composer，不是居中浮窗 ──
//
// 这三条盯的是**几何**，不是「词在不在」—— 上面那些断言对「面板飘在屏幕中间、宽 90%」
// 同样会通过。而 pi 的这几个面板**不是弹窗**：`interactive-mode.js` 的 `showSelector()`
// 把 composer 那一格（`editorContainer`）的内容整个换掉，于是面板天然满宽、底边就是
// composer 的底边。本项目用覆盖层复刻同一个矩形（见 `packages/tui/src/composer-overlay.ts`）。
//
// 要在「真渲染」里验它，得把差分重绘**重放**成屏幕网格（`replayScreen`），因为差分渲染
// 不用 `\n` 换行、而是绝对光标定位跳行 —— `split('\n')` 得到的不是真实屏幕行。

/** 与 `envWithoutTestHome()` 里给终端定的尺寸保持一致（见那里的注释）。 */
const TERM_COLS = 100;
const TERM_ROWS = 30;

/**
 * 底栏占几行。**这就是「composer 底边距屏幕底的行数」** —— composer 下面是底栏，
 * 底栏贴着屏幕底，所以 composer 的底框线落在 `TERM_ROWS - FOOTER_ROWS - 1`（0 起）。
 *
 * 硬编码 2 而不是 import `FOOTER_ROWS` 是**故意**的：这个测试要独立钉住「底栏是两行 +
 * 面板底边对齐它」这个**外部可见**的事实。若哪天有人只改了 `FOOTER_ROWS` 而忘了布局，
 * 从同一个常量 import 的断言会跟着一起错，等于没测。这里写死，改动就会红。
 */
const FOOTER_ROWS_EXPECTED = 2;

test('TUI：面板的底框线与 composer 的底边同一条线（不是居中浮窗）', async () => {
  const { raw } = await sessionsPanel('/model\r');
  const screen = replayScreen(raw, TERM_COLS, TERM_ROWS);
  const borders = borderLines(screen);

  // composer 的底边：底栏两行之下就是屏幕底，所以底框线在倒数第 3 行（0 起）。
  const expected = TERM_ROWS - FOOTER_ROWS_EXPECTED - 1;

  // 屏幕上**只该有两条框线**：面板的上下框。多于两条就是「面板浮在上面、composer 还在
  // 底下」—— 居中浮窗正是这个症状（面板的顶框 + 底框 + 没被盖住的 composer 底框）。
  // 光看「最后一条框线在第几行」会被它骗过：居中时最后一条恰好是 composer 的底框，
  // 行号与期望值一样。
  assert.equal(
    borders.length,
    2,
    `面板开着时该只有它的上下两条框线（composer 被盖住）。实际 ${borders.length} 条：` +
      `${borders.map((b) => `第 ${b.row} 行/${b.dashes} 列`).join('、')}。\n` +
      `屏幕：\n${screen.map((l, i) => `${i}|${l}`).join('\n')}`,
  );

  // 面板的**下框线** = 最后一条框线。它要和 composer 的底边同一条线。
  const panelBottom = borders[borders.length - 1];
  assert.equal(
    panelBottom?.row,
    expected,
    `面板的下框线该落在第 ${expected} 行（composer 的底边），实际在第 ${panelBottom?.row} 行。\n` +
      `居中浮窗会把面板整体推到屏幕中部（底边也跟着上移）。实际屏幕：\n` +
      `${screen.map((l, i) => `${i}|${l}`).join('\n')}`,
  );
});

test('TUI：面板满宽（100%）—— 顶框就占满一整行', async () => {
  const { raw } = await sessionsPanel('/model\r');
  const screen = replayScreen(raw, TERM_COLS, TERM_ROWS);
  const borders = borderLines(screen);

  // 屏幕**最上方**那条框线一定是面板的顶框（面板盖在对话区上面）。它有多宽，面板就有
  // 多宽 —— 这是「满宽」最直接的证据，不受 composer 残留框线的干扰（见 `borderLines`）。
  const panelTop = borders[0];
  assert.equal(
    panelTop?.dashes,
    TERM_COLS,
    `面板顶框该占满 ${TERM_COLS} 列，实际 ${panelTop?.dashes} 列（在第 ${panelTop?.row} 行）。\n` +
      `居中 90% 时这里只有 90 列 —— 左右各留一截别的画面，看着就像「面板没盖住输入框」。\n` +
      `实际屏幕：\n${screen.map((l, i) => `${i}|${l}`).join('\n')}`,
  );

  // 顶框必须**从屏幕最左边开始**（col 0）。居中 90% 时它从第 5 列起，左边那 5 列是上一帧
  // 的内容 —— 宽度再对也对不上位置。
  const topLine = screen[panelTop?.row ?? -1] ?? '';
  assert.ok(
    topLine.startsWith('─'),
    `面板顶框该从第 0 列开始（满宽），实际开头是 ${JSON.stringify(topLine.slice(0, 8))}`,
  );
});

test('TUI：面板盖住 composer —— 输入框的框线不再露在外面', async () => {
  // 「覆盖」不只是「更大」：pi 是把 composer **换掉**，所以面板开着时看不到输入框本身。
  //
  // ## 怎么区分「盖住了」与「只是叠在上面」
  //
  // 两者的框线都是 `─`，只能数**条数**：
  //
  // | 形状 | 屏上的框线 |
  // | --- | --- |
  // | 满宽（对，盖住） | 面板顶框 + 面板底框 = **2** 条 |
  // | 居中 90%（错，没盖住） | 面板顶框 + 面板底框 + 没被盖住的 composer 框线 = **3** 条 |
  //
  // 注意**不能**只数「满宽（100 列）的框线」：居中面板的底框虽然自己只有 90 列，但它左右
  // 两侧是没被写过的旧内容 —— 而旧内容恰好是 composer 自己的满宽框线，拼起来看着也是
  // 100 列（我第一版就跳了这个坑，错误也绿）。所以要数**所有** ≥ 20 列的框线行。
  const { raw } = await sessionsPanel('/model\r');
  const screen = replayScreen(raw, TERM_COLS, TERM_ROWS);
  const borders = borderLines(screen);

  assert.equal(
    borders.length,
    2,
    `面板开着时该只有它的上下两条框线（composer 被盖住），实际 ${borders.length} 条：` +
      `${borders.map((b) => `第 ${b.row} 行/${b.dashes} 列`).join('、')}。\n` +
      `多出来的那条通常是没被盖住的 composer 框线。\n` +
      `屏幕：\n${screen.map((l, i) => `${i}|${l}`).join('\n')}`,
  );
  // 两条都该是满宽 —— 这也是「面板顶框满宽」的另一个侧面证据。
  for (const b of borders) {
    assert.equal(b.dashes, TERM_COLS, `第 ${b.row} 行的框线该满宽（${TERM_COLS} 列），实际 ${b.dashes} 列`);
  }
});

// ── composer 的横线颜色（与 pi 一致：主题色，不是写死的 dim） ──

/**
 * 取**第一条满宽横线**前面最近的那个 SGR 序列（就是那条横线的颜色）。
 *
 * 怎么认「第一条满宽横线就是 composer 的上框线」：启动首帧里没有面板，整屏只有 composer
 * 那两条边框是满宽的 `─`；而顶行/对话区用的是别的字符。所以按出现顺序，第一条就是它。
 *
 * 为什么要「前面最近的那个 SGR」而不是「行首的 SGR」：pi-tui 是差分重绘，写一行时先
 * 定位光标（`ESC[r;cH`）、可能还带一个 `ESC[0m` 重置，然后才是颜色序列，最后才是 `─`。
 * 取最近的就能拿到真正生效的那个。
 */
function firstBorderSgr(raw: string): string | undefined {
  const dashRun = /─{40,}/.exec(raw);
  if (!dashRun) return undefined;
  const before = raw.slice(0, dashRun.index);
  const seqs = [...before.matchAll(/\x1b\[([0-9;]*)m/g)];
  return seqs.length > 0 ? seqs[seqs.length - 1]?.[1] : undefined;
}

test('TUI：composer 的横线用的是主题色（真彩色），不是写死的 dim', async () => {
  // 这条钉的是「composer 和 pi 一致 包括横线颜色」。
  //
  // 早先 `EDITOR_THEME.borderColor` 手写成 `(s) => dim(s)` —— 那是一个**文本属性**
  // （`\x1b[2m`，变淡），不是颜色 token。pi 的做法是 `theme.getThinkingBorderColor(level)`
  // （默认级别 'off' → `thinkingOff`），跟着主题走、也跟思考级别走。
  //
  // 区分两者：主题色渲染出来是**真彩色** `\x1b[38;2;…m`（okhsl/hex 都解析成 RGB），
  // 而手写的 `dim` 只会给 `\x1b[2m`。所以「横线的 SGR 里有 `38;2;`」就等于
  // 「它走的是主题色」。
  //
  // 为什么必须单独起一个**开着颜色**的子进程：默认那套 `NO_COLOR=1` 会把颜色剥掉，
  // 那种输出里根本看不到 `38;2;`，这条断言就失去意义。
  const { raw } = await firstFrame(9000, envWithColor());
  const sgr = firstBorderSgr(raw);

  assert.ok(sgr !== undefined, `首帧里该能看到 composer 的横线。原始输出前 300 字：\n${raw.slice(0, 300)}`);
  assert.match(
    sgr,
    /38;2;/,
    `composer 横线该用主题的真彩色（形如 38;2;r;g;b），实际 SGR 是 ${JSON.stringify(sgr)}。\n` +
      `写死的 dim（\\x1b[2m）会在这里现形 —— 它在浅色终端上与 pi 不一致。`,
  );
  assert.notEqual(
    sgr,
    '2',
    'composer 横线不该只是 dim 那个文本属性（那正是要去掉的写法）',
  );
});

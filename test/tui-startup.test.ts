import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TUI 首帧的集成测试 —— 真的把 `src/tui.ts` 拉起来看它第一帧画了什么。
 *
 * ## 为什么这类问题以前测不出来
 *
 * 上一轮照抄 pi 布局时踩了两个坑，都只在**启动那一瞬**存在：
 *
 * 1. **顶栏与底栏消失**：header/footer 初始是空串，`refresh()` 只在 store 变化时跑，
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

/** 剥掉所有 ANSI 序列与 OSC 控制串，只留可见文本。 */
function visible(output: string): string {
  return output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC（标题等）
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // CSI（颜色/光标）
    .replace(/\x1b[()][B0]/g, ''); // 字符集切换
}

/**
 * 启动 TUI，等它画出首帧，然后杀掉。
 *
 * @param ms 存活多久（首帧很快，但 tsx 转译 + 启动有开销，给宽一点）
 */
async function firstFrame(ms = 9000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', 'src/tui.ts'], {
      cwd: ROOT,
      // COLUMNS/LINES：pi-tui 量尺寸用。给一个确定的宽高，断言才稳定。
      env: { ...process.env, COLUMNS: '100', LINES: '30', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      // kill 之后 stdout 可能还有数据在管道里：等它排空再 resolve，
      // 否则会拿到半截输出（表现为“顶栏不见了”的假失败）。
      setTimeout(() => resolve(visible(out)), 300);
    }, ms);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(visible(out));
    });
  });
}

test('TUI 首帧：顶栏与底栏都要有内容（空组件会量出 0 高度而消失）', async () => {
  const frame = await firstFrame();
  assert.ok(
    frame.includes('轨迹'),
    `首帧应该有顶栏（轨迹统计）。实际首屏前 400 字：\n${frame.slice(0, 400)}`,
  );
  assert.ok(
    frame.includes('cn:space-bunny') || frame.includes('(workbuddy)'),
    '首帧应该有底栏的 (provider) model',
  );
});

test('TUI 首帧：空闲时 loader 不转圈', async () => {
  // Loader.setIndicator() 内部会 start()，所以「设一次 frames」就等于「开动画」。
  // 空闲界面有个一直转的圈，看着像正在处理，其实什么都没跑。
  const frame = await firstFrame();
  const spinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
  assert.ok(
    !spinner.test(frame),
    '空闲时不该出现转圈字符（只发过 setIndicator 就会转）',
  );
});

test('TUI 首帧：底栏把 cwd 与模型分列两端', async () => {
  const frame = await firstFrame();
  // 找带 (main) 的那行（cwd 行）。
  const cwdRow = frame.split('\n').find((l) => l.includes('(main)'));
  assert.ok(cwdRow, `底栏应该有 cwd + git 分支。首屏：\n${frame.slice(0, 400)}`);
  // 同一个 Text 里右边是模型（可能因为宽屏被截断到别处），至少路径要带上省略号或盘符。
  assert.ok(
    /[A-Za-z]:\\|…/.test(cwdRow),
    `底栏左侧应是工作目录路径：${JSON.stringify(cwdRow)}`,
  );
});

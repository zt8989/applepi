/**
 * 测试的**配置家目录隔离**。
 *
 * ## 为什么需要它
 *
 * 会话文件写在 `~/.pi/agent/sessions/<cwd 编码>/<id>.jsonl`，而 `cwd` 编码来自
 * **测试自己 mkdtemp 出来的临时目录**。也就是说：每跑一次测试，就往用户的家目录里
 * 落一批以临时目录命名的会话文件与轨迹文件。跑几十遍之后，`~/.redux-agent/sessions/`
 * 里全是 `--C--Users-me-AppData-Local-Temp-init-XXXX--` 这种目录，用户的「恢复历史」
 * 列表被彻底污染 —— 而这些文件对用户毫无价值。
 *
 * 轨迹本身已经用 `traceDir` 隔离了（见各测试的 `mkdtemp`），**会话文件漏了**。
 * 这里补上漏的那一半。
 *
 * ## 怎么做的
 *
 * 在 `package.json` 的 test 脚本里用 `--import` 预先加载本文件：它在任何测试模块
 * 求值之前把 **pi 官方的 `PI_CODING_AGENT_DIR`** 指到本次运行专属的临时目录，
 * 并在退出时整个删掉。
 *
 * 为什么用 pi 那个名字：本项目早先有自己的 `REDUX_AGENT_DIR`，现在删了 ——
 * 两个变量指向同一件事，却只有一个会被 pi 自己认，症状是「我们与 pi 各读各的」。
 * 详见 `packages/core/src/config-home.ts` 的文件头。
 *
 * 为什么用「整个进程一个目录」而不是「每个测试一个」：进程级更简单，也不会漏掉
 * 任何**没经过某个 helper** 的测试（以后新写的测试默认就隔离了，这是重点）。
 * 目录名里带 pid，撞车不了。
 *
 * 同理，本文件还会在 chalk 加载前打开颜色（见文件末尾），因为 pi 主题的斜体靠 chalk。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), `redux-agent-test-home-${process.pid}-`));
process.env['PI_CODING_AGENT_DIR'] = dir;

// 退出时清掉。正常退出与异常退出都要管，所以两个都挂上。
const cleanup = (): void => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 临时目录删不掉不该让测试失败（可能正被某个句柄占着，交给系统清理）。
  }
};
process.once('exit', cleanup);
process.once('SIGINT', () => {
  cleanup();
  process.exit(130);
});

/**
 * 打开颜色（让 chalk 的 bold/italic 在测试里真的产生转义序列）。
 *
 * 必须在**任何 import 求值之前**设好 —— chalk 只在模块加载时读一次环境变量。
 * 放在文件末尾但仍然是顶层语句：本文件没有 import chalk，而测试模块是在本文件
 * 全部求值完之后才被加载的，所以顺序是对的。
 *
 * 值取 3（truecolor）：与真终端上 `getTerminalColorMode()` 的返回值一致，
 * 免得测试里出现 256 色降级后的色号，断言却按真彩写。
 * 已有的 `NO_COLOR` 优先于它（chalk 里 NO_COLOR 赢）—— 想测「完全不上色」时
 * 显式设 `NO_COLOR=1` 即可。
 */
process.env['FORCE_COLOR'] = '3';

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
 * **`HOME` 也一起指过去**（指向同一个临时目录）：pi 的 `getHomeDir()` 读的是 `HOME`，
 * 而技能加载除了 `~/.pi/agent/skills` 还会扫 `~/.agents/skills` —— 只改前者的话，
 * 每个跑测试的人都把**自己真实家目录里的几十个 skill** 扫进 prompt（症状是
 * 「这台机器上碰巧过」，以及本机看到的 skill 清单与 CI 上完全不同）。
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
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/**
 * 真实配置家目录 —— **必须在改 `HOME` 之前算**。
 *
 * `extension-host.test.ts` 是故意用真家目录的（它验的就是「与 pi 共用一份配置」），
 * 而它现在靠这个变量找真目录（而不是 `homedir()` —— 那个会跟着被改掉的 `HOME` 跑）。
 */
process.env['PI_CODING_AGENT_DIR_REAL'] = path.join(homedir(), '.pi', 'agent');

const dir = mkdtempSync(path.join(tmpdir(), `redux-agent-test-home-${process.pid}-`));
process.env['PI_CODING_AGENT_DIR'] = dir;
// `HOME` 跟着一起指过去：pi 的 `getHomeDir()`（→ `~/.agents/skills`、祖先目录的
// `.agents/skills`）读的就是它。见文件头。
process.env['HOME'] = dir;

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

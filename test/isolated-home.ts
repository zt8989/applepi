/**
 * 测试的**配置家目录隔离**。
 *
 * ## 为什么需要它
 *
 * 会话文件写在 `~/.redux-agent/sessions/<cwd 编码>/<id>.jsonl`，而 `cwd` 编码来自
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
 * 求值之前把 `REDUX_AGENT_DIR` 指到本次运行专属的临时目录，并在退出时整个删掉。
 *
 * 为什么用「整个进程一个目录」而不是「每个测试一个」：进程级更简单，也不会漏掉
 * 任何**没经过某个 helper** 的测试（以后新写的测试默认就隔离了，这是重点）。
 * 目录名里带 pid，撞车不了。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), `redux-agent-test-home-${process.pid}-`));
process.env['REDUX_AGENT_DIR'] = dir;

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

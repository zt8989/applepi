import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 一次性模式（`-p`）+ MCP：退出时**必须显式收掉** stdio 子进程。
 *
 * ## 这条测试盯的是一个真实的挂死
 *
 * 配置里有一个 MCP stdio 服务器（`npx -y rea-agents` 那种）时，它连到一半（还在
 * 解析 / 下载 / 握手）就被一次性模式丢下。优雅的 `session_shutdown` 收不掉它 ——
 * 那一刻它的 client 还没挂到 connection 上，`close()` 是空转（见
 * `packages/tui/src/main.ts` 的 `process.exit` 那段）。而它的 stdio 一直握着事件
 * 循环，于是进程**退不出去**（实测卡到 600s 超时）。
 *
 * ## 为什么必须真的起进程
 *
 * 「退出」只在真进程里才算发生。纯函数测不出来，`kernel.dispose()` 单独 await 也
 * 测不出来（上面说的空转正是它测不到的）。所以这里真的拉起 `main.ts -p`，
 * 配一个**握手永远不返回**的 MCP 服务器（fixture 写一个 pid 文件再挂着），
 * 然后看进程会不会自己退、以及那个子进程有没有被收掉。
 *
 * 为了让「服务器已经被拉起、且正卡在握手里」这件事确定发生，配置用
 * `exposure: direct` —— 官方在首个 prompt 前最多等 direct 服务器 10 秒
 * （`DEFAULT_STARTUP_WAIT_MS`），这段时间足够子进程被拉起并卡住。
 *
 * provider 指向一个没人监听的本地端口（并且不给 key），让这一轮 LLM 快速失败 ——
 * 本测试只关心退出路径，不关心模型。
 */

/** 仓库根目录（从本文件位置推：packages/tui/test → 仓库根）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** TUI 入口。 */
const ENTRY = path.join(ROOT, 'packages', 'tui', 'src', 'main.ts');
/** 「握手永远不返回」的 MCP 服务器。 */
const FIXTURE = path.join(ROOT, 'packages', 'core', 'test', 'fixtures', 'hang-mcp-server.mjs');

/** 进程还活着吗（`kill(pid, 0)` 只探活，不发信号）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('一次性模式 + MCP：连到一半的子进程不会把进程卡住（退出路径显式收子进程）', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'ela-mcp-exit-home-'));
  const marker = path.join(home, 'hang.pid');
  t.after(() => {
    // 兜底：断言失败时父进程可能还在挂着，别把一个挂死的服务器留在机器上。
    if (existsSync(marker)) {
      const pid = Number(readFileSync(marker, 'utf8'));
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 已经没了。
        }
      }
    }
    rmSync(home, { recursive: true, force: true });
  });

  // provider：没人监听的端口 + 没有 key → 这一轮 LLM 立刻失败（我们只测退出路径）。
  writeFileSync(
    path.join(home, 'models.json'),
    JSON.stringify({
      providers: {
        hangtest: {
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1/v1',
          models: [{ id: 'x', name: 'X' }],
        },
      },
    }),
  );
  writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify({ defaultProvider: 'hangtest', defaultModel: 'x' }),
  );
  // MCP：direct + 挂着的服务器。`env` 把 pid 文件路径传进去。
  writeFileSync(
    path.join(home, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        hang: {
          exposure: 'direct',
          command: process.execPath,
          args: [FIXTURE],
          env: { HANG_MARKER: marker },
        },
      },
    }),
  );

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', ENTRY, '-p', 'hi', '--attempts', '1', '--llm-timeout', '3000'],
    {
      cwd: ROOT,
      // 隔离配置家目录（否则会读用户真的 mcp.json / settings.json）。
      env: { ...process.env, PI_CODING_AGENT_DIR: home, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));

  const exited = await new Promise<{ timedOut: boolean }>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ timedOut: true });
    }, 40_000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ timedOut: false });
    });
  });

  assert.equal(
    exited.timedOut,
    false,
    `一次性模式该自己退出（子进程被收掉），实际卡到 40s 超时。输出末尾：\n${out.slice(-1500)}`,
  );

  // 先确认这条测试真的把服务器拉起来过 —— 否则「进程退出了」可能只是因为压根没子进程。
  assert.ok(
    existsSync(marker),
    `MCP 服务器该被拉起过（fixture 的 pid 文件不存在）。输出末尾：\n${out.slice(-1500)}`,
  );
  const pid = Number(readFileSync(marker, 'utf8'));
  assert.ok(Number.isFinite(pid), `marker 里该是一个 pid，实际：${readFileSync(marker, 'utf8')}`);

  // 父进程退了，子进程不该还活着（SIGTERM 后给它一点时间自己走）。
  let dead = !alive(pid);
  for (let i = 0; i < 50 && !dead; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    dead = !alive(pid);
  }
  assert.ok(
    dead,
    `退出路径该把 MCP 服务器子进程（pid ${pid}）一起收掉，但它还活着。输出末尾：\n${out.slice(-1500)}`,
  );
});

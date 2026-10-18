#!/usr/bin/env node
/**
 * 全局 CLI 的入口 —— 一个**薄**启动器，逻辑一行也不放这里。
 *
 * 存在的理由只有一个：`packages/tui/src/main.ts` 是 TypeScript，且 `tsconfig` 用
 * `moduleResolution: "Bundler"` + 无扩展名相对导入（`import ... from './app'`）。
 * 那套写法 tsc 不 emit（`noEmit`），产物也无法被 node 的原生 ESM 解析 ——
 * 所以全局命令必须经 tsx 装载，不能直接把 main.ts 挂成 bin。
 *
 * 与 `pnpm start`（在仓库根跑）的等价关系：
 *
 *   pnpm start → node --import tsx packages/tui/src/main.ts
 *   ela        → node packages/tui/bin/ela.mjs
 *
 * 两者现在**完全等价**：同一个入口、同一套凭证规则。
 *
 * ## 凭证：不读 .env
 *
 * key 来自 shell 环境变量、`~/.pi/agent/auth.json`、或 models.json 条目内的
 * `apiKey`。刻意没有 `.env` 这一档 —— 从调用目录读 `.env` 会把「A 项目的 key」
 * 发给「B 项目」，比读不到更难查。要带 key 用 `--api-key` 或真环境变量
 * （两者都最终写进环境变量）。
 *
 * ## 为什么用 tsx 的 tsImport 而不是 register()
 *
 * `tsx/esm` 的 `register()` 只在 `--import` 上下文里能用（它的 `initialize`
 * 拿不到 hook scope，会抛「must be loaded with --import」）。想在普通脚本里装载
 * .ts，能用的就是 `tsx/esm/api` 的 `tsImport()` —— 它内部自建 namespace，
 * 不需要进程级 preload。
 *
 * 入口 specifier **故意拼成绝对路径转的 file:// URL**：相对 specifier 会按本文件
 * （`bin/`）的位置解析，而入口在 `packages/tui/src/`，差一级。
 */
import process from 'node:process';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * herdr pane 里的身份提示（`HERDR_AGENT`）。
 *
 * herdr 认 pane 里有没有 agent，只看**前台进程身份**：它拿进程名 / argv 去比对已知 agent，
 * 认不出来就当这个 pane 没有 agent。而我们的进程是 `node …/bin/ela` —— `ela` 它不认识，
 * 也看不出这是 pi 家族。于是 pane 在 Agents 面板里没有身份；更糟的是启动期那些探测子进程
 * （比如扩展跑的 `opencode --version`）跟 ela 同一个前台进程组，会被它当成 OpenCode，
 * 结果是「先显示成 opencode、子进程退出后又变成没有 agent」。
 *
 * herdr 为此给了包装进程用的提示变量：设了 `HERDR_AGENT=<agent>`，它就用**指定 agent** 的
 * 屏幕 manifest 与集成来对待这个前台进程。ela 的界面与状态上报都走 pi 那一套
 * （pi-tui / pi-ai，加上 herdr 装在 `~/.pi/agent/extensions` 的 pi 扩展负责报状态与 session），
 * 所以这里默认报 `pi`。
 *
 * **为什么必须 re-exec 一次**：herdr 读的是**进程 exec 那一刻**的环境（macOS 的
 * `KERN_PROCARGS2` / Linux 的 `/proc/<pid>/environ`），本进程里 `process.env.HERDR_AGENT = …`
 * 它看不到（实测 `ps` 也看不到）。所以只能在 exec 之前就把变量塞进环境 —— 用同一份 argv
 * 再执行一次自己，把 hint 传下去。
 *
 * **只在真的处于 herdr pane 里做**：三个变量齐全、且是个交互终端（stdin 是 TTY）才算 ——
 * 变量判据与 herdr 自己的 pi 扩展同一套，TTY 判据是为了让脚本/测试/一次性模式里
 * 少一个进程（那些场景 herdr 也不画这个 pane 的 TUI）。
 * 并且**不覆盖**已经显式设置的 `HERDR_AGENT`。`ELA_HERDR_AGENT=<name>` 换身份，
 * `ELA_HERDR_AGENT=off` 整个关掉。
 *
 * ## Windows 上不做（这条 hint 在那边没人读）
 *
 * 官方文档（*Agents → VMs and sandbox wrappers*）把这个变量限定在 **Linux / macOS**：
 * “On Linux and macOS, a host-visible wrapper can hide the real agent process…” ——
 * Windows 那份 `herdr.exe` 里连 `HERDR_AGENT` 这个字符串都不存在（那段逻辑是 `cfg(unix)`
 * 的）。也就是说这里 exec 出去的变量 Windows 上的 herdr **从来不读**：pane 依旧没有身份，
 * 白多一个常驻父进程。
 *
 * Windows（其实**所有**平台）的正解是 ela **自己上报**：见 `@ela/core/herdr` 的文件头。
 * 那边走 `HERDR_SOCKET_PATH` 上报 pane 的 agent 名/状态/会话，跨平台都算数，与这里
 * 这次 re-exec 是**互补**关系：这条 hint 给 herdr 一个「屏幕 manifest 按 pi 那套认」的
 * 提示（mac / linux），那条上报直接告诉它「这个 pane 里是 pi」。
 *
 * 代价是多一个常驻父进程（它只是阻塞等子进程，不占 CPU）+ 几十毫秒启动开销；换来的是 herdr
 * 里正确的 agent 身份、idle/working/blocked 状态与 session 恢复。
 */
const HERDR_AGENT_HINT_ENV = 'ELA_HERDR_AGENT';

/** 该给 herdr 报哪个 agent；`undefined` = 不干预（不在 herdr 里，或已被显式指定/关闭）。 */
function herdrAgentHint() {
  // Windows：这条 hint 没人读，别为它多起一个进程（见顶部那一节）。
  if (process.platform === 'win32') {
    return undefined;
  }
  if (
    process.env.HERDR_ENV !== '1' ||
    !process.env.HERDR_PANE_ID ||
    !process.env.HERDR_SOCKET_PATH ||
    process.stdin.isTTY !== true
  ) {
    return undefined;
  }
  // 启动器（或用户）已经指定过身份，就别抢。
  if (process.env.HERDR_AGENT) {
    return undefined;
  }
  const requested = process.env[HERDR_AGENT_HINT_ENV];
  if (requested === 'off' || requested === '0' || requested === '') {
    return undefined;
  }
  return requested ?? 'pi';
}

/**
 * 带着 hint 再执行一遍自己，把当前进程交棒给它。
 *
 * 已经交棒（调用方不该再往下走）返回 `true`；re-exec 起不来返回 `false` ——
 * 这只是给 herdr 的提示，不该变成 ela 的启动前置条件。
 */
function handOffToHerdrAgentHint(agent) {
  // 用 realpath（不是 argv[1]）：`ela` 是 symlink，直接再走一次链接会多一层解析。
  const script = fileURLToPath(import.meta.url);
  const child = spawnSync(process.execPath, [script, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, HERDR_AGENT: agent },
  });
  if (child.error) {
    process.stderr.write(
      `ela：注入 HERDR_AGENT=${agent} 的重入失败，按原样启动（herdr 会认不出本 pane）：${child.error.message}\n`
    );
    return false;
  }
  // 退出状态 / 信号照原样传回去（zsh 的 job control 与 Ctrl+C 都指望这个）。
  if (child.signal) {
    process.kill(process.pid, child.signal);
    return true;
  }
  process.exit(child.status ?? 1);
}

/** packages/tui/bin/ela.mjs → tui 包根。所有入口都从它推，不依赖 process.cwd()（那属于用户）。 */
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 两个入口 URL 在**模块顶层**算好，不在 main() 里。
 *
 * 入口 specifier 若是相对路径，解析基址是本文件（`bin/`），不是 `..` 里的 `src/` ——
 * 所以必须拼成绝对路径再转 file:// URL。这里提前算完是为了让 main() 只剩
 * 「import + 调用」两件事，失败时堆栈也只有一层。
 */
// 用 `import.meta.resolve` 而**不是** `require.resolve`：后者按 `require` 条件解析，
// tsx 的 `./esm/api` 对 require 指向 `index.cjs` —— 而那个文件里写的是相对
// `import './esm/index.mjs'`，从 CJS 里这么 import 会被解析成 `api/esm/index.mjs`
// （不存在），得到 ERR_MODULE_NOT_FOUND。要 `import` 条件的 index.mjs。
//
// `tsx/esm/api` 是**公开**入口。不写 `tsx/dist/esm/api/index.mjs` 是因为那条路径
// 没进 tsx 的 exports，会 ERR_PACKAGE_PATH_NOT_EXPORTED —— 与本项目在
// pi-coding-agent 上踩的坑同构（那边靠 pnpm patch 打开，tsx 不用 patch）。
//
// 返回值**已经是绝对 URL**：套 pathToFileURL 会得到 `file:\C:\...` 这种垃圾
// （路径分隔符不是 `/`，file: 解析不出来）。所以拿完直接用。
const tsImportApi = import.meta.resolve('tsx/esm/api', pathToFileURL(`${pkgRoot}/`));
const entry = pathToFileURL(path.join(pkgRoot, 'src', 'main.ts')).href;

async function main() {
  const { tsImport } = await import(tsImportApi);
  // tsImport 会真的执行 main.ts（它顶层就 void main()），并解析其返回值。
  // main.ts 的 main() 是 async，模块顶层不等它 —— 事件循环上有活着的 TUI，
  // 进程会自己活着直到 Ctrl+C。所以这里只 await 模块求值本身就够了。
  await tsImport(entry, import.meta.url);
}

// 必须在装载 TUI 之前定：带 hint 的那份进程才是真正跑 TUI 的（见顶部注释）。
const herdrAgent = herdrAgentHint();
if (herdrAgent !== undefined) {
  handOffToHerdrAgentHint(herdrAgent);
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
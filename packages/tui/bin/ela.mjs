#!/usr/bin/env node
/**
 * 全局 CLI 的入口 —— 一个**薄**启动器，逻辑一行也不放这里。
 *
 * 必须经 tsx 装载：`main.ts` 是 TS，且 `tsconfig` 用 `moduleResolution: "Bundler"` + 无扩展名相对
 * 导入，tsc 不 emit，产物也无法被 node 原生 ESM 解析。所以全局命令不能直接把 `main.ts` 挂成 bin。
 *
 * 凭证不读 `.env`：key 来自环境变量、`~/.pi/agent/auth.json` 或 models.json 里的 `apiKey` ——
 * 从调用目录读 `.env` 会把「A 项目的 key」发给「B 项目」。
 *
 * 用 tsx 的 `tsImport()` 而不是 `register()`：后者只在 `--import` 上下文里能用。入口 specifier 拼成
 * file:// 绝对 URL：相对 specifier 会按 `bin/` 解析，而入口在 `packages/tui/src/`。
 */
import process from 'node:process';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * herdr pane 里的身份提示（`HERDR_AGENT`）。
 *
 * herdr 只看**前台进程身份**（进程名 / argv），而我们是 `node …/bin/ela` —— 于是 pane 没有身份，
 * 启动期那些探测子进程还会让它误判成 OpenCode。设 `HERDR_AGENT=pi` 它就用 pi 那套 manifest 对待这个
 * 前台进程。
 *
 * **必须 re-exec 一次**：herdr 读的是 exec 那一刻的环境，本进程里改 `process.env` 它看不到。
 *
 * 只在真的处于 herdr pane 里做（三个变量齐全 + stdin 是 TTY），且**不覆盖**已显式设置的
 * `HERDR_AGENT`；`ELA_HERDR_AGENT=<name>` 换身份、`off` 关掉。Windows 上不做：那条 hint 只有 unix
 * 版 `herdr` 读（Windows 的正解是 ela 自己上报，见 `@ela/core/herdr`），否则白多一个常驻父进程。
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
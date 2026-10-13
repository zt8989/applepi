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
import { fileURLToPath, pathToFileURL } from 'node:url';

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

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
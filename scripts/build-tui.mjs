/**
 * 把 TUI 入口打成一个 ESM 文件（`packages/tui/dist/ela.mjs`）。
 *
 * ## 为什么要有这一步
 *
 * 首帧的时间几乎全是「读 + 编译 ESM 模块」：入口经 `tsx` 装载时实测 982~1213ms，
 * 其中我们自己那 20 来个文件只占 25ms，其余全在 `@earendil-works/*` 的模块图上
 * （约 1600 个文件，pi 的包根还顺带把 `./main.js` 与整个交互层重导出了）。
 * 打成一个文件后同一台机器实测首帧 325~368ms，与 `pi` 自己（`dist/bundle/cli.js`，
 * 也是预打包的）同一档。数据与取舍见 docs/architecture/init.md。
 *
 * ## 三个打包坑（都是实测踩出来的，删掉任意一条都会坏）
 *
 * 1. `banner` 里的 `createRequire`：依赖里混着 CJS（`cross-spawn` 等），ESM 输出
 *    否则启动即 `Dynamic require of "child_process" is not supported`。
 * 2. `define: PI_BUNDLED_NODE`：pi 的扩展 loader 据此决定「虚拟模块」还是「按 `__dirname`
 *    推别名」。不给的话 `__dirname` 变成 `dist/`，每个扩展都报
 *    `Cannot find module 'typebox'`（扩展装载被静默降级成全部失败）。
 * 3. 产物位置不是 pi 的包目录：主题 / 文档 / README 都从「pi 的包目录」推，打包后那一路必错。
 *    `PI_PACKAGE_DIR` 由产物启动时自己解析（`src/pi-package-dir.ts`），构建这一步不写死
 *    （写死会在仓库挪位置后失效）。
 */
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(repoRoot, 'packages', 'tui', 'dist', 'ela.mjs');

await rm(path.dirname(outfile), { recursive: true, force: true });

const result = await build({
  entryPoints: [path.join(repoRoot, 'packages', 'tui', 'src', 'main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'warning',
  banner: {
    js: [
      "import { createRequire as __elaCreateRequire } from 'node:module';",
      'const require = __elaCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  define: { PI_BUNDLED_NODE: 'true' },
});

for (const warning of result.warnings) {
  process.stderr.write(`esbuild：${warning.text}\n`);
}
const { size } = await stat(outfile);
process.stdout.write(
  `ela：${path.relative(repoRoot, outfile)} ${(size / 1048576).toFixed(1)}MB\n`
);

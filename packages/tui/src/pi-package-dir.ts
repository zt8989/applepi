/**
 * 让**打包产物自己**也能找到 pi 的包目录（`PI_PACKAGE_DIR`）。
 *
 * pi 的主题 JSON、文档、README、导出模板都从「pi 的包目录」推（`config.js` 的
 * `getPackageDir()`）：有 `PI_PACKAGE_DIR` 就用它，否则按 `__dirname` 往上找第一个
 * `package.json`。后者在单文件产物里必错 —— 产物在 `packages/tui/dist/`，往上第一个
 * `package.json` 是 `@ela/tui` 的，于是主题目录被算成 `packages/tui/{src,dist}/modes/
 * interactive/theme`，`dark.json` / `light.json` 都读不到；`initTheme()` 随后**静默**
 * 回落 system 主题，症状是卡片与工具块的底色全丢（实测 `toolSuccessBg` 变成
 * `rgb(0,0,0)`，见 theme.ts 开头那节）。
 *
 * 解析方式有讲究：**不能用 `require.resolve`**。pi 的 `exports` 里 `"."` 只有
 * `types` / `import` 两个条件，CJS 解析会直接 `ERR_PACKAGE_PATH_NOT_EXPORTED`
 * （早先启动器那版注入就是这么静默失效的：异常被 catch 掉，环境变量始终没设）。
 * `import.meta.resolve` 走 ESM 条件，能拿到 `dist/index.js`；老 Node 没有它时退回
 * 「按 `node_modules` 布局往上找」。
 *
 * 宿主显式指定的 `PI_PACKAGE_DIR`（测试、Nix）永远优先，所以这个函数只补空。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/**
 * 把 pi 的包目录填进 `PI_PACKAGE_DIR`（已设置就不动）。
 *
 * @returns 真正生效的包目录；解析不出来时 `undefined` —— 那种情况让 pi 按它自己的
 *          规则推（会丢主题，但不该让启动失败）。
 */
export function ensurePiPackageDir(): string | undefined {
  const configured = process.env['PI_PACKAGE_DIR'];
  if (configured !== undefined && configured !== '') return configured;

  const packageDir = viaSpecifier() ?? viaNodeModules();
  if (packageDir === undefined) return undefined;
  process.env['PI_PACKAGE_DIR'] = packageDir;
  return packageDir;
}

/** 主路：ESM 解析出 pi 的入口，再往上认包根。 */
function viaSpecifier(): string | undefined {
  let entry: string;
  try {
    entry = fileURLToPath(import.meta.resolve(PI_PACKAGE));
  } catch {
    return undefined;
  }
  return findPackageDir(path.dirname(entry));
}

/** 退路：不经过 `exports`，直接按 `node_modules` 布局往上找（pnpm 的符号链接会被 existsSync 跟进去）。 */
function viaNodeModules(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', ...PI_PACKAGE.split('/'));
    if (existsSync(path.join(candidate, 'package.json'))) return packageDirAt(candidate);
    dir = path.dirname(dir);
  }
  return undefined;
}

/** 从入口所在目录往上找本包的根；撞到 `package.json` 就定案，名字不对就不猜。 */
function findPackageDir(entryDir: string): string | undefined {
  let dir = entryDir;
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, 'package.json'))) return packageDirAt(dir);
    dir = path.dirname(dir);
  }
  return undefined;
}

/**
 * 判定 `dir` 是不是本包的根。
 *
 * 不能只看 `basename === 'dist'`：pi 的入口今天是 `dist/index.js`，一旦换成
 * `dist/bundle/cli.js` 那种布局，光凭目录名会把包根算到 `dist/bundle` 上，主题又
 * 静默没了。核对 `package.json` 的 `name` 才知道走对了。
 *
 * `dist/package.json` 是 bun 二进制的布局（`copy-binary-assets` 拷进去的），真包根在
 * 上一级 —— pi 自己的 `findNodePackageDir()` 也这么判，否则 dist 相对路径会变成 dist/dist。
 */
function packageDirAt(dir: string): string | undefined {
  if (packageNameAt(dir) !== PI_PACKAGE) return undefined;
  const parent = path.dirname(dir);
  if (path.basename(dir) === 'dist' && packageNameAt(parent) === PI_PACKAGE) return parent;
  return dir;
}

function packageNameAt(dir: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    const name = (manifest as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

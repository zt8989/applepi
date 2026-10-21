/**
 * 开场「已装载资源」那几节的**显示形状** —— 与 pi 同形，拆出来是为了能单测。
 *
 * 照抄 pi 的口径：开场报的是**资源是什么**（一条路径一个文件、一条一个扩展入口），不是「它带来了几个
 * 工具」。报成工具名的后果比不好看严重 —— 用户照着那一行去 `settings.json` 的 `packages` 里找，找不到，
 * 于是以为扩展没装上。
 *
 * 三条规则照抄 `getCompactExtensionLabels()`：npm/git 来源用 `包:入口`（`pi-web-access:dist`）；非包
 * 来源取路径**末尾最短的唯一后缀**；末尾的 `index.ts` / `index.js` 去掉（那是入口不是名字）。
 */
import path from 'node:path';

/** 一个扩展（与 `ExtensionHost.entries` 同形，此处只取显示要用的字段）。 */
export interface LabeledExtension {
  path: string;
  source?: string | undefined;
  baseDir?: string | undefined;
}

/** 是不是「包」来源（npm / git）—— 那类来源按包名显示，不按路径。 */
function isPackageSource(ext: LabeledExtension): boolean {
  const source = ext.source ?? '';
  return source.startsWith('npm:') || source.startsWith('git:');
}

/**
 * 家目录缩成 `~`（pi 的 `formatDisplayPath`）。
 *
 * ## 比 pi 多一个判断：分隔符
 *
 * pi 那份是裸的 `startsWith(home)`，于是 `/home/me2/x` 在家目录是 `/home/me` 时被缩成
 * `~2/x` —— 一个**指向别处**的路径，比不缩还坏（用户照着它找不到文件）。
 * 所以要求 home 之后紧跟分隔符或到家目录末尾。
 */
export function tildePath(p: string, home: string): string {
  if (home === '' || !p.startsWith(home)) return p;
  const rest = p.slice(home.length);
  if (rest === '') return '~';
  return /^[\\/]/.test(rest) ? `~${rest}` : p;
}

/** 路径归一化成 `/` 分隔 —— 标签一律用正斜杠，与 pi 一致。 */
function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

/** `source` 的包名部分：`npm:pi-web-access` → `pi-web-access`。 */
function packageLabel(ext: LabeledExtension): string {
  const source = ext.source ?? '';
  if (source.startsWith('npm:')) return source.slice('npm:'.length) || source;
  return source;
}

/** 包内相对路径（去掉 `baseDir` 前缀与 `extensions/` 那层）。 */
function packageRelativePath(ext: LabeledExtension): string {
  const full = normalize(ext.path);
  const base = ext.baseDir !== undefined ? normalize(ext.baseDir) : undefined;
  if (base !== undefined && base !== '' && full.startsWith(`${base}/`)) {
    return full.slice(base.length + 1);
  }
  // 没有 baseDir（老版本 pi / 手写 settings）时退到 node_modules 的相对位置。
  //
  // 包名与剩余路径要**分开数**：包名最多两段（scope/name），其余才是入口。用一个贪婪的
  // 正则一次匹配会把 `pi-web-access/dist/index.js` 里的 `dist` 吃进「包名」，
  // 于是标签变成 `pi-web-access/dist/index.js:…`（pi 那份正则有同样的毛病，只是在
  // 它的路径上 `baseDir` 总在、这条分支几乎不走）。
  const marker = full.lastIndexOf('node_modules/');
  if (marker >= 0) {
    const rest = full.slice(marker + 'node_modules/'.length).split('/');
    const pkg = rest[0]?.startsWith('@') === true ? rest.slice(0, 2) : rest.slice(0, 1);
    const rel = rest.slice(pkg.length).join('/');
    if (rel !== '') return rel.startsWith('extensions/') ? rel.slice('extensions/'.length) : rel;
  }
  return full;
}

/** 非包来源：末尾最短的**唯一**后缀段。 */
function shortestUniqueSuffix(segments: string[], index: number, all: string[][]): string {
  for (let count = 1; count <= segments.length; count += 1) {
    const candidate = segments.slice(-count).join('/');
    const unique = all.every(
      (other, otherIndex) =>
        otherIndex === index || other.slice(-count).join('/') !== candidate,
    );
    if (unique) return candidate;
  }
  return segments.join('/');
}

/**
 * 开场 `[Extensions]` 那一节的逗号分隔清单。
 *
 * 顺序**按标签排**（而不是按路径）：清单是给人扫的，能扫到某一个就行，
 * 而顺序稳定才不会每次启动都长得不一样。
 */
export function extensionLabels(extensions: readonly LabeledExtension[]): string[] {
  // 非包来源先算好分段（包来源根本不用它们，而 index.ts 那种要去尾段）。
  const nonPackage = extensions
    .map((ext) => {
      const segments = normalize(ext.path)
        .split('/')
        .filter((s) => s.length > 0 && s !== '~');
      const last = segments[segments.length - 1];
      if (segments.length > 1 && (last === 'index.ts' || last === 'index.js')) segments.pop();
      return { path: ext.path, segments };
    })
    .filter((item) => {
      const ext = extensions.find((e) => e.path === item.path);
      return ext !== undefined && !isPackageSource(ext);
    });
  const allSegments = nonPackage.map((item) => item.segments);

  const labels = extensions.map((ext) => {
    if (isPackageSource(ext)) {
      const label = packageLabel(ext);
      const rel = packageRelativePath(ext);
      const parsed = path.posix.parse(rel);
      if (parsed.name === 'index') {
        return parsed.dir === '' || parsed.dir === '.'
          ? label
          : `${label}:${parsed.dir}`;
      }
      return `${label}:${rel}`;
    }
    const index = nonPackage.findIndex((item) => item.path === ext.path);
    if (index === -1) {
      const segments = normalize(ext.path).split('/').filter((s) => s.length > 0 && s !== '~');
      const last = segments[segments.length - 1];
      return segments.length > 1 && (last === 'index.ts' || last === 'index.js')
        ? segments.slice(0, -1).join('/')
        : segments[segments.length - 1] ?? ext.path;
    }
    const found = nonPackage[index];
    if (found === undefined) return normalize(ext.path);
    return shortestUniqueSuffix(found.segments, index, allSegments);
  });
  return labels.sort((a, b) => a.localeCompare(b));
}

/**
 * 开场 `[Context]` 那一节的清单（家目录缩 `~`，相对 cwd 的保持相对）。
 *
 * pi 的顺序是「system prompt 源 → append 源 → AGENTS.md 家目录/项目/祖先」，
 * 那个顺序本身就是解释（先看最像「配置」的文件），照抄。
 */
export function contextLabels(files: readonly { path: string }[], cwd: string, home: string): string[] {
  return files.map((f) => {
    const absolute = path.isAbsolute(f.path) ? path.resolve(f.path) : path.resolve(cwd, f.path);
    const relative = path.relative(cwd, absolute);
    const shown =
      relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? relative
        : tildePath(f.path, home);
    // 分隔符统一成 `/`：那不是「改路径」，只是显示 —— Windows 上 `~\AGENTS.md`
    // 里的反斜杠与 pi 的输出不一致，看起来像两台机器的配置。
    return normalize(shown);
  });
}

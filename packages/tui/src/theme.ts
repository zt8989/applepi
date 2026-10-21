/**
 * 初始化 pi 的主题（单独一个文件见下）。
 *
 * 所有颜色都来自 pi 的 `theme`（挂在 globalThis 上的 Proxy）：手写 `paint('48;2;37;65;49', …)` 只
 * 会得到「看起来差不多」的颜色，而且**亮色终端上会直接变成黑底黑字**。
 *
 * 两个坑：`theme` 没初始化时读任何属性都抛 `Theme not initialized`；而光 `initTheme()`（不带名字）
 * 拿到的是 **system 主题** —— 终端还没上报颜色时它渲染成灰度（实测 `toolSuccessBg` 与 `userMessageBg`
 * 都是 `rgb(0,0,0)`，于是「工具块有底色」**静默失效**）。
 *
 * 所以这里读 `settings.json` 的 `theme` 字段（与 pi 同一个文件、同一个键），用 `resolveThemeSetting()`
 * 按**终端深浅色**解析；没配就按 `getTerminalTheme()` 的检测在 dark/light 之间选 —— 写死 dark 会让
 * 浅色终端出现黑底块。
 */
import {
  getTerminalTheme,
  initTheme,
  resolveThemeSetting,
  theme,
  type Theme,
  type TerminalTheme,
} from '@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { loadPiSettings } from '@ela/core/pi-config';

/** 内置主题名。`system` 也在列里，但要单独处理（见下）。 */
const BUILTIN = new Set(['dark', 'light', 'system']);

/** 真正生效的主题名。`/about` 之类要显示「当前主题」时读它。 */
let activeName = 'dark';

export function themeName(): string {
  return activeName;
}

/**
 * 解析出该用哪个主题名。
 *
 * 纯函数（不碰 globalThis）：测试能直接喂不同的 settings 与终端外观，
 * 不必真的初始化全局主题 —— 而初始化是**进程级**的，测试里做一次就够了。
 *
 * @param setting             `settings.json` 里的 `theme` 值（可以是 `auto`、
 *                            `light:dark, dark:light` 这种自动形式，也可以是自定义主题名）。
 * @param terminalAppearance  终端是深底还是浅底。
 */
export function resolveThemeName(
  setting: string | undefined,
  terminalAppearance: TerminalTheme,
): string {
  // 与 pi 同一套解析：`auto` 形式会在深/浅之间挑一个；显式名字原样返回。
  const resolved = resolveThemeSetting(setting, terminalAppearance);
  if (resolved && BUILTIN.has(resolved) && resolved !== 'system') return resolved;
  // `system` 单独排除：它依赖终端上报真实颜色，上报失败就退化成灰度（底色全黑），
  // 而我们要的是**确定的** dark/light。
  // 没配（undefined）或配了个不认的东西 → 跟随终端外观。
  return terminalAppearance;
}

/**
 * 把 pi 的主题装上。**必须在任何渲染之前调一次。**
 *
 * @param override           强制指定主题名（命令行参数之类；不给就读 settings.json）。
 * @param terminalAppearance 终端深浅色；不给就自己检测。
 * @returns 真正生效的主题对象。
 */
export function setupTheme(
  override?: string | undefined,
  terminalAppearance?: TerminalTheme,
): Theme {
  const appearance = terminalAppearance ?? getTerminalTheme();
  const name = resolveThemeName(override ?? loadPiSettings().theme, appearance);
  // enableWatcher=false：主题文件热重载是 pi 自带的特性，这里不要。
  // 少一个文件监听就少一个「进程退不出去」的原因；而且我们要跟的是**终端自身**的
  // 深浅色变化，那走的是 pi-tui 的颜色上报，不在这个 watcher 的管辖范围内。
  initTheme(name, false);
  // initTheme 在主题无效时会**静默**回落到 system（于是底色全黑）。这里把真实生效的
  // 名字读回来存着，好让调用方能发现「我以为在用 dark，其实在用 system」。
  activeName = readActiveName(name);
  return theme;
}

/** 读回真正生效的主题名；读不到（Proxy 未初始化）就返回我们请求的那个。 */
function readActiveName(requested: string): string {
  try {
    return theme.name ?? requested;
  } catch {
    return requested;
  }
}

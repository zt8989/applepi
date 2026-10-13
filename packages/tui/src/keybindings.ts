/**
 * 本项目自己的键位表 —— 在 pi 那份之上加几个动作，装进 pi-tui 的全局 keybindings。
 *
 * ## 为什么要「在 pi 那份之上」
 *
 * pi-tui 的 `getKeybindings()` 默认只有 `TUI_KEYBINDINGS`（`tui.editor.*` / `tui.input.*`
 * / `tui.select.*` / `tui.altScreen.*`），而 `app.*` 那一堆是 **pi 应用层**定义的
 * （`pi-coding-agent/dist/core/keybindings.js` 的 `KEYBINDINGS`）。两者加起来才是完整
 * 的一份键位表。
 *
 * 本项目的界面是**另一套应用层**：它有自己的开关（轨迹页、队列模式、中断），所以
 * 这里的做法是「pi 的全套 + 我们自己的几个」：
 *
 *     defs = { ...pi 的 KEYBINDINGS, ...PROJECT_KEYBINDINGS }
 *
 * 好处有三个，都不是理论上的：
 *
 *   1. **复用 pi 的动作 id**。`ctrl+o` 展开工具输出 = pi 的 `app.tools.expand`，
 *      `ctrl+l` 打开模型面板 = pi 的 `app.model.select` —— 用同一个 id 意味着用户写在
 *      `~/.pi/agent/keybindings.json` 里的覆盖**两边同时生效**（pi 那边改了键，
 *      我们这边跟着改，反之亦然）。自己编一个 `ela.tools.expand` 就会分家。
 *   2. **提示文字不再手抄键名**。面板底部那句「Enter to select · Ctrl+S …」与顶行的
 *      `(Ctrl+R)` 都由 `keyDisplayText()` 从**同一个**解析结果渲染 —— 用户改了键，
 *      提示跟着变。手写 `'(Ctrl+T)'` 的话，一改键位提示就开始骗人，而且只有改了键的
 *      那个人自己能发现。
 *   3. **一个进程里只有一份**。之前 `model-picker.ts` / `session-picker.ts` 各自
 *      `setKeybindings(KeybindingsManager.create())`，而那两份**不含**我们的动作 ——
 *      于是「打开过一次面板之后，轨迹那块提示变成空串」。现在只在这里创建。
 *
 * ## 与 pi 的 `ctrl+t`：本项目**现在也用**它（含义一致）
 *
 * pi 的 `ctrl+t` 是 `app.thinking.toggle`（展开/收起 thinking 块）。本项目早先把
 * 轨迹页切换也放在 `ctrl+t`，那正好撞在 pi 的键上：同一台机器上 pi 与 ela 用的是
 * **同一份** `~/.pi/agent/keybindings.json`，而 `ctrl+t` 在两边的含义不同 ——
 * 写覆盖的人没法表达「我想要哪个」。
 *
 * 所以轨迹页改用本项目自己的 `app.trace.toggle`（默认 `ctrl+r`）。
 *
 * `ctrl+t` 本身现在**补上了**：本项目也实现了「展开/收起思考块」，语义与 pi 完全相同，
 * 于是共用那份 `keybindings.json` 不再有歧义 —— 用户在 pi 那边把 `ctrl+t` 改成别的
 * 键，这边跟着变（反之亦然）。
 *
 * ## 用户覆盖
 *
 * 读 `~/.pi/agent/keybindings.json`（与 pi 同一个文件、同一套格式：
 * `{ "app.trace.toggle": "alt+r" }`，值也可以是数组给多个键）。用 pi 的
 * `migrateKeybindingsConfig()` 做旧名字迁移（`expandTools` → `app.tools.expand` 那套），
 * 所以两边认的是同一批历史写法。
 *
 * 读不到（文件不存在 / 坏 JSON / 没权限）就用全套默认值，**不抛** —— 键位是可选配置，
 * 不该让界面起不来。
 */
import {
  getKeybindings,
  setKeybindings,
  type KeyId,
  type KeybindingDefinitions,
  type KeybindingsConfig,
} from '@earendil-works/pi-tui';
import {
  KEYBINDINGS as PI_KEYBINDINGS,
  KeybindingsManager as PiKeybindingsManager,
  migrateKeybindingsConfig,
} from '@earendil-works/pi-coding-agent/dist/core/keybindings.js';
import { keyDisplayText } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/keybinding-hints.js';
import path from 'node:path';
import { configHome, readJsonIfExists } from '@ela/core/config-home';

/**
 * 本项目独有的动作 id。
 *
 * 声明给 pi-tui 的类型看 —— `matches()` / `getKeys()` 的参数是 `Keybinding`，而那个
 * 类型由 `tui.*` 的键与 pi 的 module augmentation（`app.*`）拼成。不加这一段，
 * `matches(data, 'app.trace.toggle')` 会在 typecheck 里报「不是 Keybinding」，
 * 而 cast 掉就失去下面 `PROJECT_KEYBINDINGS` 与调用点之间的关联检查（写错 id 时
 * 静默失效 —— 键一直不匹配，界面看着像「这个键没绑」）。
 */
declare module '@earendil-works/pi-tui' {
  interface Keybindings {
    'app.trace.toggle': true;
    'app.queue.cycle': true;
    'app.abort': true;
  }
}

/**
 * 本项目独有的动作。
 *
 * 只有**pi 没有对应语义**的动作才放这里 —— 能在 pi 的 `KEYBINDINGS` 里找到同义的
 * （展开工具输出 → `app.tools.expand`、打开模型面板 → `app.model.select`）就直接用
 * 它的 id，见文件头第 1 条。
 */
export const PROJECT_KEYBINDINGS = {
  /**
   * 轨迹页切换 —— 默认 `ctrl+r`。
   *
   * ## 为什么不接着用 `ctrl+t`
   *
   * 那是 pi 的 `app.thinking.toggle`，而两边共用一份 `keybindings.json`（见文件头）。
   *
   * ## 为什么是 `ctrl+r`
   *
   * 能用的单修饰 `ctrl+<字母>` 逐个排除之后剩下的：
   *
   *   - 编辑器自己的（`tui.editor.*`）：`ctrl+a/b/d/e/f/j/k/u/w/y/-/]` ——
   *     占了就等于抢走「行首 / 光标左移 / 删词」这些最基本的编辑动作。
   *   - pi 应用层的：`ctrl+g`（外部编辑器）、`ctrl+x`（复制）、`ctrl+v`（粘贴图片）、
   *     `ctrl+s`（存 thinking 级别）、`ctrl+z`（挂起）、`ctrl+p`（循环模型）——
   *     占了就是同一个键在两个应用里含义不同，同样没法用覆盖文件表达。
   *   - 本项目已用的：`ctrl+c`（中断）、`ctrl+o`（展开工具）、`ctrl+l`（模型面板）、
   *     `ctrl+q`（队列模式）。
   *
   * `ctrl+r` 是剩下里语义最贴的（pi 只在**会话面板内部**用它做重命名，而面板打开时
   * 本项目的全局键整个让路，两者不会同时生效），手感上也是「切一块视图」的常见键。
   *
   * 想换就用 `~/.pi/agent/keybindings.json`：
   *
   *     { "app.trace.toggle": "ctrl+shift+r" }
   */
  'app.trace.toggle': { defaultKeys: 'ctrl+r', description: '切换「对话 / 轨迹」两页' },
  /**
   * 切换入队模式（steer ↔ followUp）。
   *
   * 不复用 pi 的 `app.message.followUp`：那个是「把**这一条**消息排成 followUp」的
   * 一次性动作，而本项目是一个**模式开关** —— 切一次之后接下来的每条都按新列走。
   */
  'app.queue.cycle': { defaultKeys: 'ctrl+q', description: '切换入队模式（steer / followUp）' },
  /**
   * 中断当前回合；空闲时退出。
   *
   * ## 默认**不绑**（`[]`）—— 因为「冲突以 pi 为准」
   *
   * 早先它的默认键是 `ctrl+c`（一个键干两件事：跑着就中断、空闲就退出）。但 pi 的
   * `ctrl+c` 是 `app.clear`（清空编辑器，连按两次才退出），而两边共用一份
   * `keybindings.json` —— 同一个键在两个应用里含义不同时，写覆盖的人没法表达
   * 「我想要哪个」。按「完全复用 pi」这条线，`ctrl+c` 归 pi。
   *
   * 中断改由 pi 的 `app.interrupt`（默认 `escape`）承担；退出由 pi 的
   * `app.clear`（`ctrl+c` 两次）/ `app.exit`（`ctrl+d`）承担。
   *
   * ## 那这个 id 为什么还留着
   *
   * 它是本项目**一个键干两件事**的合体动作。有人可能就喜欢那个手感 —— 留着 id、
   * 默认不绑，写 `{ "app.abort": "ctrl+c" }` 就能拿回旧行为（那时它会把 `ctrl+c`
   * 从 pi 的 `app.clear` 那里抢回来，是用户显式的选择）。删掉 id 的话，这个覆盖无处可写。
   *
   * ## 与 `app.clear` 的分工（都在 `app.ts` 里）
   *
   * - `app.clear`（`ctrl+c`）：清空编辑器；500ms 内第二次 → 退出。
   * - `app.abort`（默认无）：跑着就中断，空闲就退出（旧手感）。
   */
  'app.abort': { defaultKeys: [], description: '中断当前回合（空闲时退出）—— 默认不绑，`Ctrl+C` 已归 pi 的「清空编辑器」' },
} as const satisfies KeybindingDefinitions;

/** pi 的 + 本项目的，合成一份定义表。 */
export const ALL_KEYBINDINGS: KeybindingDefinitions = {
  ...PI_KEYBINDINGS,
  ...PROJECT_KEYBINDINGS,
};

/** `~/.pi/agent/keybindings.json` —— 与 pi **同一个文件**（同一台机器只有一份键位）。 */
export function keybindingsPath(): string {
  return path.join(configHome(), 'keybindings.json');
}

/**
 * 读用户的键位覆盖。
 *
 * 形状是 `{ "<动作 id>": "ctrl+r" | ["ctrl+r", "alt+r"] }`。两件事与 pi 对齐：
 *
 *   - **旧名字迁移**用 pi 的 `migrateKeybindingsConfig()`（`expandTools` →
 *     `app.tools.expand` 那一批在 pi 那边维护，手抄会漂移）；
 *   - **只认字符串与字符串数组**（其余值丢掉），与 pi 的 `toKeybindingsConfig()` 同一规则 ——
 *     写了个 `true` / 对象进去时静默忽略，比让它进到 `normalizeKeys` 里崩掉好。
 *
 * 不做「未知 id」过滤：我们自己的三个 id 不在 pi 的 `KEYBINDINGS` 里，过滤掉它们
 * 就等于用户的覆盖对我们的动作永远不生效。真正的过滤发生在 `KeybindingsManager`
 * 内部（`if (!(keybinding in this.definitions)) continue`）—— 那才是权威的一份定义表。
 */
export function loadUserKeybindings(): KeybindingsConfig {
  let raw: Record<string, unknown> | null;
  try {
    raw = readJsonIfExists<Record<string, unknown>>(keybindingsPath());
  } catch {
    // 坏 JSON 与「没权限」都当「没配过」—— 与 pi 的 `loadRawConfig()` 一样**静默**。
    //
    // 为什么不报错：`config-home.ts` 的 `readJsonIfExists` 是**故意**抛的（models.json
    // 坏了必须说出来，否则症状是「一个 provider 都没有」），但键位不一样 —— 它只在
    // 「提示行怎么写」与「哪个键触发哪个开关」上起作用，退到默认值界面就是好的。
    // 而这里每次开面板/每帧提示都会调一次，报一次就会刷屏。
    return {};
  }
  if (raw === null) return {};
  const { config } = migrateKeybindingsConfig(raw);
  const out: KeybindingsConfig = {};
  for (const [action, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      out[action] = value as KeyId;
      continue;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      out[action] = value as KeyId[];
    }
  }
  return out;
}

/**
 * 含本项目动作的 keybindings 管理器。
 *
 * ## 为什么要继承 pi 的子类（而不是直接用 pi-tui 那个）
 *
 * pi 的 `SessionSelectorComponent` / `ModelSelectorComponent` 的构造参数类型是
 * **pi 那个子类**（多出 `configPath` / `reload()` / `getEffectiveConfig()` 三个成员）。
 * 传 pi-tui 的基类进去会在 typecheck 就报「缺三个属性」，而 cast 掉就等于把
 * 「组件到底要不要调 reload()」这个问题藏起来。
 *
 * ## 为什么构造完还要换定义表再 rebuild 一次
 *
 * pi 的子类把定义表**写死在构造函数里**（`super(KEYBINDINGS, userBindings)`），
 * 没有留口子。所以这里在 `super()` 之后把 `definitions` 换成我们那份
 * （pi 的全套 + `PROJECT_KEYBINDINGS`），再 `setUserBindings(同一份覆盖)` 触发一次
 * rebuild —— 构造函数里那次 rebuild 用的是 pi 的定义表，不重跑的话我们的三个动作
 * 查不到（`getKeys` 恒为空，键静默失效）。
 *
 * 字段是 `private`（TS 层面的封印，运行时就叫 `definitions`），所以这里 cast 一次。
 * **只此一处**，而且紧挨着这条注释 —— 换成别处再 cast 一次，将来 pi 改字段名时
 * 症状会是「键位静默失效」，很难归因。
 */
class ProjectKeybindingsManager extends PiKeybindingsManager {
  constructor(userBindings: KeybindingsConfig) {
    super(userBindings);
    (this as unknown as { definitions: KeybindingDefinitions }).definitions = ALL_KEYBINDINGS;
    this.setUserBindings(userBindings);
  }
}

/**
 * 建一份**含本项目动作**的 keybindings（不装到全局）。
 *
 * `keybindings.json` 只读一次（同一份覆盖对象同时喂给 `super()` 与换表后的 rebuild）。
 * 想「改完立刻生效」靠的是调用方：界面启动时与**每次开面板前**都会重新建一份
 * （`installProjectKeybindings()`），所以不需要重启，也不需要文件监听。
 */
export function createProjectKeybindings(): PiKeybindingsManager {
  return new ProjectKeybindingsManager(loadUserKeybindings());
}

/**
 * 装到 pi-tui 全局并返回它。
 *
 * **不缓存成单例**：用户编辑 `keybindings.json` 之后不需要重启（界面启动时与每个面板
 * 打开前都会调一次，重新读文件是刻意的）。
 *
 * 调用点都是为了同一个目的 —— `getKeybindings()` 是进程级全局，`keyDisplayText()`
 * 与 pi-tui 的组件（Editor / SelectList）都从它取键名。忘了装的症状是**提示行整行
 * 消失**（不是「按了没反应」），极难归因。
 */
export function installProjectKeybindings(): PiKeybindingsManager {
  const keybindings = createProjectKeybindings();
  setKeybindings(keybindings);
  return keybindings;
}

/**
 * 兜底用的那份（只在全局表里查不到这个动作时才用到）。
 *
 * 为什么需要：`getKeybindings()` 在没人装过时会**自己建**一份只含 `TUI_KEYBINDINGS`
 * 的默认表，那里面 `app.trace.toggle` 恒为空 —— 于是键静默失效。测试、以及「界面还
 * 没起来」的路径都会走到这里。
 *
 * 懒建 + 缓存：这条路径每次按键都会走（`actionMatches`），而 `loadUserKeybindings()`
 * 是同步读文件 —— 不能每帧读一次。
 */
let lazyFallback: PiKeybindingsManager | undefined;

function fallbackKeybindings(): PiKeybindingsManager {
  lazyFallback ??= createProjectKeybindings();
  return lazyFallback;
}

/** 取一个动作**当前生效**的键位表：全局那份里**定义过**就用它，否则用兜底那份。 */
function effectiveKeybindings(action: string): PiKeybindingsManager {
  const global = getKeybindings() as PiKeybindingsManager;
  // 判「定义过」而不是「解析出来的键非空」：用户可以把一个动作**解绑**（值写 `[]`），
  // 那时键是空的、但动作**是**被配置过的。按「键非空」判会让解绑的动作掉进兜底那份，
  // 于是 `/hotkeys` 又把它按默认键列出来 —— 一个刚被解绑的键还在表里，读的人会
  // 按着它试，然后发现没反应。
  const defined = global.getDefinition?.(action as never) !== undefined;
  return defined ? global : fallbackKeybindings();
}

/**
 * 这条输入是不是这个动作的键。
 *
 * 换掉裸的 `matchesKey(data, 'ctrl+o')` 之后，「按了没反应」这类症状会少一大类：
 * 用户写在 `keybindings.json` 里的覆盖真的生效，而提示行（`keyLabel`）说的是
 * 同一个来源 —— 改了键之后，按哪个键与屏幕上写着哪个键不会再分家。
 */
export function actionMatches(data: string, action: string): boolean {
  return effectiveKeybindings(action).matches(data, action as never);
}

/** 该动作**当前生效**的全部键（已解析用户覆盖）。 */
export function actionKeys(action: string): KeyId[] {
  return effectiveKeybindings(action).getKeys(action as never) as KeyId[];
}

/**
 * 动作的显示名（`Ctrl+R` / `Option+R`）—— 提示行与 `/hotkeys` 都用它。
 *
 * 走 `effectiveKeybindings()`（全局那份里没有这个动作时用兜底那份），所以
 * 三件事同时成立：用户改了键这里跟着变、全局表没装好时仍然有键名、
 * 面板中途重装键位表之后不会变成空串。
 *
 * **没有 `fallback` 参数**：动作 id 写错是**编程错误**（定义表里有它才算数），
 * 那时返回空串 —— 界面上表现为 `()`，是一眼能看出来的坏，而不是一个「看起来对、
 * 实际按不动」的键名。
 */
export function keyLabel(action: string): string {
  const installed = keyDisplayText(action as never);
  if (installed !== '') return installed;
  return actionKeys(action).map(formatKeyId).join('/');
}

/**
 * 把 `KeyId` 变成给人看的形状（`alt+r` → `Option+R` / `Alt+R`）。
 *
 * 与 pi 的 `keyDisplayText()` 同一套规则（`formatKeyText`）：`alt` 在 macOS 上显示成
 * `option`，每段首字母大写。手抄一份是为了 `keyLabel` 的兜底分支不依赖全局表 ——
 * 那一支存在的意义正是「全局表不可信」。
 */
export function formatKeyId(key: string): string {
  return key
    .split('/')
    .map((combo) =>
      combo
        .split('+')
        .map((part) => {
          const shown = process.platform === 'darwin' && part.toLowerCase() === 'alt' ? 'option' : part;
          return shown.charAt(0).toUpperCase() + shown.slice(1);
        })
        .join('+'),
    )
    .join('/');
}


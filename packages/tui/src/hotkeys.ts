/**
 * `/hotkeys` —— 键位表。**形状照抄 pi 的同名命令**：同样的分节（Navigation / Editing / Other /
 * Extensions）、同样的 Markdown 表格与边框标题。
 *
 * 照抄是因为读者是**从 pi 过来的人**，换一种排版不会更好读、却会让人以为是另一套键位；而且表格的
 * `Key` / `Action` 两列让「我该按哪个键」更好扫。
 *
 * 与 pi 唯一的刻意差别：键名全部**实时解析**（`keyLabel()` → `getKeybindings()`），所以改过
 * `keybindings.json` 之后显示的是新键；本项目的三个额外动作在同一份表里，同一套 `keyLabel()` 就够。
 *
 * 表格只列**真能按的**：pi 有而本项目确实没有的（会话树、fork、login/logout、trust、name…）不列 ——
 * 照抄过来会得到一份「按了没反应」的说明书，比少列几行坏得多。
 */
import {
  getMarkdownTheme,
  theme,
} from '@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { DynamicBorder } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/dynamic-border.js';
import { formatKeyText } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/keybinding-hints.js';
import { Markdown } from '@earendil-works/pi-tui';
import { keyLabel } from './keybindings';

/** 一个可以列进表里的键位行：给人看的键名 + 一句话动作。 */
interface HotkeyRow {
  /** 已经是给人看的形状（`Ctrl+R` / `Up`）。多个键用 ` / ` 连接。 */
  keys: string;
  action: string;
}

/**
 * 把一条 `tui.*` / `app.*` 动作展开成一行。
 *
 * 键名走本项目的 `keyLabel()`（它最终调 pi 的 `keyDisplayText()`：大写、macOS 上
 * `alt` 显示成 `option`），与顶行那个 `(Ctrl+R)`、与面板底部的提示行**同一个来源** ——
 * 三处不会漂移。
 */
function actionRow(action: string, description: string): HotkeyRow {
  return { keys: keyLabel(action), action: description };
}

/**
 * 一个**由一个 `KeyId` 对不上**的行：要么好几个动作挤在一格里，要么键名不是键位表里的。
 *
 * 典型是「一组键共同表示一个意思」那几行（`↑/↓/←/→` 共用一行、`PgUp/PgDn` 共用一行）。
 * `actionRow()` 只能表达单个动作 id，所以这里直接给最终文字，但用 `formatKeyText`
 * 而不是 `keyDisplayText`（后者拿不到 id 会得到空串）。
 *
 * 注意：**仍然要先过 `keyLabel()`** 拿解析后的键名，不能手写 `Ctrl+P` ——
 * 手写的键名在用户改了 `keybindings.json` 之后就开始骗人。
 */
function rawRow(keys: string, description: string): HotkeyRow {
  return { keys: formatKeyText(keys, { capitalize: true }), action: description };
}

/** Markdown 表格：`| Key | Action |`。 */
function table(rows: readonly HotkeyRow[]): string {
  const head = ['| Key | Action |', '|-----|--------|'];
  const body = rows
    // 键名为空的整行（例如用户的 keybindings.json 把某个动作解绑成 `[]`）**不出现在表里** ——
    // 一行「空键名 + 描述」看起来像是漏了字。
    .filter((row) => row.keys !== '')
    .map((row) => `| \`${row.keys}\` | ${row.action} |`);
  return [...head, ...body].join('\n');
}

/** 一段的表：`**小节名**` + 空行 + 表。 */
function section(title: string, rows: readonly HotkeyRow[]): string {
  return `**${title}**\n${table(rows)}`;
}

/** 扩展注册的快捷键（`/hotkeys` 的 `Extensions` 一节）。 */
export interface HotkeyExtension {
  key: string;
  description?: string | undefined;
}

/**
 * 拼出 `/hotkeys` 的 Markdown 正文（不含标题与边框 —— 那两样是渲染层的事）。
 *
 * 导出它是为了**测试**：断言可以盯「某个动作在不在、键名是不是解析出来的」，
 * 而不必去解析表格的框线字符。
 */
export function hotkeysMarkdown(extensions: readonly HotkeyExtension[] = []): string {
  const navigation: HotkeyRow[] = [
    // 形状与 pi 完全一致：一条「光标 / 历史」、一条「按词」、两条「行首行尾」、
    // 两条「跳字符」、一条「整页」。光标键与 `Up/Down` 共用一行的写法也照抄 ——
    // pi 的 `cursorUp` 那组的表意就是「上移 / 翻历史」两职合一。
    rawRow(
      `${keyLabel('tui.editor.cursorUp')} / ${keyLabel('tui.editor.cursorDown')} / ${keyLabel('tui.editor.cursorLeft')} / ${keyLabel('tui.editor.cursorRight')}`,
      '移动光标 / 翻输入历史',
    ),
    rawRow(
      `${keyLabel('tui.editor.cursorWordLeft')} / ${keyLabel('tui.editor.cursorWordRight')}`,
      '按词移动',
    ),
    actionRow('tui.editor.cursorLineStart', '行首'),
    actionRow('tui.editor.cursorLineEnd', '行尾'),
    actionRow('tui.editor.jumpForward', '跳到下一个字符'),
    actionRow('tui.editor.jumpBackward', '跳到上一个字符'),
    // 翻页用 pi 的 `tui.altScreen.*`（不是 `tui.editor.*`）：这两个键在 altScreen 模式下
    // 被 altScreen 的 input listener 先接走（构造时就注册了），滚的是 primary ScrollView
    // —— 也就是当前页。写 `tui.editor.pageUp` 的话键名虽然一样，但用户改它**不会**
    // 影响这里（真正生效的是 altScreen 那两个 id），那就成了「改键没反应」。
    rawRow(
      `${keyLabel('tui.altScreen.pageUp')} / ${keyLabel('tui.altScreen.pageDown')}`,
      '翻当前页（整页；半页的 `tui.altScreen.halfPageUp/Down` 默认没绑）',
    ),
  ];

  const editing: HotkeyRow[] = [
    actionRow('tui.input.submit', '发送'),
    actionRow('tui.input.newLine', '输入里换行（不发送）'),
    actionRow('tui.editor.deleteWordBackward', '删掉前一个词'),
    actionRow('tui.editor.deleteWordForward', '删掉后一个词'),
    actionRow('tui.editor.deleteToLineStart', '删到行首'),
    actionRow('tui.editor.deleteToLineEnd', '删到行尾'),
    actionRow('tui.editor.yank', '粘贴最近删掉的那段'),
    actionRow('tui.editor.yankPop', '在刚粘贴的几段之间轮换'),
    actionRow('tui.editor.undo', '撤销'),
  ];

  const other: HotkeyRow[] = [
    actionRow('tui.input.tab', '路径补全 / 接受补全项'),
    actionRow('app.interrupt', '取消补全 / 中断流式输出（有排队消息时先还回编辑器）'),
    actionRow('app.clear', '清空编辑器（连按两次退出）'),
    actionRow('app.exit', '退出（编辑器为空时）'),
    actionRow('app.suspend', '挂起到后台'),
    actionRow('app.thinking.cycle', '循环思考级别'),
    rawRow(`${keyLabel('app.model.cycleForward')} / ${keyLabel('app.model.cycleBackward')}`, '循环切换模型'),
    actionRow('app.model.select', '打开模型选择面板（Ctrl+S 存成默认）'),
    actionRow('app.tools.expand', '展开 / 收起工具输出的完整内容'),
    actionRow('app.thinking.toggle', '展开 / 收起思考块'),
    actionRow('app.editor.external', '用外部编辑器编辑当前输入'),
    actionRow('app.message.copy', '复制选区或最后一条助手消息'),
    actionRow('app.message.followUp', '把当前输入排成 follow-up（等这一轮说完再插）'),
    actionRow('app.message.dequeue', '把排队的消息还回输入框'),
    actionRow('app.clipboard.pasteImage', '粘贴文件路径 / 图片 / 文本'),
    // 本项目自己的开关（pi 没有对应语义，见 `PROJECT_KEYBINDINGS`）。
    // 排队那一列**不在这里** —— 与 pi 同一套：回车 = steer，`app.message.followUp`（上面那行）= followUp。
    actionRow('app.trace.toggle', '在「对话」与「轨迹」两页之间切换'),
    rawRow('/', '斜杠命令（再按 Tab 补全命令名）'),
  ];

  let out = [
    section('Navigation', navigation),
    section('Editing', editing),
    section('Other', other),
  ].join('\n\n');

  // 扩展的快捷键：pi 也是单独一节、也是最后加（见它的 `handleHotkeysCommand()`）。
  // 表里没有绑定就不出现这一节 —— 一个空表（只有表头）比没有更让人困惑。
  const extensionRows = extensions
    .map((shortcut) => ({
      // 扩展声明的是 `KeyId` 形状（`ctrl+shift+s`），与 pi 一样直接格式化。
      keys: formatKeyText(shortcut.key, { capitalize: true }),
      action: shortcut.description ?? '（扩展没写描述）',
    }))
    .filter((row) => row.keys !== '');
  if (extensionRows.length > 0) out += `\n\n${section('Extensions', extensionRows)}`;

  return out;
}

/**
 * 渲染成可直接塞进对话区的行。
 *
 * 形状与 pi 完全一致：
 *
 *     ──────────────────────────────   ← DynamicBorder
 *
 *      Keyboard Shortcuts              ← theme.bold(theme.fg('accent', …))，左缩进 1
 *
 *     （Markdown 表格）
 *     ──────────────────────────────
 *
 * 边框用 pi 的 `DynamicBorder` 而不是自己 `'─'.repeat(width)`：它按**视口宽度**画，
 * 而 `repeat(width)` 在「终端比渲染时的宽度更宽」时会短一截（pi-tui 的增量重绘会把
 * 那一截旧内容留在屏幕上）。
 *
 * 标题用的 `theme` 是 pi 的那个 globalThis Proxy —— 只在本函数里读，而它只在
 * `/hotkeys` 那条命令里被调（界面早就起来了、`setupTheme()` 早就跑过）。
 */
export function renderHotkeys(width: number, extensions: readonly HotkeyExtension[] = []): string[] {
  const usable = Math.max(20, width);
  const border = new DynamicBorder();
  const markdown = new Markdown(hotkeysMarkdown(extensions), 1, 1, getMarkdownTheme());
  return [
    ...border.render(usable),
    '',
    ` ${theme.bold(theme.fg('accent', 'Keyboard Shortcuts'))}`,
    '',
    ...markdown.render(usable),
    ...border.render(usable),
  ];
}

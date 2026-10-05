/**
 * TUI 的「恢复历史」弹窗 —— `/sessions` 打开。
 *
 * 为什么是弹窗而不是别的：历史会话可能几十条，命令行里用文字菜单翻页很别扭；
 * `SelectList` 自带过滤（输入即筛）+ 上下键 + 回车，跟 pi 自己的 `/resume` 一个交互。
 *
 * 弹窗是**覆盖层**（overlay），不参与主布局 —— 关掉后主界面原样恢复，不需要重建。
 */
import { SelectList, Text, type SelectItem, type TuiInputListener, type ViewportTUI } from '@earendil-works/pi-tui';
import { listSessions, type SessionSummary } from '../config-home';
import { readSessionMessages, sessionTitle } from '../session-file';

const useColor = !process.env.NO_COLOR;
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (t: string) => paint('2', t);
const cyan = (t: string) => paint('36', t);
const bold = (t: string) => paint('1', t);

/** 相对时间（「3 分钟前」）；超过 7 天就显示日期。 */
function whenLabel(mtimeMs: number, now = Date.now()): string {
  const diff = now - mtimeMs;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(mtimeMs).toISOString().slice(0, 10);
}

export interface SessionPickerOptions {
  tui: ViewportTUI;
  /** 选定了某个会话。 */
  onPick(session: SessionSummary): void;
  /** Esc 关闭。 */
  onCancel?(): void;
}

/**
 * 打开历史会话选择弹窗。
 *
 * @returns 弹窗的关闭函数（调用方可提前关掉，比如恢复完成后重建界面）。
 */
export function openSessionPicker(options: SessionPickerOptions): () => void {
  const { tui } = options;
  const sessions = listSessions();

  if (sessions.length === 0) {
    // 没有历史时给个提示，而不是弹一个空列表让人困惑。
    const empty = new Text([bold('没有历史会话'), '', dim('聊过的对话会存在 '), dim('~/.redux-agent/sessions/'), dim('')] as unknown as string, 0, 1);
    const handle = tui.showOverlay(empty, { anchor: 'center', width: 60, maxHeight: 6, nonCapturing: true });
    return () => handle.hide();
  }

  const items: SelectItem[] = sessions.map((s) => ({
    value: s.id,
    label: sessionTitle(s.file),
    // 副标题：时间 + cwd 末段 + 条数 —— 光看标题分不清是哪次。
    description: `${whenLabel(s.mtimeMs)}  ${dim(shortCwd(s.cwd))}  ${dim(`${s.entries} 条`)}`,
  }));

  const theme = {
    selectedPrefix: (s: string) => cyan('❯ '),
    selectedText: (s: string) => bold(s),
    description: (s: string) => s,
    scrollInfo: (s: string) => dim(s),
    noMatch: (s: string) => dim(s),
  };

  const list = new SelectList(items, Math.min(15, items.length), theme);
  const handle = tui.showOverlay(list, {
    anchor: 'center',
    width: 90,
    maxHeight: Math.min(20, items.length + 4),
  });

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    handle.unfocus?.();
    handle.hide();
  };

  list.onSelect = (item) => {
    close();
    const found = sessions.find((s) => s.id === item.value);
    if (found) options.onPick(found);
  };
  list.onCancel = () => {
    close();
    options.onCancel?.();
  };

  // 弹窗内的按键：Esc 关闭。回车/上下键由 SelectList 自己处理（它实现了输入监听）。
  const onKey: TuiInputListener = (data) => {
    if (data === '\x1b') {
      close();
      options.onCancel?.();
      return { consume: true };
    }
    return undefined;
  };
  handle.focus();

  return close;
}

/** cwd 太长时只留最后两段。 */
function shortCwd(cwd: string): string {
  if (!cwd) return '(未知目录)';
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `…/${parts.slice(-2).join('/')}`;
}

/** 读一个会话的消息（供调用方恢复）。 */
export function loadSessionMessages(session: SessionSummary) {
  return readSessionMessages(session.file);
}

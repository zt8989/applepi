/**
 * Web 端的斜杠命令。
 *
 * ## 为什么要在浏览器侧处理
 *
 * TUI 有 `/sessions`、`/new` 等界面命令；Web 也该有。但它们**不是给模型的话** ——
 * 是给界面/内核的管理动作。所以不能 POST `/api/message`（那会当成用户消息发给模型）。
 *
 * 拦截点是 `remote-session.prompt()`：它是输入的**唯一**出口，在那一处判 `/` 前缀即可，
 * 不用去碰 pi-web-ui 的组件内部（它是个黑盒，也不该为这个改它）。
 *
 * ## 与 TUI 的关系
 *
 * 两边的命令表**各自一份**：TUI 那份在 `src/tui/app.ts`（要喂 pi-tui 的补全器），
 * 这份要喂浏览器的补全层。交集是「名字与语义」，重复几行字符串比跨端共享一份表更省事
 * —— 真要共享得先有个两边都认的中立位置，目前不值得。
 */
import { cleanAllSessions, listSessions, type SessionSummary } from './session-client';

export interface WebCommand {
  name: string;
  description: string;
  /** 执行。返回一行提示（显示在输入框旁），或 null 表示没说什么。 */
  run(context: CommandContext, args: string): Promise<string | null>;
}

export interface CommandContext {
  /** 开新会话（走内核，换文件）。 */
  newSession(): Promise<{ id: string }>;
  /** 恢复一个历史会话。 */
  restoreSession(session: SessionSummary): Promise<void>;
  /** 打开历史会话选择弹窗。 */
  openSessionPicker(): Promise<void>;
  /**
   * 清掉除当前会话外的全部历史会话（用户已经在界面上确认过了）。
   *
   * 为什么交给宿主而不是命令自己 fetch：清理是**不可逆**的，得先弹窗确认，
   * 弹窗与确认框都在 main.ts 里，命令不该自己去摸 DOM。
   */
  cleanSessions(): Promise<string>;
  /** 在界面上显示一行提示（不发给模型）。 */
  notify(text: string): void;
}

export const WEB_COMMANDS: WebCommand[] = [
  {
    name: 'sessions',
    description: '恢复历史会话（弹窗选择，零 token 不重跑模型）',
    async run(context) {
      await context.openSessionPicker();
      return null;
    },
  },
  {
    name: 'new',
    description: '开新会话（换文件；上一段仍留在 sessions/ 里）',
    async run(context) {
      const created = await context.newSession();
      return `已开新会话 ${created.id}`;
    },
  },
  {
    name: 'clean',
    description: '**删除**除当前会话外的全部历史会话（不可逆）',
    async run(context) {
      return context.cleanSessions();
    },
  },
  {
    name: 'wipe',
    description: '同 /clean',
    async run(context) {
      return context.cleanSessions();
    },
  },
  {
    name: 'forget',
    description: '开新会话（换文件；上一段仍留在 sessions/ 里）',
    async run(context) {
      const created = await context.newSession();
      return `已开新会话 ${created.id}`;
    },
  },
  {
    name: 'help',
    description: '列出全部命令',
    async run(context) {
      context.notify(WEB_COMMANDS.map((c) => `/${c.name}  ${c.description}`).join('\n'));
      return null;
    },
  },
];

/** 按前缀过滤（补全列表用）。`/se` → sessions。 */
export function matchCommands(prefix: string): WebCommand[] {
  const query = prefix.replace(/^\//, '').toLowerCase();
  if (query === '') return WEB_COMMANDS;
  return WEB_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(query));
}

/**
 * 处理一条输入：是命令就跑命令，否则返回 null（调用方应该把它当普通消息发出去）。
 *
 * 只认**整条输入以 `/` 开头**且命令名在表里 —— `/usr/bin 是路径` 这种不该被当成命令。
 */
export async function runCommand(
  text: string,
  context: CommandContext,
): Promise<{ handled: boolean; message?: string | null }> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { handled: false };

  const [name = '', ...rest] = trimmed.slice(1).split(/\s+/);
  const command = WEB_COMMANDS.find((c) => c.name === name.toLowerCase());
  if (!command) {
    // 认不出来就**不**当命令：可能是用户在说「/etc 下…」之类。
    // 但若输入很短又像是想敲命令（无空格），给个提示更友好。
    if (rest.length === 0) {
      context.notify(`未知命令 /${name}。输入 / 看列表，或 /help`);
      return { handled: true };
    }
    return { handled: false };
  }

  const message = await command.run(context, rest.join(' '));
  return { handled: true, message };
}

export { listSessions, type SessionSummary };

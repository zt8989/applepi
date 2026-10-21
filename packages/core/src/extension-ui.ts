/**
 * `ctx.ui` 的宿主实现 —— 扩展界面能力的**唯一**接缝。
 *
 * 两块能力。第一块是 `custom()`（把扩展自己的组件铺进来、拿焦点，答完或 ESC 后 resolve）。
 * 它有两种形态，pi 两种都实现：
 *
 * | `custom()` 的参数 | pi 的落点 | 本项目的落点 |
 * | --- | --- | --- |
 * | `{ overlay: true }` | `ui.showOverlay()`（自己抢焦点，`hide()` 还焦点） | 同一个 |
 * | 不给 / `{ overlay: false }` | 换掉 `editorContainer` 里的 composer | 同一个槽位 |
 *
 * inline 那条路必须支持：`ask_user_question` 2.13 起**默认**走 inline（Pi 的 editor slot），
 * overlay 只在「已经有另一个浮层」时降级用 —— 宿主得提供 `mountEditorSlot` 把组件放进输入区
 * 那一格，否则那个扩展在本项目里必挂。
 *
 * 第二块是 `select` / `confirm` / `input` 与问卷：前三个走 `raceDialog`（**两端各出一份、谁先
 * 回答谁算数** —— 终端那份由 `tuiDialogs` 挂进同一个输入区槽位，浏览器那份由 `DialogHost` 发
 * 过去）；问卷另走 `externalQuestionnaire`（见 `questionnaire.ts`）。
 *
 * 刻意**不接**：`setFooter` / `setHeader`（那要接 pi 的应用层布局）。
 *
 * **没实现的方法一律 reject，不静默 no-op**：一个 `select()` 静默 resolve `undefined` 的话，
 * 扩展会把「用户没选」当成真的答复发回模型 —— 模型拿着假答案继续干活，人还不知道。`undefined`
 * 在 pi 的契约里明确表示「用户取消了」，给假值等于撒谎。
 *
 * 「有没有界面」由外面决定：一次性模式与测试里不造这个对象（`extension-host.ts` 不绑 UI），
 * 于是 `ctx.hasUI` 为 false、扩展自己走 `no_ui` 分支。假装有界面只会让非交互运行卡在一个没人
 * 能回答的对话框上。
 */
import type { Component, TUI, TuiInputListener, OverlayOptions } from '@earendil-works/pi-tui';
import { getKeybindings, isKeyRelease, Text } from '@earendil-works/pi-tui';
import type {
  ExternalQuestionnaireBridge,
  ExternalQuestionnaireHandoff,
  OpenQuestionnaireView,
  QuestionnaireHost,
  QuestionnaireIntent,
  QuestionnaireSnapshot,
} from './questionnaire';
// Theme 是 pi 自己的（挂在 globalThis 上的 Proxy + 一堆 `fg`/`bg`/`bold` 方法），
// 不在 pi-tui 里 —— 与 `tui/app.ts` 里 `setupTheme()` 返回的是同一个类型。
import type { Theme } from '@earendil-works/pi-coding-agent';

/** 扩展的 custom 工厂签名（与官方 `ExtensionUIContext.custom` 逐字同形）。 */
export type CustomFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: ReturnType<typeof getKeybindings>,
  done: (result: T) => void,
) => (Component & { dispose?: () => void }) | Promise<Component & { dispose?: () => void }>;

export interface CustomOptions {
  overlay?: boolean;
  overlayOptions?: OverlayOptions | (() => OverlayOptions);
  onHandle?: (handle: unknown) => void;
}

/**
 * 官方对话框方法的选项（`ExtensionUIDialogOptions` 里我们用得到的两个）。
 *
 * 官方那个类型每个方法还带 `timeout`；本项目**不用**它（没人调），所以不收。
 */
export interface DialogOptions {
  signal?: AbortSignal | undefined;
}

/**
 * **终端侧**的原生对话框（`select` / `confirm` / `input`）。
 *
 * 由 TUI 提供（`app.ts` 的 `tuiDialogs`），**不在 core 里造组件**：那三个组件在
 * pi-coding-agent 的交互层，core 静态引它等于把所有运行模式（含一次性 `-p`、测试）
 * 都拖进 TUI 组件图。三个方法都返回「拆台」函数。
 */
export interface TuiDialogs {
  select(title: string, options: readonly string[], done: (value: string | undefined) => void): () => void;
  confirm(title: string, message: string, done: (value: boolean) => void): () => void;
  input(title: string, placeholder: string | undefined, done: (value: string | undefined) => void): () => void;
}

/**
 * 浏览器侧问卷视图的手柄：推新快照 / 关掉。
 *
 * `close()` 是"拆掉弹窗"，**不是**"取消问卷" —— 取消是用户的一个意图，走 `onIntent`。
 */
export interface QuestionnaireViewHandle {
  push(snapshot: QuestionnaireSnapshot): void;
  close(): void;
}

/** 浏览器侧的问卷视图（多题 tab 那份快照的渲染器）。 */
export interface QuestionnaireView {
  open(
    snapshot: QuestionnaireSnapshot,
    onIntent: (intent: QuestionnaireIntent) => void,
  ): QuestionnaireViewHandle;
}

/**
 * **浏览器侧**的对话框宿主（`web/bridge.ts` 实现）。
 *
 * `available()` 是「现在有浏览器连着吗」—— 没有就只剩终端那一份。每个调用带一个
 * `signal`：先回答的那一端赢，另一端据此把弹窗撤掉。
 */
export interface DialogHost {
  available(): boolean;
  select(title: string, options: readonly string[], signal: AbortSignal): Promise<string | undefined>;
  confirm(title: string, message: string, signal: AbortSignal): Promise<boolean>;
  input(title: string, placeholder: string | undefined, signal: AbortSignal): Promise<string | undefined>;
  /**
   * 问卷那一档（可缺省）：与 `select/input` 的区别是"它不是一问一答" —— 一次开一份
   * 多题的表，用户在里面左右切题、统一提交。中途的每一次变化都由服务端 push 给它们。
   *
   * 不给的时候（没有浏览器一侧的宿主、旧桥）问卷就只剩终端那块屏 —— 仍然能用。
   */
  questionnaire?: QuestionnaireView | undefined;
}

/** 扩展能用的界面能力（比官方的 `ExtensionUIContext` 窄：只留真的能做的）。 */
export interface ExtensionHostUi {
  custom<T>(factory: CustomFactory<T>, options?: CustomOptions): Promise<T>;
  /**
   * **问卷的浏览器那一份**（扩展补丁里的接缝，见 `patches/`）。
   *
   * `ask_user_question` 在画它自己那份终端组件之前调这里，把归一化后的题目交出来；
   * 我们拿它开浏览器那份弹窗。谁先答都算数：浏览器先答走 `handoff.answer`（扩展那边
   * 收掉自己的组件），终端先答走扩展 finally 里的 `done()`（我们收掉浏览器那份）。
   *
   * 返回的 `done` 就是"终端那一份结束了"的入口。
   */
  externalQuestionnaire?(handoff: ExternalQuestionnaireHandoff): ExternalQuestionnaireBridge;
  /**
   * 选项列表对话框。**终端与浏览器各出一份，谁先回答谁算数**。
   *
   * 两端都可用是刻意的：终端那边在看、浏览器那边在点，都可能先给出答案。
   * 两端都没有（一次性 `-p`、纯探测宿主）→ reject —— 与这里其他方法同一口径（不静默给假值）。
   */
  select(title: string, choices: readonly string[], dialogOptions?: DialogOptions): Promise<string | undefined>;
  /** 是非题。终端是 `Yes` / `No` 两个选项。 */
  confirm(title: string, message: string, dialogOptions?: DialogOptions): Promise<boolean>;
  /** 单行文本输入。取消给 `undefined`。 */
  input(title: string, placeholder?: string, dialogOptions?: DialogOptions): Promise<string | undefined>;
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
  /**
   * 活的 pi theme 对象。
   *
   * **官方 `ExtensionUIContext` 真的有这个成员**，而扩展会直接读它：
   * `pi-web-access` 的活动面板开头就 `ctx.ui.theme.fg('accent', …)`。
   * 少了它那个面板一开就 `Cannot read properties of undefined (reading 'fg')`。
   *
   * 给的就是 `setupTheme()` 返回的那个 globalThis 上的 Proxy，所以扩展画的颜色与
   * 本项目界面**完全一致**。
   */
  readonly theme: Theme;
  /** raw 终端输入（`ask_user_question` 靠它实现「浮层折叠后还能复原」）。 */
  onTerminalInput(handler: (data: string) => undefined | { consume?: boolean }): () => void;
  /**
   * 设终端标题（pi 的 `ctx.ui.setTitle`）。
   *
   * Orca 的**标题 spinner** 扩展就靠它：把 `π ✳ <名字> - <目录>` 写进终端标题，
   * Orca 从标题里读出「在工作 / 需要输入」那个标记。不实现的话 spinner 自己降级
   * （它 `typeof setTitle === 'function'` 先判一刀），不报错。
   */
  setTitle(title: string): void;
  /**
   * 替换输入框里的文字（pi 的 `ctx.ui.setEditorText`）。
   *
   * Orca 的 prefill 扩展用它把「刚开的那句提示词」填进 composer。
   * 宿主没有输入区时**抛**（与 `custom()` 的非 overlay 那条路同一口径：不假装能做）。
   */
  setEditorText(text: string): void;
  /**
   * 底栏里的一个**状态段**（pi 的 `ctx.ui.setStatus(key, text)`）：按 key 存，同一个 key 再设
   * 就是替换，`undefined` / 空串就是清掉那一格。
   *
   * `pi-background-tasks` 每次任务状态变化都无条件调它：少了这个成员那一步就抛
   * `ctx.ui.setStatus is not a function`，它在自己的 catch 里把 `currentCtx` 清成 undefined ——
   * 于是**之后所有后台任务事件都不再更新界面**。`pi-subagents` 的 `/agents` 面板同理。
   *
   * 宿主没有底栏时**丢掉**而不是抛：状态段只是显示，丢一条不该把整轮对话带崩。
   */
  setStatus(key: string, text: string | undefined): void;
  /**
   * 工具输出是否全部展开（pi 的 `ctx.ui.getToolsExpanded`）。
   *
   * `pi-subagents` 的面板用它决定自己那份转录要不要展开（`ui.getToolsExpanded?.()` 判一刀，
   * 没有就默认 false）—— 所以缺了它不会报错，但 `setToolsExpanded` 那边**不是可选的**：
   * `executeSubagentCollapsed()` 在 `hasUI` 时**无条件** `ctx.ui.setToolsExpanded(false)`，
   * 缺了就是「跑 subagent 的那一刻挂掉」。两个一起给（与 pi 一致）。
   */
  getToolsExpanded(): boolean;
  /** 设工具输出的展开状态（`app.tools.expand` 那个开关的同一个值）。 */
  setToolsExpanded(expanded: boolean): void;
}

export interface HostUiOptions {
  tui: TUI;
  theme: Theme;
  /** raw input 的注册口（pi-tui 的 `addInputListener`）。 */
  addInputListener(listener: TuiInputListener): () => void;
  /**
   * 底栏状态段的落点（`ctx.ui.setStatus`）。
   *
   * **可缺省**：没有底栏的宿主（测试探针、一次性模式）不提供它，于是那条状态段
   * 被丢掉 —— 扩展的后台任务照跑，只是没那一行提示。
   *
   * 传进来的 `text` 已经是「清洗过的单行文本」（换行／制表符／连续空格都压掉了，
   * 见 `sanitizeStatusText()`）：底栏是固定行数的，一个含 `\n` 的状态会把布局撑歪。
   */
  setStatus?(key: string, text: string | undefined): void;
  /**
   * 工具输出是否全部展开（`getToolsExpanded` / `setToolsExpanded` 的落点）。
   *
   * **可缺省**：探针 / 一次性模式没有「展开」这一说，于是读回来 `false`、设了就丢掉 ——
   * 两者都不抛（`pi-subagents` 在 `hasUI` 时会无条件设它，抛一次就整个 subagent 跑不起来）。
   */
  getToolsExpanded?(): boolean;
  setToolsExpanded?(expanded: boolean): void;
  /** 扩展的提示写进哪里（界面 `notify()` 插的那张命令反馈卡）。 */
  onNotice(text: string): void;
  /**
   * 放一块内容到输入区上方（`setWidget` 的落点）。
   *
   * 界面实现：它把组件塞进底部 VStack 里 editor 上面那格，并重设布局。
   *
   * **可缺省**：没有界面的宿主（测试、探针）不提供它，于是 `setWidget` 变成
   * 「把内容丢掉」而不是抛 —— 扩展的 widget 只是不显示，其余照常。
   */
  setWidget?(
    key: string,
    component: (Component & { dispose?: () => void }) | undefined,
    options?: { placement?: 'aboveEditor' | 'belowEditor' },
  ): void;
  /**
   * 「输入区槽位」—— pi 的 `editorContainer` 语义的落点：`custom({ overlay: false })`
   * 把扩展组件**换掉 composer 那一格**（而不是盖在屏幕上）。
   *
   * `component === undefined` = 还回 composer 本身（焦点也跟着回去，见界面那边）。
   *
   * **可缺省**：没有布局的宿主（测试探针、界面还没起来时的占位）不提供它。
   * 于是非 overlay 的 `custom()` 变成**明确报错**，而不是「假装挂上了」—— 后者
   * 的症状是「扩展在等一个永远不会出现的界面」，最难查。
   */
  mountEditorSlot?(component: (Component & { dispose?: () => void }) | undefined): void;
  /**
   * 把 composer 里的文字换成这个（`ctx.ui.setEditorText` 的落点）。
   *
   * **可缺省**：没有输入区的宿主（测试探针、一次性模式）不提供它 —— 那时
   * `setEditorText` 明说用不了，而不是静静地把字丢掉。
   */
  setEditorText?(text: string): void;
  /**
   * 终端侧的原生对话框（`select` / `confirm` / `input`）。TUI 提供；不给 = 这个宿主
   * 只有浏览器那一份（或什么都没有）。
   */
  tuiDialogs?: TuiDialogs | undefined;
  /**
   * 浏览器侧的对话框宿主。**取值而不是常量** —— 桥创建得比 UI 晚（见 main.ts），
   * 所以这里每次用时现读。不给 = 这个宿主没有浏览器一侧。
   */
  dialogs?: (() => DialogHost | undefined) | undefined;
  /**
   * 问卷在**浏览器**里的那一份视图（终端那一份由扩展自己的组件画 —— 见
   * `questionnaire.ts` 文件头）。返回拆台函数。
   *
   * 与 `tuiDialogs` / `dialogs` 同一类接缝：**core 定接口，界面实现**。给它的理由与
   * `custom()` 一样 —— core 不建组件（那会把 pi-tui 拖进所有运行模式）。
   *
   * **可缺省**。不给 = 没有浏览器那一份（终端那份照旧，扩展自己画）。
   */
  questionnaire?: OpenQuestionnaireView | undefined;
}

/**
 * 一次对话框：**终端与浏览器各来一份，谁先回答谁算数**。
 *
 * 先回答的那一端赢，另一端立刻撤掉（终端组件卸下 / 浏览器弹窗收到 `ui-cancel`）。
 */
function raceDialog<T>(options: {
  tui?: ((done: (value: T | undefined) => void) => () => void) | undefined;
  browser?: ((signal: AbortSignal) => Promise<T | undefined>) | undefined;
  signal?: AbortSignal | undefined;
  missing: () => Error;
}): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    let settled = false;
    const controller = new AbortController();
    let teardownTui: (() => void) | undefined;
    const finish = (value: T | undefined): void => {
      if (settled) return;
      settled = true;
      try {
        teardownTui?.();
      } catch {
        // 拆台失败不该把用户的答复丢掉。
      }
      controller.abort();
      resolve(value);
    };
    if (options.tui === undefined && options.browser === undefined) {
      reject(options.missing());
      return;
    }
    if (options.signal?.aborted === true) {
      finish(undefined);
      return;
    }
    options.signal?.addEventListener('abort', () => finish(undefined), { once: true });
    teardownTui = options.tui?.(finish);
    // 浏览器那条路出错（连接断了）就当成「这一端没答」—— **不**把整次对话报成失败，
    // 终端那份还开着。
    void options.browser?.(controller.signal).then(finish, () => finish(undefined));
  });
}

function noticePrefix(type: string | undefined): string {
  if (type === 'error') return '[扩展] ';
  if (type === 'warning') return '[扩展警告] ';
  return '[扩展] ';
}

/**
 * 底栏状态段的**单行化**（与 pi 的 `footer.js` 里那个同名函数逐字同形）。
 *
 * 换行 / 制表符 / 回车换成空格，连续空格压成一个，两头 trim。
 * **ANSI 保留**：扩展自己上了色（`pi-background-tasks` 是 `lightBlue(label)`），
 * 那是它要的形态，抹掉反而会与 pi 上的样子不一致。
 *
 * 为什么必须做：底栏在本项目里是**固定行数**的（`FOOTER_ROWS`），一个含 `\n` 的
 * 状态会把底栏撑成三行 —— 多出来的那行被裁掉，看上去就是「字丢了一半」。
 */
export function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim();
}

/**
 * 造一个 `ctx.ui`。
 *
 * 参数是**惰性**的（`() => options`）：内核装扩展时界面还没起来，早先在这里就求值会拿到空的
 * `uiRef.current`，扩展第一次访问 `ctx.ui` 就在自己渲染里炸，而栈里没有本项目的帧。每次用的时候
 * 才求值：内核拿到一个当场能用的壳（`hasUI` 为 true，与 pi 一致），真的要 TUI 的方法在被调时
 * 才读引用。
 *
 * 焦点由 pi-tui 管：`showOverlay` 抢焦点、`hide()` 还焦点。所以 `custom()` **必须**在 `done()`
 * 里 `handle.hide()` —— 不 hide 的话浮层永远挂在 overlay 栈上、输入回不到编辑器。
 */
export function createHostUi(
  source: () => HostUiOptions,
  /**
   * 问卷宿主（题目与答案的那份状态）。内核装配时造、**同一个**同时给工具层与这里。
   *
   * 为什么是参数而不是 `HostUiOptions` 的成员：它属于**内核**（工具入参是内核递给我们的），
   * 而 `HostUiOptions` 是界面层填的。界面只负责"视图"（`questionnaire` 那一项）。
   */
  questionnaire?: QuestionnaireHost | undefined,
): ExtensionHostUi {
  const keybindings = getKeybindings();

  /** 读界面。界面还没起来时明说，而不是拿 undefined 去用。 */
  const live = (): HostUiOptions => {
    const options = source();
    if (!options.tui) throw new Error('扩展要开界面，但界面还没起来（tui 未就绪）');
    return options;
  };

  return {
    /**
     * theme **不走 `live()`**：它只是读 globalThis 上的 Proxy，而 `setupTheme()` 一调
     * 就一直在了 —— 比界面起来得**早得多**。
     *
     * 这一点是必须的（而不是讲究）：扩展在**界面起来之前**就可能碰 `ctx.ui.theme`
     * （内核装扩展时 `setUIContext` 已经把 UI 绑上了）。`live()` 会因为 `tui` 是
     * undefined 而抛「扩展要求界面」—— 于是扩展的活动面板一开就把**整轮对话**带崩，
     * 而那个栈里**一帧本项目的代码都没有**。
     */
    get theme(): Theme {
      return source().theme;
    },

    custom: async <T>(factory: CustomFactory<T>, opts?: CustomOptions): Promise<T> => {
      // 读界面：界面还没起来时**明说**（`live()` 抛），而不是拿 undefined 去用。
      const { tui, theme } = live();
      const overlay = opts?.overlay === true;
      // 非 overlay 要顶掉 composer 那一格 —— 宿主没有槽位就只能明说不行。
      const mountEditorSlot = source().mountEditorSlot;
      if (!overlay && mountEditorSlot === undefined) {
        throw new Error(
          '本宿主没有输入区槽位，只支持 overlay 形式的扩展界面（custom({ overlay: true })）',
        );
      }
      return new Promise<T>((resolve, reject) => {
        let handle: { hide: () => void } | undefined;
        let component: (Component & { dispose?: () => void }) | undefined;
        let settled = false;
        /** 拆台：overlay 收浮层 / inline 还回 composer。与 pi 的 `close` 同一顺序。 */
        const teardown = (): void => {
          try {
            if (overlay) handle?.hide();
            else mountEditorSlot?.(undefined);
          } catch {
            // 收尾失败不该让用户的答复丢掉。
          }
        };
        const close = (result: T): void => {
          if (settled) return;
          settled = true;
          // 先拆台再 resolve：扩展的 `done` 之后通常立刻返回给模型，
          // 那条路上还可能再开别的浮层 —— 焦点得先归位。
          teardown();
          try {
            component?.dispose?.();
          } catch {
            // 同上。
          }
          resolve(result);
        };
        void Promise.resolve(factory(tui, theme, keybindings, close)).then(
          (c) => {
            if (settled) {
              // 扩展在 resolve 之后才交出组件（极少见）。那它永远不会被关掉，
              // 于是这个槽位会一直占着输入 —— 立刻拆掉。
              try {
                c.dispose?.();
              } catch {
                /* 忽略 */
              }
              return;
            }
            component = c;
            if (!overlay) {
              // inline：换掉 composer 那一格。**不给 `onHandle`** —— 与 pi 一致
              // （inline 没有浮层栈可弹，也就没有可复原的 `setHidden`；扩展据此
              // 把折叠退化成一行可见的提示，见它的 `canReopenWhileHidden`）。
              mountEditorSlot?.(c);
              return;
            }
            const resolveOptions = opts?.overlayOptions;
            handle = tui.showOverlay(
              c,
              typeof resolveOptions === 'function' ? resolveOptions() : resolveOptions,
            );
            // `onHandle` 在 showOverlay **之后**调 —— 与 pi 一致（扩展的折叠那条路
            // 要靠 handle.setHidden，而那时组件已经在栈上了）。
            opts?.onHandle?.(handle);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            // 工厂抛了 = 什么都没挂上；但 inline 那条路可能已经把 composer 换掉过
            // （不会：换是在工厂 resolve 之后）。仍然照 pi 还一次，代价是一次重排。
            teardown();
            reject(error);
          },
        );
      });
    },

    select: (title, options, opts) => {
      const host = source();
      const browser = host.dialogs?.();
      return raceDialog<string>({
        ...(host.tuiDialogs !== undefined
          ? { tui: (done: (value: string | undefined) => void) => host.tuiDialogs!.select(title, options, done) }
          : {}),
        ...(browser?.available() === true
          ? { browser: (signal: AbortSignal) => browser.select(title, options, signal) }
          : {}),
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        missing: () => new Error('本宿主没有可用的对话框（终端与浏览器都没有）'),
      });
    },

    confirm: (title, message, opts) => {
      const host = source();
      const browser = host.dialogs?.();
      return raceDialog<boolean>({
        ...(host.tuiDialogs !== undefined
          ? {
              tui: (done: (value: boolean | undefined) => void) =>
                host.tuiDialogs!.confirm(title, message, (value) => done(value)),
            }
          : {}),
        ...(browser?.available() === true
          ? { browser: (signal: AbortSignal) => browser.confirm(title, message, signal) }
          : {}),
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        missing: () => new Error('本宿主没有可用的对话框（终端与浏览器都没有）'),
      }).then((value) => value === true);
    },

    input: (title, placeholder, opts) => {
      const host = source();
      const browser = host.dialogs?.();
      return raceDialog<string>({
        ...(host.tuiDialogs !== undefined
          ? {
              tui: (done: (value: string | undefined) => void) =>
                host.tuiDialogs!.input(title, placeholder, done),
            }
          : {}),
        ...(browser?.available() === true
          ? { browser: (signal: AbortSignal) => browser.input(title, placeholder, signal) }
          : {}),
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        missing: () => new Error('本宿主没有可用的对话框（终端与浏览器都没有）'),
      });
    },

    notify: (message: string, type?: 'info' | 'warning' | 'error') => {
      // notify **不用** `live()`：扩展的提示在界面起来之前也该能出（而不是把一条
      // 提示变成一个异常）。
      const options = source();
      options.onNotice(`${noticePrefix(type)}${message}`);
    },

    onTerminalInput: (handler) =>
      live().addInputListener((data) => {
        /**
         * 扔掉「松开」事件 —— Kitty 键盘协议 flag 2 下一次按键给 press + release 两条，
         * 而 release 同样能匹配扩展的快捷键，于是每个绑定的键都触发两次。
         *
         * pi-tui 自己那层过滤只管聚焦组件，管不到 input listener（本项目的快捷键与
         * 扩展的 `onTerminalInput` 都在这里）。口径与 `app.ts` 的 `shouldIgnoreKey()`
         * 一致：只用 pi-tui 的 `isKeyRelease()`，粘贴内容它内部已排除。
         */
        if (isKeyRelease(data)) return undefined;
        return handler(data);
      }),

    // 终端标题：pi-tui 的 `Terminal.setTitle` 写 OSC 0/2。要活着的 tui，所以走 `live()`
    // （Orca 的标题 spinner 在界面起来之后才可能调它）；界面没起来时它会抛，
    // 而 spinner 自己 catch 掉并停表 —— 不会把整轮对话带崩。
    setTitle: (title: string) => {
      live().tui.terminal.setTitle(title);
    },

    // 输入框里的文字。落点在界面层（只有它知道 composer 是哪个）—— 探针／一次性模式
    // 没有那一格时就抛，不假装把字填进去了。
    setEditorText: (text: string) => {
      const setEditorText = source().setEditorText;
      if (setEditorText === undefined) {
        throw new Error('本宿主没有输入区，`setEditorText` 用不了');
      }
      setEditorText(text);
    },

    // 底栏状态段（pi 的 `setStatus`）。落点在界面层（只有它知道底栏在哪）——
    // 没有底栏的宿主（探针 / 一次性模式）就**丢掉**：状态段只是显示，与 `setWidget`
    // 同一口径。这里绝不抛：`pi-background-tasks` 在 `updateUi()` 里无条件调它，
    // 抛一次它就把 `currentCtx` 清了，之后**所有**后台任务事件都不再更新界面。
    // 清洗放在这里（而不是界面里）：「单行」是底栏的契约，与哪个界面无关。
    setStatus: (key: string, text: string | undefined) => {
      const setStatus = source().setStatus;
      if (setStatus === undefined) return;
      const line = text === undefined ? '' : sanitizeStatusText(text);
      setStatus(key, line === '' ? undefined : line);
    },

    // 工具输出的展开状态（`pi-subagents` 的 subagent 工具在 hasUI 时无条件设它）。
    // **读不到就是 false、设了就丢掉** —— 这两条不能抛（见 HostUiOptions 里的注释）。
    getToolsExpanded: () => source().getToolsExpanded?.() ?? false,
    setToolsExpanded: (expanded: boolean) => {
      source().setToolsExpanded?.(expanded);
    },

    setWidget: (
      key: string,
      content: string[] | ((tui: TUI, theme: Theme) => Component & { dispose?: () => void }) | undefined,
      opts?: { placement?: 'aboveEditor' | 'belowEditor' },
    ) => {
      const setWidget = source().setWidget;
      const { tui: t, theme: th } = live();

      // 卸下：两种形状都能卸。
      if (content === undefined) {
        setWidget?.(key, undefined, opts);
        return;
      }

      // ① 字符串数组：扩展自己上好色了（`pi-web-access` 的活动面板就是这种：它自己
      //    `theme.fg(...)` 拼好了整行）。用 `Text` 包一层直接画。`Text` 自己缓存
      //    render，所以反复 setWidget（面板刷新）不会变贵。
      if (Array.isArray(content)) {
        if (!setWidget) return;
        setWidget(key, new Text(content.join('\n'), 0, 0), opts);
        return;
      }

      // ② 组件工厂。
      if (typeof content === 'function') {
        const component = content(t, th);
        // 没有界面 → 没有那一格。把组件丢掉（并 dispose）而不是抛：扩展的 widget
        // 只是不显示，其余（工具、命令）照常，那才是诚实的降级。
        if (!setWidget) {
          try {
            component.dispose?.();
          } catch {
            /* 忽略 */
          }
          return;
        }
        setWidget(key, component, opts);
        return;
      }

      throw new Error('setWidget 只接 string[] 或组件工厂（那是官方的两种形状）');
    },

    // 问卷在**浏览器**那一份的接缝（扩展的补丁会调它，见 `questionnaire.ts` 文件头）。
    //
    // 只在真的有问卷宿主时才提供：没有的话扩展那边读到的就是 undefined，它只画
    // 终端那一份 —— 与没有这个功能之前一模一样（老版本、别的宿主都走这条）。
    ...(questionnaire === undefined
      ? {}
      : {
          externalQuestionnaire: (handoff: ExternalQuestionnaireHandoff): ExternalQuestionnaireBridge =>
            questionnaire.open(handoff),
        }),

    // 这些方法故意**不在**返回类型里（`ExtensionHostUi` 只声明了真能做的三个）：
    // 扩展若去调，拿到的是 undefined，于是「TypeError: not a function」出现在它自己
    // 的栈里 —— 比我们静默返回假值诚实。
  } as ExtensionHostUi;
}

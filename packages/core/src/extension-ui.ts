/**
 * `ctx.ui` 的宿主实现 —— 扩展界面能力的**唯一**接缝。
 *
 * ## 两块能力：`custom()`（组件）与 `select/confirm/input`（原生对话框）
 *
 * 第一块是 `custom()` —— 把一块扩展自己的组件铺进来、拿键盘焦点，用户答完或按 ESC
 * 之后 resolve 一个结果。它有**两种形态**，pi 两种都实现：
 *
 * | `custom()` 的参数 | pi 的落点 | 本项目的落点 |
 * | --- | --- | --- |
 * | `{ overlay: true }` | `ui.showOverlay()`（自己抢焦点，`hide()` 还焦点） | 同一个 |
 * | 不给 / `{ overlay: false }` | **换掉 `editorContainer` 里的 composer** | 同一个槽位（见下） |
 *
 * inline 那条路以前是「明说不支持」的（`ask_user_question` 2.12 只要 overlay）。
 * 2.13 起它**默认**走 inline（Pi 的 editor slot，`presentation.ts` 的
 * `resolvePresentation()`），overlay 反而只在「已经有另一个浮层」时降级用 —— 于是
 * 那个显式报错变成了「这个扩展在本项目里必挂」。现在补上：宿主提供一个
 * `mountEditorSlot`，把组件放进输入区那一格（pi 的 `editorContainer.clear();
 * addChild(component)`）。
 *
 * 第二块是 `select` / `confirm` / `input`（pi 给 VS Code pendant / Zed 那种宿主的
 * 「RPC 弹窗协议」）。本项目在**浏览器连上时**把模式切成 `'rpc'`（见
 * `extension-host.ts` 的 `setUiMode`），于是 `ask_user_question` 那种扩展会走这一块。
 *
 * 这一块分两条：
 *
 * - **问卷**（同一份问卷的 N 次逐题问法）交给 `QuestionnaireHost`（`questionnaire.ts`）：
 *   认领得到就由界面那份多题表回答（终端那块面板 + 浏览器那个弹窗，**一份状态两块屏**），
 *   答案再按扩展问的顺序翻回字符串喂回去；
 * - 其余（别的扩展、`confirm`、认领不到的回退）是 `raceDialog`：**两端各出一份、
 *   谁先回答谁算数** —— 终端那一份由 `tui/app.ts` 的 `tuiDialogs` 挂进同一个输入区槽位，
 *   浏览器那一份由 `web/bridge.ts` 的 `DialogHost` 发过去。
 *
 * 刻意**不接**的：`setFooter` / `setHeader`（那要接 pi 的应用层布局，见 `surfaces.md`）。
 *
 * ## 没实现的方法怎么给
 *
 * **一律 reject，不静默 no-op。** 一个 `select()` 静默 resolve `undefined` 的话，扩展会
 * 把「用户没选」当成真的答复发回模型 —— 那是最坏的一种：模型拿着一个假答案继续干活，
 * 人还不知道。`undefined` 在 pi 的契约里明确表示「用户取消了」，给假值等于**撒谎**。
 *
 * ## 为什么「有没有界面」由外面决定，而不是这里
 *
 * 一次性模式（`-p`）与测试里**不造这个对象**（`extension-host.ts` 干脆不绑 UI），
 * 于是 `ctx.hasUI` 为 false，扩展自己走 `no_ui` 分支。给一个「假装有界面」的 ctx 只会
 * 让非交互运行卡在一个没人能回答的对话框上。
 */
import type { Component, TUI, TuiInputListener, OverlayOptions } from '@earendil-works/pi-tui';
import { getKeybindings, isKeyRelease, Text } from '@earendil-works/pi-tui';
import type {
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
}

export interface HostUiOptions {
  tui: TUI;
  theme: Theme;
  /** raw input 的注册口（pi-tui 的 `addInputListener`）。 */
  addInputListener(listener: TuiInputListener): () => void;
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
   * 问卷的**视图**：开一份问卷（终端那份组件 + 浏览器那份弹窗）、返回拆台函数。
   *
   * 与 `tuiDialogs` / `dialogs` 同一类接缝：**core 定接口，界面实现**。给它的理由与
   * `custom()` 一样 —— core 不建组件（那会把 pi-tui 拖进所有运行模式）。
   *
   * 两个渲染器都归这一处管，而不是分两处（终端一处、浏览器一处）：它们是**同一份状态的
   * 两块屏幕**，分开登记就会变成"两块屏幕各画各的"（raceDialog 那种）。
   *
   * **可缺省**。不给 = 问卷功能关着：`select`/`input` 一档照旧（逐题弹窗）。
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
 * 造一个 `ctx.ui`。
 *
 * ## 为什么参数是**惰性的**（`() => options`）
 *
 * 内核装扩展时界面**还没起来**（`runTui` 里才建 tui），而 `setUIContext` 要的是一个
 * 现成的 UI 对象。早先在这里就把 options 求值（`createHostUi(uiOptions())`），
 * 那个时刻 `uiRef.current` 还是空的 —— 于是 `tui` 是 undefined，扩展的第一次
 * `ctx.ui` 访问就在自己的渲染里炸（`requestRender` of undefined），而栈里
 * **完全没有本项目的帧**：症状离真因隔了三层。
 *
 * 改成「每次用的时候才求值」之后：内核拿到一个当场能用的 UI 壳（`hasUI` 为 true，
 * 与 pi 一致），而它内部那些真的要 TUI 的方法（`custom`）在**真的被调**时才
 * 读引用 —— 那时界面早就好了。
 *
 * ## 焦点是 pi-tui 管的，我们不插手
 *
 * `showOverlay` 抢焦点、`hide()` 还焦点。`custom()` 因此**必须**在 `done()` 里
 * `handle.hide()` —— 不 hide 的话浮层永远挂在 overlay 栈上、输入再也回不到编辑器，
 * 界面看着「答完了却还能打字」。（pi 自己的 `showExtensionCustom` 也在 `close()` 里
 * `hideOverlay()`，同一个道理。）
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
      // 问卷那一档：`ask_user_question` 在 rpc 模式下就是拿 select/input 逐题问的，
      // 而我们的界面画的是"一份问卷"（多题 tab）。认领得到就由问卷回答 —— 答案在
      // `questionnaire.ts` 里翻回扩展认识的那个字符串（选项行原文 / 自定义原文）。
      //
      // 认领是**同步**的（`tryServe` 直接返回 undefined 或一个 Promise）：认不出就当场
      // 掉到下面那条逐题对话框的路上，开窗的时机与没有问卷功能时一模一样。
      const claimed = questionnaire?.tryServe('select', title, [...options], opts?.signal);
      if (claimed !== undefined) return claimed;
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
      // 多选那几题走的是 `input`（扩展自己写明的：`askMultiSelect`），所以这一档也要认领。
      const claimed = questionnaire?.tryServe('input', title, [], opts?.signal);
      if (claimed !== undefined) return claimed;
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

    // ── 明确不支持 ──
    // 这些方法故意**不在**返回类型里（`ExtensionHostUi` 只声明了真能做的三个）：
    // 扩展若去调，拿到的是 undefined，于是「TypeError: not a function」出现在它自己
    // 的栈里 —— 比我们静默返回假值诚实。
  } as ExtensionHostUi;
}

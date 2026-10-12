/**
 * `ctx.ui` 的宿主实现 —— 扩展界面能力的**唯一**接缝。
 *
 * ## 只给 `custom()` 真的，其余给「能明说不行」的实现
 *
 * 第一个接的扩展（`ask_user_question`）要的是：把一块自己的组件铺成**底部浮层**、
 * 拿键盘焦点，用户答完或按 ESC 之后 resolve 一个结果。那正好是 pi-tui 的
 * `showOverlay()` —— 它自己抢焦点，并在 `hide()` 时把焦点还给原处
 * （`showOverlay` 记了 `preFocus`）。
 *
 * 它**不要**的：`select` / `confirm` / `input` 那套 RPC 弹窗协议（给 VS Code pendant、
 * Zed 那种宿主用的）、`setFooter` / `setHeader`（那要接 pi 的应用层布局，
 * 本项目刻意不接，见 `surfaces.md`）。
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

/** 扩展能用的界面能力（比官方的 `ExtensionUIContext` 窄：只留真的能做的）。 */
export interface ExtensionHostUi {
  custom<T>(factory: CustomFactory<T>, options?: CustomOptions): Promise<T>;
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
export function createHostUi(source: () => HostUiOptions): ExtensionHostUi {
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
      if (opts?.overlay !== true) {
        // 非 overlay 的 custom 要**顶掉**底部输入区（pi 把 editor 换成那块组件）。
        // 本项目的输入区由自己的布局管（`tui/app.ts` 的 `applyLayout`），换掉它要整套
        // 布局协议 —— 而第一个扩展走的是 overlay。不实现，但要**明说**，否则症状是
        // 「扩展在等一个永远不会出现的界面」。
        throw new Error('本项目只支持 overlay 形式的扩展界面（custom({ overlay: true })）');
      }
      const { tui, theme } = live();
      return new Promise<T>((resolve, reject) => {
        let handle: { hide: () => void } | undefined;
        let component: (Component & { dispose?: () => void }) | undefined;
        let settled = false;
        const close = (result: T): void => {
          if (settled) return;
          settled = true;
          // 先还焦点再 resolve：扩展的 `done` 之后通常立刻返回给模型，
          // 那条路上还可能再开别的浮层 —— 焦点得先归位。
          try {
            handle?.hide();
          } catch {
            // hide 失败不该让用户的答复丢掉。
          }
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
              // 于是这个浮层会一直占着输入 —— 立刻拆掉。
              try {
                c.dispose?.();
              } catch {
                /* 忽略 */
              }
              return;
            }
            component = c;
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
            try {
              handle?.hide();
            } catch {
              /* 忽略 */
            }
            reject(error);
          },
        );
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

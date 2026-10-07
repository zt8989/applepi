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
 * Zed 那种宿主用的）、`setWidget` / `setFooter` / `setHeader`（那要接 pi 的应用层布局，
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
import { getKeybindings } from '@earendil-works/pi-tui';
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
  /** raw 终端输入（`ask_user_question` 靠它实现「浮层折叠后还能复原」）。 */
  onTerminalInput(handler: (data: string) => undefined | { consume?: boolean }): () => void;
}

export interface HostUiOptions {
  tui: TUI;
  theme: Theme;
  /** raw input 的注册口（pi-tui 的 `addInputListener`）。 */
  addInputListener(listener: TuiInputListener): () => void;
  /** 扩展的提示写进哪里（界面对话区顶部那行 `notice`）。 */
  onNotice(text: string): void;
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

    onTerminalInput: (handler) => live().addInputListener(handler),

    // ── 明确不支持 ──
    // 这些方法故意**不在**返回类型里（`ExtensionHostUi` 只声明了真能做的三个）：
    // 扩展若去调，拿到的是 undefined，于是「TypeError: not a function」出现在它自己
    // 的栈里 —— 比我们静默返回假值诚实。
  } as ExtensionHostUi;
}

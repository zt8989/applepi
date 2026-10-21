/**
 * 会话列表的自动滚动：内容变高时**平滑**跟到底部，用户往上翻就停下来。
 *
 * 要自己接管：pi-web-ui 的 `AgentInterface` 用 `ResizeObserver` 一有变化就 `scrollTop =
 * scrollHeight`，流式时每几帧跳一次，看着「一顿一顿地蹦」。这里把它的自动滚动关掉（那个私有字段运行时
 * 只是普通属性），换成 Motion 的 `animate()`。
 *
 * 跟随策略：内容变高就从当前位置动画到新底部（最多 0.45s）；动画期间的变化只记「还欠一次」，跑完再补
 * （不打断，避免抖）；用户往上滚就停住并暂停跟随，直到他滚回底部或发了一条新消息；切会话或一次要跳超过
 * 一屏半就**直接定位**（否则像出了 bug）；系统开了「减少动态效果」也全部直接定位。
 */

import { animate, type AnimationPlaybackControls } from 'motion';

/** 离底多近算「贴底」（px）：程序滚动的落点、以及用户翻回来后恢复跟随的阈值。 */
const STICK_THRESHOLD = 24;

/** 一次滚动动画的时长：距离越远越长，但有上限（跟手，但不拖沓）。 */
export function scrollDuration(distance: number): number {
  return Math.min(0.45, 0.14 + Math.abs(distance) / 6000);
}

/**
 * 一次要跳得比「一屏半」还远时，不播动画。
 *
 * 那是「刚打开会话 / 切换会话」的形状：从顶部一路滚下来只是噪音。
 */
export function shouldJump(distance: number, viewportHeight: number): boolean {
  return Math.abs(distance) > viewportHeight * 1.5;
}

export interface SmoothAutoScroll {
  /** 拆掉监听（测试 / 热重载用；正常页面一直活着）。 */
  destroy(): void;
}

export function installSmoothAutoScroll(host: HTMLElement): SmoothAutoScroll {
  let scrollEl: HTMLElement | null = null;
  let contentEl: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let domObserver: MutationObserver | null = null;
  let bindTimer = 0;
  let rafId = 0;
  let controls: AnimationPlaybackControls | null = null;
  /** 动画在跑时又来了新目标：跑完补一次。 */
  let pending = false;
  /** 用户往上翻了：暂停跟随。 */
  let paused = false;
  let lastScrollTop = 0;
  /** 每次「停止」加一：让旧动画的完成回调认得出自己已经过期。 */
  let generation = 0;
  let disposed = false;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const maxScroll = (): number =>
    scrollEl === null ? 0 : Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);

  const nearBottom = (): boolean => {
    if (scrollEl === null) return true;
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= STICK_THRESHOLD;
  };

  const stopAnimation = (): void => {
    generation += 1;
    controls?.stop();
    controls = null;
    pending = false;
  };

  const jumpToBottom = (): void => {
    if (scrollEl === null) return;
    stopAnimation();
    scrollEl.scrollTop = maxScroll();
  };

  const step = (): void => {
    if (disposed || paused || scrollEl === null) return;
    const target = maxScroll();
    const from = scrollEl.scrollTop;
    const distance = target - from;
    if (distance <= 0.5) {
      pending = false;
      return;
    }
    // 上一段还没跑完：只记下「还欠一次」，别打断（流式时打断会一抖一抖）。
    if (controls !== null) {
      pending = true;
      return;
    }
    if (reduceMotion.matches || shouldJump(distance, scrollEl.clientHeight)) {
      scrollEl.scrollTop = target;
      return;
    }
    const startedAt = generation;
    const started = animate(from, target, {
      duration: scrollDuration(distance),
      // 先快后慢：底部的落点比匀速更容易跟上（`easeOutQuint` 的形状）。
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (value) => {
        // 用户刚上滚（`paused`）时不再抢滚动位置。
        if (paused || scrollEl === null) return;
        scrollEl.scrollTop = value;
      },
    });
    controls = started;
    const done = (): void => {
      if (startedAt !== generation) return;
      controls = null;
      if (pending) {
        pending = false;
        step();
      }
    };
    // `stop()` 会让 `finished` 走 reject —— 两条路都接到 `done`（内部再判过期）。
    void started.finished.then(done, done);
  };

  const schedule = (): void => {
    if (rafId !== 0) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      step();
    });
  };

  /**
   * 只认「用户往上滚」：`scrollTop` 变小且离底还远。
   * 程序滚动只会让它变大；内容变高时它根本不变。
   */
  const onScroll = (): void => {
    if (scrollEl === null) return;
    const top = scrollEl.scrollTop;
    const scrolledUp = top < lastScrollTop - 1;
    lastScrollTop = top;
    if (scrolledUp && !nearBottom()) {
      paused = true;
      stopAnimation();
      return;
    }
    // 自己（或被用户）回到贴底：恢复跟随。
    if (!scrolledUp && nearBottom()) paused = false;
  };

  /**
   * 用户**开始**自己滚动时立刻让路。
   *
   * 光靠 `scroll` 事件太晚：动画的 `onUpdate` 每帧都在写 `scrollTop`，会把用户的
   * 一次上滚直接盖掉（手感上就是“拖不动”）。所以 `wheel` / 触摸一发生就停动画；
   * 滚动条拖动走 `pointerdown`（全局只停不暂停 —— 拖动方向要等 `scroll` 才看得出来）。
   */
  const onUserIntent = (event: Event): void => {
    if (disposed || scrollEl === null) return;
    stopAnimation();
    if (event.type === 'wheel') {
      const deltaY = (event as WheelEvent).deltaY;
      if (deltaY < 0) paused = true;
      else if (nearBottom()) paused = false;
      return;
    }
    if (event.type === 'touchmove') paused = true;
  };

  const unbindScroll = (): void => {
    if (scrollEl !== null) {
      scrollEl.removeEventListener('scroll', onScroll);
      scrollEl.removeEventListener('wheel', onUserIntent);
      scrollEl.removeEventListener('touchstart', onUserIntent);
      scrollEl.removeEventListener('touchmove', onUserIntent);
      scrollEl.removeEventListener('pointerdown', onUserIntent);
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
  };

  /**
   * 找到滚动容器并接管。`true` = 已经绑好了。
   *
   * 选择器是 pi-web-ui 的布局决定的（`AgentInterface.render()`）：滚动的是
   * `.overflow-y-auto`，内容在它下面那个 `.max-w-3xl` 里。
   */
  const bind = (): boolean => {
    const content = host.querySelector<HTMLElement>('.overflow-y-auto > .max-w-3xl');
    const nextScroll = content?.parentElement ?? null;
    if (content === null || nextScroll === null) return false;
    if (nextScroll === scrollEl && content === contentEl) return true;

    unbindScroll();
    scrollEl = nextScroll;
    contentEl = content;
    contentEl.dataset['elaSmoothScroll'] = 'content';
    scrollEl.dataset['elaSmoothScroll'] = 'container';
    lastScrollTop = scrollEl.scrollTop;

    // 关掉 pi-web-ui 自己的「瞬间跳到底」。字段名是它的实现细节，所以先看一眼在不在：
    // 哪天它改了名，这里安静地退化成「它跳它的、我们跟我们的」而不是报错。
    const iface = scrollEl.closest('agent-interface');
    if (iface !== null && '_autoScroll' in iface) {
      Object.defineProperty(iface, '_autoScroll', {
        configurable: true,
        get: () => false,
        set: () => {},
      });
    }

    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    // 用户一动手就停动画（见 `onUserIntent`）。`touchstart` 只停不暂停：轻点是选文字，
    // 真滑动时 `touchmove` 再暂停。
    scrollEl.addEventListener('wheel', onUserIntent, { passive: true });
    scrollEl.addEventListener('touchstart', onUserIntent, { passive: true });
    scrollEl.addEventListener('touchmove', onUserIntent, { passive: true });
    scrollEl.addEventListener('pointerdown', onUserIntent, { passive: true });
    resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(content);
    return true;
  };

  /**
   * 结构变了：可能是第一次挂上 `agent-interface`，也可能是切换会话把
   * `message-list` 整个换掉（那时内容整体搬走，应当直接定位底部）。
   */
  const onMutation = (records: readonly MutationRecord[]): void => {
    if (disposed) return;
    if (!bind()) return;
    let sawUserMessage = false;
    let listReplaced = false;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('user-message') || node.querySelector('user-message') !== null) {
          sawUserMessage = true;
        }
        if (node.matches('message-list') || node.querySelector('message-list') !== null) {
          listReplaced = true;
        }
      }
    }
    // 发了一条新消息：把视线放回最新那一轮。
    if (sawUserMessage) paused = false;
    if (listReplaced) {
      paused = false;
      jumpToBottom();
      return;
    }
    schedule();
  };

  domObserver = new MutationObserver(onMutation);
  domObserver.observe(host, { childList: true, subtree: true });

  /** ChatPanel 是 `setAgent()` 之后才渲染的：等它把滚动容器画出来。 */
  const tryBind = (): void => {
    if (disposed) return;
    if (bind()) {
      jumpToBottom();
      return;
    }
    bindTimer = window.setTimeout(tryBind, 50);
  };
  tryBind();

  return {
    destroy(): void {
      disposed = true;
      stopAnimation();
      unbindScroll();
      domObserver?.disconnect();
      domObserver = null;
      if (bindTimer !== 0) clearTimeout(bindTimer);
      if (rafId !== 0) cancelAnimationFrame(rafId);
      scrollEl = null;
      contentEl = null;
    },
  };
}

/**
 * 侧边栏宽度：拖中缝改、双击复位、键盘也能调。
 *
 * ## 为什么不是 React 布局库
 *
 * webui 是**原生 TS + Lit**（见 `main.ts`），没有 React —— `react-resizable-panels`
 * 那一类库在这里用不上。这一份是 Pi Web 的 `useResizablePanel` 的等价实现：同一套
 * 规矩（最小 / 最大、记住用户选的宽度、窗口变小时只临时收窄而不覆盖偏好、键盘与双击
 * 复位），只是没有 hook 那层壳。
 *
 * ## 宽度算在哪
 *
 * 宽度写成一个 CSS 变量（`--ela-sidebar-width`）挂在侧边栏自己身上：布局读它，拖拽
 * 只改这一个数（不碰 class、不重建 DOM）。收起时的 `flex-basis: 0` 由 CSS 负责，所以
 * 那个变量始终是「用户想要的宽度」—— 展开回来还是它。
 *
 * ## 为什么「偏好」与「现在」要分开存
 *
 * 窗口一时变窄（半屏、分屏）会把面板压到 `minWidth`，但那是窗口的事，不是用户的选择：
 * 把压窄后的值写回存储，窗口再放大时它就不会长回来了。所以只有拖拽 / 键盘 / 双击这
 * 三种**用户动作**才更新偏好与存储；`resize` 只按偏好重算当下能显示多少。
 */

/** 侧边栏的宽度规矩（与 Pi Web 同一组数，手感对得上）。 */
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MAX_WIDTH = 480;

/** 主区至少要留这么宽 —— 再宽就把对话压到没法看了。 */
export const MAIN_MIN_WIDTH = 360;

/** 键盘一次挪多少（Shift 大步）。 */
const KEY_STEP = 12;
const KEY_STEP_LARGE = 32;

/**
 * 把一个宽度夹进 `[min, max]`。
 *
 * `NaN` / `Infinity` 一律落回 `minWidth`：存储里可能是半截数字（`"26"` 之外的脏值），
 * 而 `Math.min(NaN, x)` 还是 `NaN` —— 那种值写进 `flex-basis` 会让侧边栏直接消失。
 */
export function clampPanelWidth(width: number, minWidth: number, maxWidth: number): number {
  // `NaN` 落回下限；±Infinity 不必特判 —— `Math.min` / `Math.max` 自己会把它送到两头。
  const safe = Number.isNaN(width) ? minWidth : width;
  const ceiling = Math.max(minWidth, maxWidth);
  return Math.round(Math.max(minWidth, Math.min(ceiling, safe)));
}

/**
 * 当前视口下侧边栏最多能有多宽：库给的 480 是上限，但对话那一列也得活着。
 *
 * 窄到连 `minWidth + 主区最小宽` 都放不下时返回 `minWidth`（宁可主区挤一点，也不把
 * 侧边栏压成负数 —— 负的 `flex-basis` 是非法值，浏览器会当成 0，看起来像「拖没了」）。
 */
export function sidebarMaxWidth(
  viewportWidth: number,
  maxWidth: number = SIDEBAR_MAX_WIDTH,
): number {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(maxWidth, Math.round(viewportWidth) - MAIN_MIN_WIDTH),
  );
}

export interface SidebarResizeOptions {
  /** 侧边栏本体（宽度变量写给它）。 */
  panel: HTMLElement;
  /** 中缝那个手柄（`role="separator"`，事件都挂在它上面）。 */
  handle: HTMLElement;
  /** 宽度记忆的 key（每个浏览器一份）。 */
  storageKey: string;
  minWidth?: number;
  defaultWidth?: number;
  /** 绝对上限；实际生效的上限还会被视口再压一次（见 `sidebarMaxWidth`）。 */
  maxWidth?: number;
}

export interface ResizableSidebar {
  /** 用户选的那份宽度（没被窗口收窄过）。 */
  preferredWidth(): number;
  /** 现在实际显示、写进 CSS 变量里的宽度。 */
  width(): number;
  /** 窗口变了：按新视口重算一次（不覆盖偏好）。 */
  reclamp(): void;
  /** 拆掉全部监听（热重载 / 测试用；正常页面一直活着）。 */
  destroy(): void;
}

function readStoredWidth(storageKey: string): number | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    // 隐私模式：当作没存过。
    return null;
  }
}

function writeStoredWidth(storageKey: string, width: number): void {
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // 同上：存不下不影响这一次会话。
  }
}

/**
 * 装上一个可拖的侧边栏。
 *
 * 返回的 `width()` 是「现在多宽」，`preferredWidth()` 是「用户想要多宽」—— 收起 / 展开
 * 由 CSS 管，这两个数只在布局与无障碍属性上用到。
 */
export function makeSidebarResizable(options: SidebarResizeOptions): ResizableSidebar {
  const {
    panel,
    handle,
    storageKey,
    minWidth = SIDEBAR_MIN_WIDTH,
    defaultWidth = SIDEBAR_DEFAULT_WIDTH,
    maxWidth = SIDEBAR_MAX_WIDTH,
  } = options;

  /** 用户选的那份宽度：只有用户自己的动作会改它。 */
  let preferred = clampPanelWidth(readStoredWidth(storageKey) ?? defaultWidth, minWidth, maxWidth);
  /** 现在显示的宽度（视口小的时候可能比 `preferred` 窄）。 */
  let current = preferred;
  /** 正在拖的那一次（`null` = 没在拖）。 */
  let drag: {
    pointerId: number;
    startX: number;
    startWidth: number;
    previousCursor: string;
    previousUserSelect: string;
  } | null = null;

  const effectiveMax = (): number => sidebarMaxWidth(window.innerWidth, maxWidth);

  const applyWidth = (next: number): void => {
    current = clampPanelWidth(next, minWidth, effectiveMax());
    panel.style.setProperty('--ela-sidebar-width', `${current}px`);
    handle.setAttribute('aria-valuenow', String(current));
    handle.setAttribute('aria-valuetext', `${current} px`);
    handle.setAttribute('aria-valuemin', String(minWidth));
    handle.setAttribute('aria-valuemax', String(effectiveMax()));
  };

  /** 按新视口重新算一次：拖拽进行中就别动（手还按着，宽度该跟着指针）。 */
  const reclamp = (): void => {
    if (drag !== null) return;
    applyWidth(preferred);
  };

  const setBodyDragState = (dragging: boolean, previous?: { cursor: string; userSelect: string }): void => {
    if (dragging) {
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      panel.classList.add('is-resizing');
      handle.classList.add('is-resizing');
      return;
    }
    document.body.style.cursor = previous?.cursor ?? '';
    document.body.style.userSelect = previous?.userSelect ?? '';
    panel.classList.remove('is-resizing');
    handle.classList.remove('is-resizing');
  };

  /** 结束一次拖拽：只有宽度真变了才写存储（点一下不该覆盖偏好）。 */
  const finishDrag = (pointerId: number): void => {
    const active = drag;
    if (active === null || active.pointerId !== pointerId) return;
    drag = null;
    setBodyDragState(false, { cursor: active.previousCursor, userSelect: active.previousUserSelect });
    if (current !== active.startWidth) {
      preferred = clampPanelWidth(current, minWidth, maxWidth);
      writeStoredWidth(storageKey, preferred);
    }
    try {
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    } catch {
      // 浏览器可能已经在 pointercancel 之后自己放掉了。
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    // 手机端手柄被 CSS 藏起来了，这里再挡一道（触屏在抽屉上拖会很难看）。
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (window.matchMedia('(max-width: 768px)').matches) return;
    event.preventDefault();

    if (drag !== null) finishDrag(drag.pointerId);
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: current,
      previousCursor: document.body.style.cursor,
      previousUserSelect: document.body.style.userSelect,
    };
    setBodyDragState(true);
  };

  const onPointerMove = (event: PointerEvent): void => {
    const active = drag;
    if (active === null || active.pointerId !== event.pointerId) return;
    // 鼠标键已经松开却没收到 pointerup（窗口切换、系统弹窗）：按结束处理。
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      finishDrag(event.pointerId);
      return;
    }
    event.preventDefault();
    applyWidth(active.startWidth + (event.clientX - active.startX));
  };

  const onPointerUp = (event: PointerEvent): void => {
    finishDrag(event.pointerId);
  };

  const onPointerCancel = (event: PointerEvent): void => {
    finishDrag(event.pointerId);
  };

  const onLostPointerCapture = (event: PointerEvent): void => {
    finishDrag(event.pointerId);
  };

  /** 键盘：← 收、→ 放、Home 最小、End 最大、Enter 复位（与双击同一个动作）。 */
  const onKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = current + step;
    else if (event.key === 'ArrowLeft') next = current - step;
    else if (event.key === 'Home') next = minWidth;
    else if (event.key === 'End') next = effectiveMax();
    else if (event.key === 'Enter') next = defaultWidth;
    if (next === null) return;
    event.preventDefault();
    applyWidth(next);
    preferred = clampPanelWidth(current, minWidth, maxWidth);
    writeStoredWidth(storageKey, preferred);
  };

  const onDoubleClick = (): void => {
    applyWidth(defaultWidth);
    preferred = clampPanelWidth(current, minWidth, maxWidth);
    writeStoredWidth(storageKey, preferred);
  };

  const onWindowResize = (): void => {
    reclamp();
  };

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('pointercancel', onPointerCancel);
  handle.addEventListener('lostpointercapture', onLostPointerCapture);
  handle.addEventListener('keydown', onKeyDown);
  handle.addEventListener('dblclick', onDoubleClick);
  window.addEventListener('resize', onWindowResize);

  // 首屏先把变量育上：不设的话 CSS 会落到 `--ela-sidebar-width` 的兜底值（260px），
  // 与存储里那份可能不一致（看起来像「记住的宽度没生效」）。
  applyWidth(preferred);

  return {
    preferredWidth: () => preferred,
    width: () => current,
    reclamp,
    destroy() {
      if (drag !== null) finishDrag(drag.pointerId);
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerCancel);
      handle.removeEventListener('lostpointercapture', onLostPointerCapture);
      handle.removeEventListener('keydown', onKeyDown);
      handle.removeEventListener('dblclick', onDoubleClick);
      window.removeEventListener('resize', onWindowResize);
    },
  };
}

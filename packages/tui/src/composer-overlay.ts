/**
 * 「覆盖 composer」这一形状的覆盖层参数 —— `/model`、`/scoped-models`、`/resume`
 * 三个面板共用。
 *
 * ## 为什么不是居中的浮窗
 *
 * pi 里这些面板**根本不是浮窗**：`interactive-mode.js` 的 `showSelector()` 把
 * `editorContainer`（承载 composer 的那一格）的**内容整个换掉** —— `clear()` 之后
 * `addChild(selector)`，关掉时再 `addChild(editor)` 换回来。
 *
 * ```js
 * // pi: interactive-mode.js 的 showSelector()
 * this.editorContainer.clear();
 * this.editorContainer.addChild(created.component);
 * this.ui.setFocus(created.focus);
 * // 关掉时：
 * this.editorContainer.clear();
 * this.editorContainer.addChild(this.editor);
 * ```
 *
 * 于是面板**天然**是 composer 的宽度（`editorContainer` 占满一行），而它的底边**就是**
 * composer 的底边（同一个槽位、同一个位置）。用户按下 Ctrl+L / /resume 时看到的是
 * 「输入框那块变成了列表」，不是「屏幕中央弹出一个框」。
 *
 * 本项目里 composer 是底部 `VStack` 里的一格（见 `app.ts` 的 `applyLayout`），
 * 没有 pi 那套 `editorContainer` 可以换内容。所以这里用 overlay **复刻同一个矩形**：
 *
 * | pi 的槽位性质 | 这里的写法 |
 * | --- | --- |
 * | 宽度 = composer 宽度 = 整行 | `width: '100%'` |
 * | 底边 = composer 底边 | `anchor: 'bottom-center'` + `margin.bottom` = composer 距屏幕底的行数 |
 * | 向上生长（盖住对话区，不截断顶部） | 不给 `maxHeight`（默认不截；面板自己定高） |
 *
 * ## `margin.bottom` 为什么必须跟着底栏走，而不是写死 2
 *
 * 「composer 底边距屏幕底几行」= 它下面那几格的高度之和。当前布局里 composer 下面是
 * **底栏**（`footer`，两行：cwd / 用量 + 模型），所以是 2。但这个数是 `app.ts` 的
 * **布局事实**，不是这里能拍脑袋写死的常量 —— 底栏哪天变成三行（或者底下再加一格，
 * 比如常驻的队列面板），面板就会跟着错位，且症状是「面板底边悬在输入框上面两行」，
 * 很难归因。
 *
 * 所以这个数由本模块的 {@link FOOTER_ROWS} 统一给出，`app.ts` 布局里 footer 的 `basis`
 * 与这里的 `margin.bottom` **读同一个来源**。改一处，两处同时动。
 */

/** 底栏占几行。**必须与 `app.ts` 里 footer 的 `basis` 相等** —— 见文件头。 */
export const FOOTER_ROWS = 2;

/**
 * composer 底边距屏幕底的行数 = 它下面那几格的高度。
 *
 * 当前 composer 下面只有底栏，所以就是 {@link FOOTER_ROWS}。给个名字而不是让调用方
 * 直接写 `margin: { bottom: FOOTER_ROWS }`：以后底下再加一格时，改的是这里一处。
 */
export const COMPOSER_BOTTOM_MARGIN = FOOTER_ROWS;

/**
 * 「覆盖 composer」的覆盖层参数。
 *
 * 三个面板共用这一份，且**只此一份** —— 各写各的必然漂移，而漂移的症状是
 * 「/model 的面板贴着输入框、/resume 的却飘在中间」。早期这三处就是各写各的
 * （`anchor: 'center'` + `width: '90%'` + 各自的 `maxHeight`），那正是要修掉的东西。
 *
 * 返回普通对象而不是常量：调用方要往 `tui.showOverlay(component, options)` 里传，
 * 而每次调用共享同一个可变对象有被就地改坏的风险；顺带也方便以后从 `app.ts` 传布局
 * 事实进来（比如底栏行数不再固定时）。
 */
export function composerOverlayOptions(): {
  anchor: 'bottom-center';
  width: '100%';
  margin: { bottom: number };
} {
  return {
    // 底边对齐：`resolveAnchorRow('bottom-*')` 给的是
    // `availHeight - height`，而 `availHeight = termHeight - marginTop - marginBottom`
    // —— 于是面板的**最后一行**落在 `termHeight - marginBottom - 1`，
    // 正是 composer 底边那一行（pi-tui 的 row 是 0 基，第 0 行是屏幕最上面）。
    anchor: 'bottom-center',
    // 整行宽。不用 '90%'：pi 那边就是满宽（换掉整个槽位），而 90% 会在左右各留一截
    // 别的内容，看着像「面板没盖住输入框」。
    width: '100%',
    // 底边让开底栏 —— 那才是 composer 真正的底边。
    margin: { bottom: COMPOSER_BOTTOM_MARGIN },
  };
}
/**
 * 「覆盖 composer」这一形状的覆盖层参数 —— `/model`、`/scoped-models`、`/resume` 三个面板共用。
 *
 * pi 里这些面板**根本不是浮窗**：`showSelector()` 把 `editorContainer`（承载 composer 的那一格）的
 * 内容整个换掉，于是面板天然是 composer 的宽度、底边就是 composer 的底边。本项目没有那套容器，
 * 所以用 overlay **复刻同一个矩形**，让用户看到的仍是「输入框那块变成了列表」。
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
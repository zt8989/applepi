/**
 * 底栏统计行：把 pi-web-ui 自带的 `renderStats()` 换成**服务端算好的整行**。
 *
 * pi-web-ui 的 `formatUsage()` 只到 `↑362k ↓310k R121M`（外加 `W`/`$cost`）—— 没有
 * `CH`（缓存命中率）与上下文占用 `52%/1.0M`。而终端界面的底栏有那两段（`statsLine()`）。
 * 两边要一致，最省事的做法是服务端算好整行发过来（`state.statsText` / `state.statsLevel`），
 * 这里只负责画 —— 两套算法各写一份的话，`CH` 与上下文占用的口径迟早会漂。
 *
 * `renderStats` 在 pi-web-ui 里是 private，但运行时就在原型上 —— 与本项目换
 * `tool-message` 的 `render` 同一个手法（那边的文件头有详细说明）。
 */
import { html, type TemplateResult } from 'lit';

/** `AgentInterface.session.state` 里我们读的那两个字段。 */
interface StatsSession {
  state: { statsText?: string | undefined; statsLevel?: 'none' | 'warn' | 'error' | undefined };
}

/** 装上去。必须在 `agent-interface` 注册之后调（`main()` 里第一件事）。 */
export function installStatsView(): void {
  const ctor = customElements.get('agent-interface') as
    | (CustomElementConstructor & { prototype: { renderStats?: () => unknown } })
    | undefined;
  if (ctor === undefined) return;
  ctor.prototype.renderStats = function renderStats(this: { session?: StatsSession }): TemplateResult {
    const text = this.session?.state.statsText ?? '';
    const level = this.session?.state.statsLevel ?? 'none';
    // 与终端那边的告警色同义（TUI 用 `theme.fg('warning'|'error')`）。
    const cls =
      level === 'error'
        ? 'text-destructive'
        : level === 'warn'
          ? 'text-yellow-600 dark:text-yellow-400'
          : '';
    return html`<div class="text-xs text-muted-foreground flex justify-between items-center h-5"><div></div><div class="flex ml-auto items-center gap-3">${text === '' ? '' : html`<span class="${cls}">${text}</span>`}</div></div>`;
  };
}

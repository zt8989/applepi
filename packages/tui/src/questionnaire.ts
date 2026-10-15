/**
 * 终端那一份问卷（多题 tab）—— `ask_user_question` 在 rpc 模式下的**整份**界面。
 *
 * ## 它在补什么
 *
 * 扩展在 rpc 模式拿 `ctx.ui.select` / `ctx.ui.input` 逐题问（`rpc-fallback.ts`），
 * 而那两个原语在终端这一侧原本各自弹一个 pi 自带的单题对话框：不能切题、看不到
 * 别的题答了没、自定义答案还要再开一个输入框。这里换成一份**多题表**：
 *
 * ```text
 *   [1 库] [✓2 认证] [3 提交]
 *
 *   用哪个库？
 *
 *   ❯ 1. sqlite — 单文件，零运维
 *     2. postgres — 要一台服务器
 *     3. Type something.
 *
 *   ←/→ 切题 · ↑↓ 选项 · Enter 选择 · Esc 放弃     未答 1/3
 * ```
 *
 * ## 状态不在它这里
 *
 * 答案属于 `@ela/core/questionnaire` 的 `QuestionnaireSession`，这个组件只是它的
 * 一块屏：收到快照就画，按键变成**意图**发回去。所以浏览器那份弹窗改了什么，这里
 * 下一次快照就跟上（两块屏一个状态，不是两个状态）。
 *
 * **游标是它自己的**（`cursor`）：`↓` 停在哪个选项上、预览翻到哪一页，是"这一块屏看到
 * 哪儿"，不该传染给另一块屏 —— 快照里没有这一项就是为这个。
 *
 * ## 高度
 *
 * 它挂在输入区那一格（`mountEditorSlot`），像 pi 自己的编辑器一样按自然高度画，但
 * 不能把整个屏幕吃掉：行数按终端高度的比例封顶（`INLINE_ROW_RATIO`，与扩展自己那份
 * 的取值同一个思路），超出的部分是**围绕焦点开窗**而不是从头截断。
 */
import {
  Input,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import type {
  QuestionnaireIntent,
  QuestionnaireQuestion,
  QuestionnaireSession,
  QuestionnaireSnapshot,
} from '@ela/core/questionnaire';

const useColor = !process.env.NO_COLOR;
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (t: string) => paint('2', t);
const bold = (t: string) => paint('1', t);
const green = (t: string) => paint('32', t);
const yellow = (t: string) => paint('33', t);
const cyan = (t: string) => paint('36', t);
const reverse = (t: string) => paint('7', t);

/** 行数上限占终端高度的比例 / 下限 / 上限 —— 见文件头「高度」。 */
const ROW_RATIO = 0.6;
const MIN_ROWS = 10;
const MAX_ROWS = 28;
/** 宽到这个数就把预览放**右边**（与扩展自己那份的并排阈值同量级）。 */
const SIDE_BY_SIDE_WIDTH = 96;

/** 当前题里的一行：某个选项 / "Type something." / 多选的"选好了"。 */
type Row =
  | { kind: 'option'; index: number }
  | { kind: 'other' }
  | { kind: 'commit' };

export interface QuestionnairePanelOptions {
  /** 终端高度（每次渲染现读 —— 窗口大小是会变的）。 */
  terminalRows(): number;
  /** 用户的一个动作。调用方把它转给 `QuestionnaireSession.apply`。 */
  onIntent(intent: QuestionnaireIntent): void;
}

export class QuestionnairePanel implements Component {
  private snapshot: QuestionnaireSnapshot;
  private unsubscribe: () => void;
  /** 每题自己的行游标（切题回来时"我上次停在第 3 个选项"还在）。 */
  private readonly cursors: number[] = [];
  private inputMode = false;
  private readonly input = new Input({ placeholder: '输入你的答案，回车确认' });
  private readonly preview = new Markdown('', 0, 0, getMarkdownTheme());
  private previewSource = '';

  constructor(
    private readonly session: QuestionnaireSession,
    private readonly options: QuestionnairePanelOptions,
  ) {
    this.snapshot = session.snapshot();
    for (let i = 0; i < this.snapshot.questions.length; i += 1) this.cursors.push(0);
    this.input.onSubmit = (value) => this.commitInput(value);
    this.input.onEscape = () => {
      this.inputMode = false;
    };
    this.unsubscribe = session.subscribe((snapshot) => {
      this.snapshot = snapshot;
      // 另一块屏切了题/改了答案：本地游标跟着题走（不跟的话回来时游标指着别的行）。
      if (this.inputMode && this.activeAnswerKind() !== 'custom-pending') this.inputMode = false;
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────

  invalidate(): void {
    this.input.invalidate();
    this.preview.invalidate();
  }

  render(width: number): string[] {
    // tab 一行、正文前后各一个空行、底部提示一行 —— 剩下的都给正文。
    const room = Math.max(4, this.rowBudget() - 4);
    const submit = this.snapshot.active >= this.snapshot.questions.length;
    const body = submit ? this.renderSubmit(width) : this.renderQuestion(width, room);
    const lines = [this.renderTabs(width), '', ...this.fit(body, room), '', this.renderFooter(width)];
    return lines.map((line) => truncateToWidth(line, width, '…', true));
  }

  /** 终端高度 → 这份问卷最多画几行。 */
  private rowBudget(): number {
    const rows = this.options.terminalRows();
    return Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(rows * ROW_RATIO)));
  }

  /** tab 条：`[1 库] [✓2 认证] [3 提交]`，激活那个反显，答过那个打勾。 */
  private renderTabs(width: number): string {
    const parts: string[] = [];
    this.snapshot.questions.forEach((question, index) => {
      const answered = this.snapshot.settled[index] === true;
      const label = question.header === '' ? `第 ${index + 1} 题` : question.header;
      const mark = answered ? '✓' : `${index + 1}`;
      const text = ` ${mark} ${label} `;
      if (index === this.snapshot.active) parts.push(reverse(bold(text)));
      else parts.push(answered ? green(text) : dim(text));
    });
    const submitAnswered = this.snapshot.active === this.snapshot.questions.length;
    const submitText = ' 提交 ';
    parts.push(submitAnswered ? reverse(bold(submitText)) : dim(submitText));
    return truncateToWidth(parts.join(' '), width, '…', true);
  }

  /** 题干 + 选项 +（焦点那个选项的）预览。`room` 是正文能给多少行。 */
  private renderQuestion(width: number, room: number): string[] {
    const question = this.snapshot.questions[this.snapshot.active];
    if (question === undefined) return [];
    const rows = this.rowsFor(question);
    const cursor = this.cursorFor(question);

    const head = [...wrapTextWithAnsi(bold(question.question), width), ''];
    const optionLines = rows.map((row) => this.renderRow(question, row, cursor, width));
    const essential = [...head, ...optionLines];

    const focused = rows[cursor];
    const previewText = focused?.kind === 'option' ? question.options[focused.index]?.preview ?? '' : '';
    if (previewText === '') return essential;
    // 预览是唯一"可长可短"的一段（题干与选项必须一直在 —— 那是用户要按的东西）。
    const previewRoom = Math.max(2, room - essential.length - 1);

    if (width >= SIDE_BY_SIDE_WIDTH) {
      const left = Math.max(30, Math.floor(width * 0.46));
      const right = width - left - 3;
      const rightLines = this.cap(this.renderPreview(previewText, right), previewRoom, '预览');
      const height = Math.min(room, Math.max(essential.length, rightLines.length));
      const out: string[] = [];
      for (let i = 0; i < height; i += 1) {
        const leftLine = truncateToWidth(essential[i] ?? '', left, '…', true);
        const pad = ' '.repeat(Math.max(0, left - visibleWidth(leftLine)));
        const rightLine = truncateToWidth(rightLines[i] ?? '', right, '…', true);
        out.push(rightLine.trim() === '' ? leftLine : `${leftLine}${pad} ${rightLine}`);
      }
      return out;
    }
    return [...essential, '', ...this.cap(this.renderPreview(previewText, width), previewRoom, '预览')];
  }

  /** 一段内容超行时留前 N-1 行，最后一行说还有多少（而不是默默截断）。 */
  private cap(lines: string[], room: number, what: string): string[] {
    if (lines.length <= room) return lines;
    const kept = lines.slice(0, Math.max(1, room - 1));
    return [...kept, dim(`… ${what}还有 ${lines.length - kept.length} 行（终端调高一点看全）`)];
  }

  /** 提交页：每题一行答案（没答的标出来）。 */
  private renderSubmit(width: number): string[] {
    const out: string[] = [bold('这就要提交了：'), ''];
    this.snapshot.questions.forEach((question, index) => {
      const answer = this.snapshot.answers[index];
      const label = question.header === '' ? `第 ${index + 1} 题` : question.header;
      const body = this.snapshot.settled[index] !== true || answer == null ? yellow('（还没答）') : this.summarize(question, answer);
      out.push(...wrapTextWithAnsi(`${green('✓')} ${dim(`${label}：`)}${body}`, width));
    });
    const unanswered = this.snapshot.questions.length - this.answeredCount();
    out.push('');
    out.push(unanswered === 0 ? dim('回车提交。') : yellow(`还有 ${unanswered} 题没答，先回去答完（←/→ 切题）。`));
    return out;
  }

  /** 一题的答案摘要（提交页那一行）。 */
  private summarize(
    question: QuestionnaireQuestion,
    answer: NonNullable<QuestionnaireSnapshot['answers'][number]>,
  ): string {
    if (answer.kind === 'custom') return answer.text;
    if (answer.kind === 'multi') {
      if (answer.custom !== undefined && answer.custom.trim() !== '') return answer.custom;
      if (answer.selected.length === 0) return dim('（一个都没勾）');
      return answer.selected.map((i) => question.options[i]?.label ?? '').join('、');
    }
    return question.options[answer.index]?.label ?? '';
  }

  /**
   * 一行选项 / 哨兵行。
   *
   * **不补空格到整宽**（`truncateToWidth` 的 `pad` 传 false）：并排布局时这一行还要被
   * 裁进左半边，先补满再裁只会得到「补出去的那些空格被当成内容截断」——
   * 症状是左半列凭空多一个 `…`（真机上看过一次）。整行补白由 `render()` 最后那一步做。
   */
  private renderRow(question: QuestionnaireQuestion, row: Row, cursor: number, width: number): string {
    const active = this.isRowActive(row);
    const marker = active ? cyan('❯') : ' ';
    if (row.kind === 'option') {
      const option = question.options[row.index];
      const checked = question.multiSelect ? (this.selectedIndexes().includes(row.index) ? green('[x]') : '[ ]') : `${row.index + 1}.`;
      const label = active ? bold(option?.label ?? '') : (option?.label ?? '');
      const description = option?.description === undefined || option.description === '' ? '' : ` ${dim(option.description)}`;
      const hasPreview = (option?.preview ?? '') !== '' ? dim(' ▸') : '';
      return truncateToWidth(`${marker} ${checked} ${label}${description}${hasPreview}`, width, '…');
    }
    if (row.kind === 'commit') {
      return truncateToWidth(`${marker} ${active ? bold('就这些（回车）') : '就这些（回车）'}`, width, '…');
    }
    if (this.inputMode) {
      const lines = this.input.render(Math.max(10, width - 4));
      return truncateToWidth(`${marker} ${cyan('✎')} ${lines[0] ?? ''}`, width, '…');
    }
    return truncateToWidth(`${marker} ${dim('Type something.')} ${dim('（直接打字）')}`, width, '…');
  }

  /** 预览块（用 pi 的 markdown 渲染器，代码块/表格都跟着主题走）。 */
  private renderPreview(text: string, width: number): string[] {
    if (text !== this.previewSource) {
      this.previewSource = text;
      this.preview.setText(text);
    }
    return this.preview.render(Math.max(10, width));
  }

  /** 底部一行：提示 + 未答计数。 */
  private renderFooter(width: number): string {
    const unanswered = this.snapshot.questions.length - this.answeredCount();
    const progress = unanswered === 0 ? green('已答完') : dim(`未答 ${unanswered}/${this.snapshot.questions.length}`);
    const keys =
      this.snapshot.active >= this.snapshot.questions.length
        ? 'Enter 提交 · ←/→ 切题 · Esc 放弃'
        : this.inputMode
          ? 'Enter 确认 · Esc 退出输入'
          : '←/→ 切题 · ↑↓ 选项 · Enter 选择 · Esc 放弃';
    const gap = Math.max(1, width - visibleWidth(keys) - visibleWidth(progress) - 1);
    return truncateToWidth(`${dim(keys)}${' '.repeat(gap)}${progress}`, width, '…', true);
  }

  /**
   * 正文最后一道封顶。
   *
   * **从上往下留**（题干与选项在最前面），不是从下往上砍 —— 砍尾巴砍掉的是预览，
   * 砍头砍掉的是"要按什么"，那是没法用的。到这一步还超，通常是没有预览的那些行
   * （题很长、选项说明很长）也撑爆了，所以也留一行说明。
   */
  private fit(body: string[], room: number): string[] {
    if (body.length <= room) return body;
    const kept = body.slice(0, Math.max(1, room - 1));
    return [...kept, dim(`… 还有 ${body.length - kept.length} 行（终端调高一点看全）`)];
  }

  // ── 按键 ────────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.inputMode) {
      if (matchesKey(data, 'enter')) {
        this.commitInput(this.input.getValue());
        return;
      }
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
        this.inputMode = false;
        return;
      }
      this.input.handleInput(data);
      return;
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.options.onIntent({ kind: 'cancel' });
      return;
    }
    if (matchesKey(data, 'left') || matchesKey(data, 'shift+tab')) {
      this.moveQuestion(-1);
      return;
    }
    if (matchesKey(data, 'right') || matchesKey(data, 'tab')) {
      this.moveQuestion(1);
      return;
    }
    // 提交页只剩"回车提交"和切题两件事。
    if (this.snapshot.active >= this.snapshot.questions.length) {
      if (matchesKey(data, 'enter')) this.options.onIntent({ kind: 'submit' });
      return;
    }
    const question = this.snapshot.questions[this.snapshot.active];
    if (question === undefined) return;
    const rows = this.rowsFor(question);
    if (matchesKey(data, 'up')) {
      this.setCursor(question, (this.cursorFor(question) - 1 + rows.length) % rows.length);
      return;
    }
    if (matchesKey(data, 'down')) {
      this.setCursor(question, (this.cursorFor(question) + 1) % rows.length);
      return;
    }
    const row = rows[this.cursorFor(question)];
    if (row === undefined) return;
    if (matchesKey(data, 'space') && row.kind === 'option' && question.multiSelect) {
      this.options.onIntent({ kind: 'toggle', index: row.index });
      return;
    }
    if (matchesKey(data, 'enter')) {
      if (row.kind === 'option') {
        this.options.onIntent(
          question.multiSelect ? { kind: 'toggle', index: row.index } : { kind: 'pick', index: row.index },
        );
        return;
      }
      if (row.kind === 'commit') {
        this.options.onIntent({ kind: 'commit' });
        return;
      }
      this.startInput('');
      return;
    }
    // 在 "Type something." 那一行上直接打字 = 进输入态（少按一次回车）。
    if (row.kind === 'other' && isPrintable(data)) this.startInput(data);
  }

  /** 进输入态：预填这一题已有的自定义答案。 */
  private startInput(seed: string): void {
    const existing = this.snapshot.answers[this.snapshot.active];
    const prefill =
      existing?.kind === 'custom'
        ? existing.text
        : existing?.kind === 'multi'
          ? existing.custom ?? ''
          : '';
    // 预填走 `handleInput` 而不是 `setValue`：`setValue` 只夹光标、不挪到末尾，
    // 于是在"编辑已有答案"时光标会停在开头，接着打的字跑到最前面去。
    this.input.setValue('');
    const text = seed === '' ? prefill : seed;
    if (text !== '') this.input.handleInput(text);
    this.inputMode = true;
  }

  /** 输入态回车：非空才算一个答案（空 = 什么都不改，退出输入）。 */
  private commitInput(value: string): void {
    this.inputMode = false;
    const text = value.trim();
    if (text === '') return;
    this.options.onIntent({ kind: 'custom', index: this.snapshot.active, text });
  }

  private moveQuestion(delta: number): void {
    const total = this.snapshot.questions.length;
    const next = this.snapshot.active + delta;
    if (next < 0 || next > total) return;
    this.options.onIntent({ kind: 'activate', index: next });
  }

  // ── 行模型 ──────────────────────────────────────────────────────────────

  private rowsFor(question: QuestionnaireQuestion): Row[] {
    const rows: Row[] = question.options.map((_, index) => ({ kind: 'option' as const, index }));
    rows.push({ kind: 'other' });
    if (question.multiSelect) rows.push({ kind: 'commit' });
    return rows;
  }

  private cursorFor(question: QuestionnaireQuestion): number {
    const rows = this.rowsFor(question);
    const stored = this.cursors[this.snapshot.active] ?? 0;
    // 答过的那一题：游标**落在答案上**（回看一眼时看到的就是它），而不是回到第 1 行。
    const answer = this.snapshot.answers[this.snapshot.active];
    if (stored === 0 && answer != null) {
      if (answer.kind === 'option') return Math.min(answer.index, rows.length - 1);
      if (answer.kind === 'custom') return rows.findIndex((row) => row.kind === 'other') >= 0 ? rows.length - 1 : 0;
      if (answer.kind === 'multi' && answer.custom !== undefined) return rows.length - 1;
    }
    return Math.min(stored, rows.length - 1);
  }

  private setCursor(question: QuestionnaireQuestion, value: number): void {
    this.cursors[this.snapshot.active] = value;
  }

  private isRowActive(row: Row): boolean {
    const question = this.snapshot.questions[this.snapshot.active];
    if (question === undefined) return false;
    const current = this.rowsFor(question)[this.cursorFor(question)];
    if (current === undefined || current.kind !== row.kind) return false;
    if (current.kind === 'option' && row.kind === 'option') return current.index === row.index;
    return true;
  }

  private selectedIndexes(): number[] {
    const answer = this.snapshot.answers[this.snapshot.active];
    return answer?.kind === 'multi' ? answer.selected : [];
  }

  private activeAnswerKind(): string {
    return this.snapshot.answers[this.snapshot.active]?.kind ?? 'none';
  }

  private answeredCount(): number {
    return this.snapshot.settled.filter((settled) => settled).length;
  }
}

/** 可打印的单字符输入（不是功能键的转义序列）。 */
function isPrintable(data: string): boolean {
  if (data.length === 0) return false;
  if (data.length > 1 && data.startsWith('\x1b')) return false;
  const code = data.codePointAt(0) ?? 0;
  return code >= 32 && code !== 127;
}

/**
 * 问卷（`ask_user_question` 那种多题提问）在**宿主这一侧**的状态。
 *
 * 分工：`ask_user_question` 是本项目内置的扩展（`@juicesharp/rpiv-ask-user-question` 的
 * pinned 依赖 + `patches/*.patch`），**终端那一份由扩展自己画**（多题 tab、预览面板、备注…），
 * **浏览器那一份由我们画**（`webui/questionnaire.ts` 的弹窗 + 桥上的 `ui-questionnaire` 帧）。
 * 两边同时开着同一份问卷，谁先答完都算数 —— 这是补丁里的握手段 `externalQuestionnaire`：
 *
 *   扩展 execute() → 题目交给我们（开浏览器那份）+ 挂它自己的组件（终端那份）
 *   谁先答：浏览器答 → handoff.answer(raw)（扩展收掉自己的组件继续）
 *           终端答   → handoff.done()（我们收掉浏览器那份）
 *
 * 答案只回**表面**上的东西（第几题、选了哪个 label、自定义原文、备注），扩展补丁里的
 * `toExternalResult` 负责翻成内部的 `QuestionnaireResult` —— 于是 core 不需要知道扩展内部的
 * 形状。
 *
 * 没答的题压根不出现在 `answers` 里（扩展的信封会把它们列成 `unanswered:`，与它自己那份
 * TUI 一致）；取消整份走 `cancelled`。
 */
export interface QuestionnaireOption {
  label: string;
  description: string;
  preview?: string;
}

/** 一道题。`multiSelect` 的题在扩展那边是另一套行（勾选框 + "就这些"）。 */
export interface QuestionnaireQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionnaireOption[];
}

/** 一道题的答案。`undefined`（快照里是 `null`）= 还没答。 */
export type QuestionnaireAnswer =
  | { kind: 'option'; index: number }
  | { kind: 'multi'; selected: number[]; custom?: string }
  | { kind: 'custom'; text: string };

/**
 * 界面 → 状态机。
 *
 * 两个渲染器（浏览器那份弹窗 + 桥后面的任何一块屏）发的是同一组意图 ——
 * 状态只有一份，它们各自把点击/按键变成意图交回来。
 */
export type QuestionnaireIntent =
  | { kind: 'activate'; index: number }
  | { kind: 'pick'; index: number }
  | { kind: 'toggle'; index: number }
  | { kind: 'custom'; index: number; text: string }
  | { kind: 'commit' }
  | { kind: 'note'; index: number; text: string }
  | { kind: 'globalNote'; text: string }
  | { kind: 'submit' }
  | { kind: 'cancel' };

/** 状态机 → 界面。**整份都能 JSON 序列化**（它要原样过 WebSocket 去浏览器）。 */
export interface QuestionnaireSnapshot {
  questions: readonly QuestionnaireQuestion[];
  /** 每题一个答案；`null` = 没答。 */
  answers: readonly (QuestionnaireAnswer | null)[];
  /**
   * 这一题**答定了**吗。
   *
   * 与 `answers` 分开是因为多选：勾一下就已经有"答案"了，但那一题还没答完（要回车）。
   * 分开之后，tab 上的 ✓ 与"未答 N/M"说的都是"答定了"；留空提交时也算"没答"。
   */
  settled: readonly boolean[];
  /** 每题一句备注（可空）。**有备注没答案也算没答**（信封那边只认答案）。 */
  notes: readonly (string | null)[];
  /** 提交页那句"整份备注"。 */
  globalNote: string;
  /** 当前停在第几题；`questions.length` = 提交页。 */
  active: number;
  submitted: boolean;
  cancelled: boolean;
}

/** 我们交给扩展的答案（**表面**形状，与补丁里的 `ExternalQuestionAnswer` 对应）。 */
export interface QuestionnaireAnswerPayload {
  answers: {
    questionIndex: number;
    kind: 'option' | 'custom' | 'multi';
    answer?: string | null;
    selected?: string[];
    notes?: string;
  }[];
  cancelled?: boolean;
  globalNote?: string;
}

/**
 * 扩展调 `ctx.ui.externalQuestionnaire(handoff)` 时给我们的东西（补丁里定义的形状）。
 *
 * `params` 是它归一化 + 校验过的题目；`answer` / `done` 是它给我们的两个动作。
 */
export interface ExternalQuestionnaireHandoff {
  params: unknown;
  answer: (raw: QuestionnaireAnswerPayload) => void;
  /**
   * 浏览器那份写了某题的备注 —— 同步进扩展自己那份 session（终端那边也看得到，
   * 而且万一是终端提交的，这条备注照样跟着答案回给模型）。
   *
   * `tab` 就是题号；**最后一个是整份备注**（与扩展内部 `notesByTab` 的伪下标一致）。
   */
  note: (tab: number, text: string) => void;
  done: () => void;
}

/** 一题最多几个选项 / 最多几题 —— 与扩展自己的 schema 同值（`tool/types.ts`）。 */
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

/**
 * 行终止符归一 —— 与扩展 `normalize-params.ts` 的 `normalizeLineTerminators` **逐字同规则**。
 *
 * 为什么照抄：扩展那边归一之后才把题干/选项交给它的组件与信封。我们渲染的是同一份内容，
 * 不归一的话浏览器里会看到终端里没有的 `\r`（它会把一行的后半截盖掉）。
 */
function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '');
}

/**
 * 把扩展交给我们的题目（`QuestionParams`）收成本项目的形状。
 *
 * 认不出就给 `undefined`（**不猜**）：那样这次就只剩终端那一份，浏览器那份不开 ——
 * 比画一份不存在的问卷强。
 */
export function parseQuestionnaire(input: unknown): QuestionnaireQuestion[] | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUESTIONS) return undefined;
  const questions: QuestionnaireQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return undefined;
    const q = item as { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown };
    if (typeof q.question !== 'string' || q.question.trim() === '') return undefined;
    if (q.header !== undefined && typeof q.header !== 'string') return undefined;
    const rawOptions = q.options;
    if (!Array.isArray(rawOptions) || rawOptions.length < MIN_OPTIONS || rawOptions.length > MAX_OPTIONS) {
      return undefined;
    }
    const options: QuestionnaireOption[] = [];
    for (const option of rawOptions) {
      if (typeof option !== 'object' || option === null) return undefined;
      const o = option as { label?: unknown; description?: unknown; preview?: unknown };
      if (typeof o.label !== 'string' || o.label.trim() === '') return undefined;
      if (o.description !== undefined && typeof o.description !== 'string') return undefined;
      if (o.preview !== undefined && typeof o.preview !== 'string') return undefined;
      options.push({
        label: normalizeText(o.label),
        description: typeof o.description === 'string' ? normalizeText(o.description) : '',
        ...(typeof o.preview === 'string' ? { preview: normalizeText(o.preview) } : {}),
      });
    }
    questions.push({
      question: normalizeText(q.question),
      header: typeof q.header === 'string' ? normalizeText(q.header) : '',
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return questions;
}

/**
 * 一份问卷的活状态：题目 + 每题答案 + 备注 + 当前停在哪 + 是否已提交/取消。
 *
 * 全部字段都能 JSON 序列化（"没答"用 `null` 而不是 `undefined`）—— 它要原样过 WebSocket。
 */
export class QuestionnaireSession {
  readonly questions: readonly QuestionnaireQuestion[];
  private readonly answerList: (QuestionnaireAnswer | undefined)[];
  private readonly settledFlags: boolean[];
  private readonly noteList: (string | undefined)[];
  private globalNoteText = '';
  private activeIndex = 0;
  private submittedFlag = false;
  private cancelledFlag = false;
  private readonly listeners = new Set<(snapshot: QuestionnaireSnapshot) => void>();

  constructor(questions: readonly QuestionnaireQuestion[]) {
    if (questions.length === 0) throw new Error('问卷至少要有一道题');
    this.questions = [...questions];
    this.answerList = questions.map(() => undefined);
    this.settledFlags = questions.map(() => false);
    this.noteList = questions.map(() => undefined);
  }

  /** 提交页的"题号" —— 与 `questions.length` 同值（它是最后一个 tab）。 */
  get submitIndex(): number {
    return this.questions.length;
  }

  get submitted(): boolean {
    return this.submittedFlag;
  }

  get cancelled(): boolean {
    return this.cancelledFlag;
  }

  get finished(): boolean {
    return this.submittedFlag || this.cancelledFlag;
  }

  /** 答定了几题（备注不算）。 */
  get answeredCount(): number {
    return this.settledFlags.filter((settled) => settled).length;
  }

  unanswered(): number[] {
    const indexes: number[] = [];
    this.settledFlags.forEach((settled, index) => {
      if (!settled) indexes.push(index);
    });
    return indexes;
  }

  answerOf(index: number): QuestionnaireAnswer | undefined {
    return this.answerList[index];
  }

  noteOf(index: number): string | undefined {
    return this.noteList[index];
  }

  get globalNote(): string {
    return this.globalNoteText;
  }

  snapshot(): QuestionnaireSnapshot {
    return {
      questions: this.questions,
      answers: this.answerList.map((answer) => answer ?? null),
      settled: [...this.settledFlags],
      notes: this.noteList.map((note) => note ?? null),
      globalNote: this.globalNoteText,
      active: this.activeIndex,
      submitted: this.submittedFlag,
      cancelled: this.cancelledFlag,
    };
  }

  /**
   * 交给扩展的答案（表面形状）。**没答的题不出现** —— 扩展会把它们列成 `unanswered:`。
   */
  payload(): QuestionnaireAnswerPayload {
    const notes = (index: number): { notes?: string } => {
      const note = this.noteList[index];
      return note !== undefined && note.trim() !== '' ? { notes: note } : {};
    };
    if (this.cancelledFlag) {
      return {
        answers: [],
        cancelled: true,
        ...(this.globalNoteText.trim() === '' ? {} : { globalNote: this.globalNoteText }),
      };
    }
    const answers: QuestionnaireAnswerPayload['answers'] = [];
    this.questions.forEach((question, index) => {
      const answer = this.answerList[index];
      if (answer === undefined) return;
      const base = { questionIndex: index, ...notes(index) };
      if (answer.kind === 'option') {
        answers.push({ ...base, kind: 'option', answer: question.options[answer.index]?.label ?? '' });
        return;
      }
      if (answer.kind === 'custom') {
        answers.push({ ...base, kind: 'custom', answer: answer.text });
        return;
      }
      const labels = answer.selected.map((i) => question.options[i]?.label ?? '');
      const custom = answer.custom?.trim() ?? '';
      answers.push({ ...base, kind: 'multi', selected: custom === '' ? labels : [...labels, custom] });
    });
    return {
      answers,
      ...(this.globalNoteText.trim() === '' ? {} : { globalNote: this.globalNoteText }),
    };
  }

  subscribe(listener: (snapshot: QuestionnaireSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 推进状态。返回是否真的变了（渲染器据此决定要不要重画）。
   *
   * 意图都是**外部**来的（点击 / 按键），所以这里对每一档都挡住越界与非法组合 ——
   * 那是所有渲染器唯一需要共同遵守的规则集，写一份比各写一份稳。
   */
  apply(intent: QuestionnaireIntent): boolean {
    if (this.finished) return false;
    switch (intent.kind) {
      case 'activate': {
        const next = Math.min(Math.max(intent.index, 0), this.submitIndex);
        if (next === this.activeIndex) return false;
        // 离开一道题时把它的草稿"落实"：多选勾完直接切题（不按回车）也算答定了 ——
        // 否则用户会卡在提交页上（"还有 1 题没答"，而屏幕上那道题看着已经选好了）。
        if (this.answerList[this.activeIndex] !== undefined) this.settledFlags[this.activeIndex] = true;
        this.activeIndex = next;
        break;
      }
      case 'pick': {
        const question = this.questions[this.activeIndex];
        if (question === undefined || question.multiSelect) return false;
        if (intent.index < 0 || intent.index >= question.options.length) return false;
        this.answerList[this.activeIndex] = { kind: 'option', index: intent.index };
        this.settledFlags[this.activeIndex] = true;
        // 单选一选定就是「这题答完了」—— 直接进**下一页**（与扩展自己那份的
        // `computeAutoAdvanceTab` 同一条规则：最后一题答完就落到提交页）。键盘重复已经把
        // 「一下回车推进两页」滤掉了，所以提交仍然只能在提交页上手动按。
        this.activeIndex = Math.min(this.activeIndex + 1, this.submitIndex);
        break;
      }
      case 'toggle': {
        const question = this.questions[this.activeIndex];
        if (question === undefined || !question.multiSelect) return false;
        if (intent.index < 0 || intent.index >= question.options.length) return false;
        const current = this.answerList[this.activeIndex];
        const selected = current?.kind === 'multi' ? [...current.selected] : [];
        const at = selected.indexOf(intent.index);
        if (at >= 0) selected.splice(at, 1);
        else selected.push(intent.index);
        selected.sort((a, b) => a - b);
        this.answerList[this.activeIndex] = {
          kind: 'multi',
          selected,
          ...(current?.kind === 'multi' && current.custom !== undefined ? { custom: current.custom } : {}),
        };
        // 勾选是草稿：还不算答定（要回车/切题才算），否则第一个勾就把半成品交出去了。
        break;
      }
      case 'custom': {
        const question = this.questions[this.activeIndex];
        if (question === undefined) return false;
        const text = intent.text;
        if (text.trim() === '') {
          // 清空 = 这题回到"没答"。
          if (question.multiSelect) {
            const current = this.answerList[this.activeIndex];
            const selected = current?.kind === 'multi' ? current.selected : [];
            this.answerList[this.activeIndex] = selected.length === 0 ? undefined : { kind: 'multi', selected };
          } else {
            this.answerList[this.activeIndex] = undefined;
          }
          this.settledFlags[this.activeIndex] = false;
          break;
        }
        const current = this.answerList[this.activeIndex];
        this.answerList[this.activeIndex] = question.multiSelect
          ? { kind: 'multi', selected: current?.kind === 'multi' ? [...current.selected] : [], custom: text }
          : { kind: 'custom', text };
        this.settledFlags[this.activeIndex] = true;
        // 自定义答案也是"这题答完了"（同样进下一页，最后一题落到提交页）。
        this.activeIndex = Math.min(this.activeIndex + 1, this.submitIndex);
        break;
      }
      case 'commit': {
        // 多选才需要它：勾选是"还在这一题上改"，回车才是这一题的答案。
        // 一个都没勾也算答案（扩展那边由空 selected 表达）—— 拒绝它的话用户就无法
        // 表达"这些我都不要"。
        const question = this.questions[this.activeIndex];
        if (question === undefined) return false;
        if (question.multiSelect) {
          const current = this.answerList[this.activeIndex];
          const selected = current?.kind === 'multi' ? current.selected : [];
          this.answerList[this.activeIndex] = {
            kind: 'multi',
            selected,
            ...(current?.kind === 'multi' && current.custom !== undefined ? { custom: current.custom } : {}),
          };
        } else if (this.answerList[this.activeIndex] === undefined) {
          // 单选什么都没选就按回车：不前进（否则像是答过了）。
          return false;
        }
        this.settledFlags[this.activeIndex] = true;
        // 多选的"就这些"回车：进下一页（最后一题 → 提交页）。
        this.activeIndex = Math.min(this.activeIndex + 1, this.submitIndex);
        break;
      }
      case 'note': {
        if (intent.index < 0 || intent.index >= this.questions.length) return false;
        const text = intent.text.trim() === '' ? undefined : intent.text;
        if ((this.noteList[intent.index] ?? '') === (text ?? '')) return false;
        this.noteList[intent.index] = text;
        break;
      }
      case 'globalNote': {
        if (this.globalNoteText === intent.text) return false;
        this.globalNoteText = intent.text;
        break;
      }
      case 'submit': {
        // **留空也能提交**（扩展的信封会把这些题列成 `unanswered:`）—— 与它自己那份
        // TUI 一致。真正什么都没答也没备注时，扩展那边会退化成"用户拒绝了"。
        this.submittedFlag = true;
        break;
      }
      case 'cancel': {
        this.cancelledFlag = true;
        break;
      }
      default:
        return false;
    }
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // 一块屏画挂了不该把另一块也带走（更不该把用户的答案弄丢）。
      }
    }
    return true;
  }
}

/** 界面层给的"开一份浏览器问卷视图"，返回拆台函数。 */
export type OpenQuestionnaireView = (session: QuestionnaireSession) => () => void;

/** 扩展拿到的那一半（现在什么也不必回，留着给以后加能力）。 */
export interface ExternalQuestionnaireBridge {
  done?: () => void;
}

/**
/**
 * 宿主侧的问卷：接住扩展交过来的题目、开浏览器那一份、把答案回给扩展。
 *
 * 输入是**权威**的：题目来自扩展归一化 + 校验之后的 `params`，不必按标题前缀猜
 * 「这次 select 是不是这份问卷的」。
 */
export class QuestionnaireHost {
  private session: QuestionnaireSession | undefined;
  private view: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private handoff: ExternalQuestionnaireHandoff | undefined;

  /**
   * @param openView 界面层那份浏览器视图（可缺省：没有界面时只是浏览器没人答，
   *                 终端那份照样由扩展自己画）。
   */
  constructor(private readonly openView?: (() => OpenQuestionnaireView | undefined) | undefined) {}

  /** 扩展调 `ctx.ui.externalQuestionnaire(handoff)`。 */
  open(handoff: ExternalQuestionnaireHandoff): ExternalQuestionnaireBridge {
    // 扩展在 finally 里会调我们这次返回的 `done()`：终端那一份结束了 → 收掉浏览器这份。
    // 按 handoff 的**身份**判断，而不是"现在有没有问卷在跑" —— 上一份收了之后模型可能
    // 又问了一份，那时旧的那次 done() 不该把新的一份关掉。
    const done = (): void => {
      if (this.handoff === handoff) this.release();
    };
    const questions = parseQuestionnaire(handoff.params);
    if (questions === undefined) {
      // 认不出：这一份我们画不了。浏览器本来就没开 —— 不做任何假设，也不接管 done()。
      return {};
    }
    this.release();
    const session = new QuestionnaireSession(questions);
    this.session = session;
    this.handoff = handoff;
    this.view = this.openView?.()?.(session);
    // 备注是**实时**同步过去的（答案要等提交）：扩展那边把它写进自己的 `notesByTab`，
    // 于是终端面板上看得见同一条，而且万一最后是终端那边答的，备注不会白写。
    const forwarded: string[] = questions.map((_, index) => session.snapshot().notes[index] ?? '');
    let forwardedGlobal = session.globalNote;
    const forwardNotes = (): void => {
      const current = session.snapshot();
      current.notes.forEach((note, index) => {
        const text = note ?? '';
        if (text === forwarded[index]) return;
        forwarded[index] = text;
        try {
          handoff.note(index, text);
        } catch {
          // 同步备注失败不该影响答案本身。
        }
      });
      if (current.globalNote !== forwardedGlobal) {
        forwardedGlobal = current.globalNote;
        try {
          handoff.note(current.questions.length, current.globalNote);
        } catch {
          // 同上。
        }
      }
    };
    this.unsubscribe = session.subscribe(() => {
      // 提交 / 取消就是这一份结束了：把答案回给扩展（它那边会收掉自己的组件）。
      if (session.finished) {
        this.currentAnswer();
        return;
      }
      forwardNotes();
    });
    return { done };
  }

  /** 现在有问卷在跑吗（界面/测试用）。 */
  current(): QuestionnaireSession | undefined {
    return this.session?.finished === true ? undefined : this.session;
  }

  /** 扩展那边结束了（`handoff.done`）—— 收掉浏览器那一份。 */
  close(): void {
    this.release();
  }

  /** 状态机走到提交/取消时把答案交回去，并且只交一次。 */
  private currentAnswer(): void {
    const session = this.session;
    const handoff = this.handoff;
    if (session === undefined || handoff === undefined) return;
    // 先记住再清：`answer` 是扩展那边收尾的入口，它可能又回调到我们（幂等）。
    this.session = undefined;
    this.handoff = undefined;
    const view = this.view;
    const unsubscribe = this.unsubscribe;
    this.view = undefined;
    this.unsubscribe = undefined;
    try {
      unsubscribe?.();
    } catch {
      // 退订失败不该把答案弄丢。
    }
    try {
      view?.();
    } catch {
      // 拆浏览器那份失败同理。
    }
    try {
      handoff.answer(session.payload());
    } catch {
      // 交答案失败：扩展那边会走它自己的收尾（`done`）。
    }
  }

  /** 拆浏览器那一份、忘掉这一份状态（幂等）。 */
  private release(): void {
    const view = this.view;
    const unsubscribe = this.unsubscribe;
    this.session = undefined;
    this.handoff = undefined;
    this.view = undefined;
    this.unsubscribe = undefined;
    try {
      unsubscribe?.();
    } catch {
      // 同上。
    }
    try {
      view?.();
    } catch {
      // 同上。
    }
  }
}

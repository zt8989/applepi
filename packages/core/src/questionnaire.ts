/**
 * 问卷（`ask_user_question` 那类多题带 tab 的提问）在**宿主这一侧**的状态机。
 *
 * ## 为什么要有这个文件：同一份问卷，两个渲染器
 *
 * 扩展在 `ctx.mode === 'rpc'` 时不用它自己的组件，而是拿 `ctx.ui.select/input`
 * **逐题**问（`rpc-fallback.ts` 的 `runRpcQuestionnaire`）。那套原语是「一次一问、
 * 答完即提交」，于是终端与浏览器各自弹一个单题对话框 —— 没有 tab、回不去、
 * 自定义答案要再开一个输入框（`docs/architecture/webui.md` 里记着这笔代价）。
 *
 * 这里把那些**逐题**原语重新拼成一份问卷：题目一次性拿全，界面一次画完
 * （左右切题、就地输入自定义答案、最后一屏统一提交），提交之后再把答案
 * **按扩展问的顺序**逐题喂回去。扩展那一侧完全不知道发生了什么 —— 它看到的
 * 仍然是自己那 N 次 `select` / `input`。
 *
 * ## 状态在 core，视图在界面层
 *
 * 状态机（这里）不碰 pi-tui、不碰 WebSocket：它只有快照 + 意图。终端那份组件与
 * 浏览器那份弹窗都是**订阅同一份快照**的渲染器，各自把用户的动作变成意图交回来。
 * 于是两端不会分叉（早先 `raceDialog` 那种「两个弹窗各答各的、谁先答谁算数」
 * 在问卷上会看到两套进度）—— 现在是**一份进度，两块屏幕**。
 *
 * ## 答案怎么"变回"扩展认识的那些字符串
 *
 * 这是本文件唯一一处**逆向**的知识，写在 `QuestionnaireHost.serve` 里：
 *
 * | 题的种类 | 扩展问的方式 | 我们交回去的 |
 * | --- | --- | --- |
 * | 单选 | `select(title, options)`，`options` = 选项行 + 末尾那个 "Type something." 哨兵 | 选中的**那一行原文**；自定义答案给**原文**（不匹配任何行 → 扩展判成 `kind:'custom'`） |
 * | 多选 | `input(title, placeholder)` | 勾选的序号 `"1,3"`（`askMultiSelect` 解析）；自定义答案给原文；一个没勾给空串（它自己写的"Deliberate empty commit"） |
 *
 * 全是**公开的调用语义**，不涉及扩展内部的 `QuestionnaireResult`（不合成那个对象）。
 *
 * ## 认领：哪一次 `select` 属于这份问卷
 *
 * `select`/`input` 是通用原语，别的扩展也在用（`pi-web-access` 的面板等等）。所以
 * 认领要**证据**，不能只看"现在有问卷在等"：
 *
 * 1. 正在跑的扩展工具里有一个的入参**结构像**问卷（`questions[]`，每题
 *    `question` + `options[].label/description`）—— 这就是题目与 `preview` 正文的来源；
 * 2. 那一次 `select` 的标题**对得上**这一题的 `[header] question` 前缀。
 *
 * 对不上就返回 `undefined`：退回原来那条逐题对话框的路（那是**以前的行为**，
 * 所以解析不出来时不会更糟）。
 */
/** 一个选项：显示用的标签 + 说明 + 可选的预览正文（markdown）。 */
export interface QuestionnaireOption {
  label: string;
  description: string;
  preview?: string;
}

/** 一道题。`multiSelect` 的题在扩展那边是**另一次原语调用**（`input` 而不是 `select`）。 */
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

/** 界面 → 状态机。两个渲染器（终端 / 浏览器）发的是同一组意图。 */
export type QuestionnaireIntent =
  | { kind: 'activate'; index: number }
  | { kind: 'pick'; index: number }
  | { kind: 'toggle'; index: number }
  | { kind: 'custom'; index: number; text: string }
  | { kind: 'commit' }
  | { kind: 'submit' }
  | { kind: 'cancel' };

/** 状态机 → 界面。**整份都能 JSON 序列化**（它要原样过 WebSocket 去浏览器）。 */
export interface QuestionnaireSnapshot {
  questions: readonly QuestionnaireQuestion[];
  /** 每题一个答案；`null` = 没答（`undefined` 过不了 JSON）。 */
  answers: readonly (QuestionnaireAnswer | null)[];
  /**
   * 这一题**答定了**吗。
   *
   * 与 `answers` 分开是因为多选：勾一下就已经有"答案"了，但那一题还没答完
   * （扩展那边要回车才算）。分开之后，tab 上的 ✓ 与"未答 N/M"说的都是"答定了"，
   * 而 `waitFor` 也只认答定 —— 不分开的话多选勾下第一项的那一瞬就把半成品
   * 交给扩展了。
   */
  settled: readonly boolean[];
  /** 当前停在第几题；`questions.length` = 提交页。 */
  active: number;
  submitted: boolean;
  cancelled: boolean;
}

/** 界面层交给 core 的"开一份问卷视图"（终端 + 浏览器两个渲染器都归它管）。 */
export type OpenQuestionnaireView = (session: QuestionnaireSession) => () => void;

/** 一题最多几个选项 / 最多几题 —— 与扩展自己的 schema 同值（`tool/types.ts`）。 */
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

/**
 * 行终止符归一 —— 与扩展 `normalize-params.ts` 的 `normalizeLineTerminators` **逐字同规则**。
 *
 * 为什么必须一致：标题对得上是"这一次 `select` 属于这份问卷"的唯一证据，而扩展那边
 * 归一之后才拿 `question` 去拼标题。我们拿的是工具入参（可能还带 `\r`），不归一就
 * 对不上 —— 症状是**问卷不生效，退回逐题弹窗**，且没有任何报错。
 */
function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '');
}

/**
 * 从一次扩展工具调用的入参里认出问卷。
 *
 * 认不出（形状不对、题数/选项数越界、字段类型不对）就给 `undefined` —— 调用方据此
 * 退回普通对话框。**宁可退回，也不要"猜着画"**：猜错的话用户答的是一份不存在的问卷，
 * 而模型收到的是别的东西。
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

/** 扩展拼标题的那个前缀：`[header] question`（`ask-user-question.ts` 里逐字同形）。 */
export function questionTitlePrefix(question: QuestionnaireQuestion): string {
  return `${question.header === '' ? '' : `[${question.header}] `}${question.question}`;
}

/**
 * 这一次 `select` / `input` 的标题是不是第 `index` 题的。
 *
 * 只比对**前缀**：扩展会在后面接 `\n\n--- 1. label preview ---\n…`（预览块的折叠形态），
 * 那是它自己的排版，我们不复刻。
 */
export function titleMatches(question: QuestionnaireQuestion, title: string): boolean {
  const prefix = normalizeText(questionTitlePrefix(question));
  const normalized = normalizeText(title);
  if (normalized.startsWith(prefix)) return true;
  // 扩展可能把题干尾部截掉（超长标题）——两头都收紧一次再试，避免"因为差一个空格就退回逐题弹窗"。
  return normalized.trimStart().startsWith(prefix.trim());
}

/**
 * 一份问卷的活状态：题目 + 每题答案 + 当前停在哪 + 是否已提交/取消。
 *
 * 全部字段都能 JSON 序列化（答案里的"没答"用 `null` 而不是 `undefined`）——
 * 它要原样过 WebSocket 去浏览器。
 */
export class QuestionnaireSession {
  readonly questions: readonly QuestionnaireQuestion[];
  private readonly answerList: (QuestionnaireAnswer | undefined)[];
  private readonly settledFlags: boolean[];
  private activeIndex = 0;
  private submittedFlag = false;
  private cancelledFlag = false;
  private readonly listeners = new Set<(snapshot: QuestionnaireSnapshot) => void>();
  private readonly waiters = new Set<() => void>();

  constructor(questions: readonly QuestionnaireQuestion[]) {
    if (questions.length === 0) throw new Error('问卷至少要有一道题');
    this.questions = [...questions];
    this.answerList = questions.map(() => undefined);
    this.settledFlags = questions.map(() => false);
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

  /** 整份结束了吗（提交或取消）。 */
  get finished(): boolean {
    return this.submittedFlag || this.cancelledFlag;
  }

  get complete(): boolean {
    return this.settledFlags.every((settled) => settled);
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

  snapshot(): QuestionnaireSnapshot {
    return {
      questions: this.questions,
      answers: this.answerList.map((answer) => answer ?? null),
      settled: [...this.settledFlags],
      active: this.activeIndex,
      submitted: this.submittedFlag,
      cancelled: this.cancelledFlag,
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
   * 意图都是**外部**来的（终端按键 / 浏览器点击），所以这里对每一档都要挡住越界与
   * 非法组合 —— 那也是两个渲染器唯一需要共同遵守的规则集，写一份比各写一份稳。
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
        // 单选一选定就是"这题答完了" —— 直接进下一题（与扩展自己那份的节奏一致）。
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
        this.answerList[this.activeIndex] = question.multiSelect
          ? {
              kind: 'multi',
              selected: (() => {
                const current = this.answerList[this.activeIndex];
                return current?.kind === 'multi' ? [...current.selected] : [];
              })(),
              custom: text,
            }
          : { kind: 'custom', text };
        this.settledFlags[this.activeIndex] = true;
        // 自定义答案也是"这题答完了"。
        this.activeIndex = Math.min(this.activeIndex + 1, this.submitIndex);
        break;
      }
      case 'commit': {
        // 多选才需要它：勾选是"还在这一题上改"，回车才是这一题的答案。
        // 一个都没勾也算答案（扩展那边由空串表达，它自己写的 "deliberate empty commit"）——
        // 拒绝它的话用户就无法表达"这些我都不要"。
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
        this.activeIndex = Math.min(this.activeIndex + 1, this.submitIndex);
        break;
      }
      case 'submit': {
        // **答不全不许提交**：未答的题在 `select`/`input` 上没有"空答案"这种表示
        // （空串/undefined 都会被扩展判成"整份取消"），所以留空提交只会变成
        // "用户拒绝回答"。要留空就得走合成结果那条路，那是另一个方案，这里不做。
        if (!this.complete) return false;
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
        // 一个渲染器画挂了不该把另一个也带走（更不该把用户的答案弄丢）。
      }
    }
    this.wake();
    return true;
  }

  /**
   * 等第 `index` 题的答案落定（或整份取消）。
   *
   * `undefined` 表示"整份取消" —— 调用方据此给扩展 `undefined`（它的语义就是
   * "用户取消了整份问卷"）。这条路径**只在提交之后**才会被问到，因为提交要求全答完，
   * 所以第 2..N 题拿到的都是现成答案，立刻就 resolve。
   */
  waitFor(index: number, signal?: AbortSignal | undefined): Promise<QuestionnaireAnswer | undefined> {
    const settled = (): QuestionnaireAnswer | undefined => {
      if (this.cancelledFlag) return undefined;
      return this.settledFlags[index] === true ? this.answerList[index] : undefined;
    };
    const ready = settled();
    if (ready !== undefined || this.cancelledFlag || this.submittedFlag) return Promise.resolve(ready);
    if (signal?.aborted === true) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const wake = (): void => {
        const answer = settled();
        if (answer === undefined && !this.cancelledFlag) return;
        this.waiters.delete(wake);
        signal?.removeEventListener('abort', onAbort);
        resolve(answer);
      };
      const onAbort = (): void => {
        this.waiters.delete(wake);
        resolve(undefined);
      };
      this.waiters.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** 有新状态了 —— 把等着的 `waitFor` 叫醒（满足条件的自己摘掉自己）。 */
  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}

/** 一次正在跑的扩展工具调用（只为"这是哪份问卷"提供证据）。 */
interface InFlightToolCall {
  name: string;
  input: unknown;
}

/**
 * 问卷的宿主侧状态：正在跑的扩展工具 + 当前那份问卷。
 *
 * 内核装配时造一个，**同时**给两处用：
 * - `adaptExtensionTool`：工具开跑/收尾时记一下（题目与 `preview` 正文的来源）；
 * - `createHostUi`：`select`/`input` 被调用时来认领、来取答案。
 *
 * 两处拿的是**同一个实例** —— 分两份的话认领就永远失败。
 */
export class QuestionnaireHost {
  private readonly inFlight = new Map<string, InFlightToolCall>();
  private session: QuestionnaireSession | undefined;
  /** 这份问卷已经服务到第几问（扩展是 0,1,2… 顺序问的）。 */
  private askIndex = 0;
  /** 属于这份问卷的那次工具调用（它收尾 = 整份结束，视图该拆了）。 */
  private sessionToolCallId: string | undefined;
  /** 界面层给的拆台函数（`HostUiOptions.questionnaire` 的返回值）。 */
  private teardown: (() => void) | undefined;

  /** 界面层能画问卷吗（`HostUiOptions.questionnaire` 给了没）。**惰性读**：那份 options
   * 在界面起来之前是空的（与 `ctx.ui.custom()` 同一个道理，见 `extension-ui.ts`）。 */
  constructor(private readonly openView?: (() => OpenQuestionnaireView | undefined) | undefined) {}

  /** 工具开跑。 */
  noteToolCall(toolCallId: string, name: string, input: unknown): void {
    this.inFlight.set(toolCallId, { name, input });
  }

  /** 工具收尾 —— 属于当前问卷的那次收尾就把整份收掉。 */
  settleToolCall(toolCallId: string): void {
    this.inFlight.delete(toolCallId);
    if (toolCallId === this.sessionToolCallId) this.release();
  }

  /** 现在有问卷在跑吗（界面/测试用）。 */
  current(): QuestionnaireSession | undefined {
    return this.session?.finished === true ? undefined : this.session;
  }

  /**
   * 认领一次 `select` / `input`，认领到了就把答案交回去。
   *
   * ## 为什么是**同步**返回一个 Promise（而不是 async）
   *
   * `undefined` = "这不是问卷的问法"，调用方**当场**走逐题对话框那条路。要是这里写成
   * `async`，那个 `undefined` 会晚一个微任务才回来，于是别的扩展的对话框被整体推迟一拍
   * —— 界面上看不出差别，但"窗口是什么时候开的"就不再是同步的了（测试里那些
   * "调用之后就断言组件已经挂上"的写法全会碎）。
   */
  tryServe(
    kind: 'select' | 'input',
    title: string,
    options: readonly string[],
    signal?: AbortSignal | undefined,
  ): Promise<string | undefined> | undefined {
    if (this.openView?.() === undefined) return undefined;
    const index = this.claim(kind, title);
    if (index === undefined) return undefined;
    const session = this.session;
    if (session === undefined) return undefined;
    return (async () => {
      const answer = await session.waitFor(index, signal);
      if (signal?.aborted === true) {
        // 整轮被中断（Ctrl+C / 工具被取消）：问卷也没意义了，视图一起收掉。
        session.apply({ kind: 'cancel' });
        this.release();
        return undefined;
      }
      return this.encode(kind, index, answer, options);
    })();
  }

  /** 认领并返回题号；认不出时 `undefined`（并保持现状不动）。 */
  private claim(kind: 'select' | 'input', title: string): number | undefined {
    // 已经提交/取消的那一份**不在这里收掉**：扩展还在按顺序问（提交只是把答案一次给全，
    // 后面那几问得从这份已答的会话里取）。收掉的话第二问就认不回，会退化成逐题弹窗 ——
    // 而那时已经没有人在答题了，弹窗只会挂在那里。真正的收尾在 `settleToolCall`
    // （工具真的跑完了）与中断那一条路上。
    if (this.session === undefined) {
      const found = this.findCandidate(title);
      if (found === undefined) return undefined;
      if (found.question.multiSelect !== (kind === 'input')) return undefined;
      this.session = new QuestionnaireSession(found.questions);
      this.sessionToolCallId = found.toolCallId;
      this.askIndex = 1;
      this.teardown = this.openView?.()?.(this.session);
      return 0;
    }
    const index = this.askIndex;
    const question = this.session.questions[index];
    if (question === undefined) return undefined;
    if (!titleMatches(question, title)) return undefined;
    if (question.multiSelect !== (kind === 'input')) return undefined;
    this.askIndex = index + 1;
    return index;
  }

  /** 正在跑的扩展工具里，哪一次的入参既像问卷、第一题的标题又对得上。 */
  private findCandidate(
    title: string,
  ): { toolCallId: string; questions: QuestionnaireQuestion[]; question: QuestionnaireQuestion } | undefined {
    for (const [toolCallId, call] of this.inFlight) {
      const questions = parseQuestionnaire(call.input);
      if (questions === undefined) continue;
      const first = questions[0];
      if (first === undefined || !titleMatches(first, title)) continue;
      return { toolCallId, questions, question: first };
    }
    return undefined;
  }

  /** 把答案翻回扩展认识的那些字符串（见文件头那张表）。 */
  private encode(
    kind: 'select' | 'input',
    index: number,
    answer: QuestionnaireAnswer | undefined,
    options: readonly string[],
  ): string | undefined {
    if (answer === undefined) return undefined; // 整份取消 → 扩展的 undefined
    if (kind === 'select') {
      if (answer.kind === 'option') {
        // 交**那一行原文**（扩展靠 `options.indexOf(chosen)` 认选项，自己拼一遍会漂）。
        const line = options[answer.index];
        return line ?? undefined;
      }
      if (answer.kind === 'custom') return answer.text;
      // 多选答案落到单选问法上（不该发生）：当成自定义原文，至少不丢用户的输入。
      return answer.custom ?? answer.selected.map((i) => i + 1).join(',');
    }
    if (answer.kind === 'multi') {
      if (answer.custom !== undefined && answer.custom.trim() !== '') return answer.custom;
      // 一个没勾 = 空串（扩展自己写的 "deliberate empty commit"）。
      return answer.selected.map((i) => i + 1).join(',');
    }
    if (answer.kind === 'custom') return answer.text;
    // 单选答案落到多选问法上：把选项标签交给它（它读不出序号就当成自定义原文）。
    const question = this.session?.questions[index];
    return question?.options[answer.index]?.label;
  }

  /** 拆视图、清状态（整份结束）。 */
  private release(): void {
    const teardown = this.teardown;
    this.teardown = undefined;
    this.session = undefined;
    this.sessionToolCallId = undefined;
    this.askIndex = 0;
    try {
      teardown?.();
    } catch {
      // 拆台失败不该影响工具收尾。
    }
  }
}

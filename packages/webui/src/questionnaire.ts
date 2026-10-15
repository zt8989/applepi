/**
 * 问卷（多题 tab）在浏览器里的呈现 —— 与终端那份 `questionnaire.ts` **同一份状态**。
 *
 * ## 为什么不是"每题一个弹窗"
 *
 * 扩展在 rpc 模式下是拿 `ctx.ui.select` / `ctx.ui.input` 逐题问的；照原样弹就是一串
 * 单题对话框：不能切题、看不到还有几题、自定义答案还要再点开一个输入框。这里把它
 * 拼回一份表：上面 tab（左右切题）、中间选项（单选点一下、多选打勾）、选中带 preview
 * 的选项时右/下面给预览、最后一屏是提交汇总。
 *
 * ## 它不是状态的所有者
 *
 * 服务端（`@ela/core/questionnaire` 的 `QuestionnaireSession`）才是。这里做两件事：
 * 把快照画出来、把点击变成**意图**发回去（`activate` / `pick` / `toggle` / `custom` /
 * `commit` / `submit` / `cancel`）。所以终端那边改了，这块屏下一帧就跟上。
 *
 * **只有两样东西是本地的**：光标停在哪个选项上，以及正在输入的自定义答案草稿。
 * 前者是"这块屏看到哪儿"，后者是"还没按回车、不算答案"。它们不进快照，也不该进 ——
 * 否则两端会互相抢光标。
 */
import type { QuestionnaireIntent, QuestionnaireSnapshot } from '@ela/core/questionnaire';

export interface QuestionnaireModalOptions {
  snapshot: QuestionnaireSnapshot;
  onIntent: (intent: QuestionnaireIntent) => void;
}

export interface QuestionnaireModalHandle {
  /** 服务端推了新快照。 */
  push(snapshot: QuestionnaireSnapshot): void;
  /** 拆掉 DOM（服务端说结束了）。不产生任何意图。 */
  close(): void;
}

/** 一题里的"行"：某个选项 / 自定义输入行 / 多选的"就这些"行（与终端同一套）。 */
type Row = { kind: 'option'; index: number } | { kind: 'custom' } | { kind: 'commit' };

const OTHER_LABEL = 'Type something.';

export function openQuestionnaireModal(options: QuestionnaireModalOptions): QuestionnaireModalHandle {
  let snapshot = options.snapshot;
  /** 每题自己的光标（切回来时"我上次停在第 3 项"还在）。 */
  const cursors: number[] = snapshot.questions.map(() => 0);
  /** 每题的草稿（没按回车之前不算答案）。 */
  const drafts: string[] = snapshot.questions.map(() => '');
  let editing = false;

  const backdrop = document.createElement('div');
  backdrop.className = 'ela-modal-backdrop';
  const panel = document.createElement('div');
  panel.className = 'ela-modal ela-q';
  const tabs = document.createElement('div');
  tabs.className = 'ela-q-tabs';
  const body = document.createElement('div');
  body.className = 'ela-q-body';
  const footer = document.createElement('div');
  footer.className = 'ela-q-footer';
  panel.append(tabs, body, footer);
  backdrop.append(panel);
  document.body.append(backdrop);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    backdrop.remove();
  };

  const emit = (intent: QuestionnaireIntent): void => {
    options.onIntent(intent);
  };

  const activeQuestion = () => snapshot.questions[snapshot.active];
  const onSubmitTab = (): boolean => snapshot.active >= snapshot.questions.length;
  const rowsFor = (index: number): Row[] => {
    const question = snapshot.questions[index];
    if (question === undefined) return [];
    const rows: Row[] = question.options.map((_, index) => ({ kind: 'option', index }));
    rows.push({ kind: 'custom' });
    // 多选要一行"就这些"：勾选是草稿，回车/点它才算这一题答完（与终端一致）。
    if (question.multiSelect) rows.push({ kind: 'commit' });
    return rows;
  };
  const cursor = (): number => {
    const total = rowsFor(snapshot.active).length;
    const stored = cursors[snapshot.active] ?? 0;
    return Math.min(stored, Math.max(0, total - 1));
  };
  const setCursor = (value: number): void => {
    const total = rowsFor(snapshot.active).length;
    if (total === 0) return;
    cursors[snapshot.active] = (value + total) % total;
  };
  const answeredCount = (): number => snapshot.settled.filter((settled) => settled).length;
  const selected = (): number[] => {
    const answer = snapshot.answers[snapshot.active];
    return answer?.kind === 'multi' ? answer.selected : [];
  };

  /** 当前是不是停在那条自定义行上（终端那边同理：`Type something.`）。 */
  const onCustomRow = (): boolean => {
    if (onSubmitTab()) return false;
    const row = rowsFor(snapshot.active)[cursor()];
    return row?.kind === 'custom';
  };

  const confirmCustom = (): void => {
    const text = drafts[snapshot.active] ?? '';
    if (text.trim() === '') return;
    editing = false;
    emit({ kind: 'custom', index: snapshot.active, text });
  };

  const draw = (): void => {
    if (closed) return;
    // 焦点与草稿要在重画前后自己接住（重画是整块 body 换掉）。
    const focusedDraft = document.activeElement instanceof HTMLInputElement && body.contains(document.activeElement);
    const caret = focusedDraft ? (document.activeElement as HTMLInputElement).selectionStart : null;

    tabs.replaceChildren();
    snapshot.questions.forEach((question, index) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      const answered = snapshot.settled[index] === true;
      tab.className = `ela-q-tab${index === snapshot.active ? ' is-active' : ''}${answered ? ' is-done' : ''}`;
      tab.textContent = `${answered ? '✓' : index + 1} ${question.header === '' ? `第 ${index + 1} 题` : question.header}`;
      tab.addEventListener('click', () => emit({ kind: 'activate', index }));
      tabs.append(tab);
    });
    const submitTab = document.createElement('button');
    submitTab.type = 'button';
    submitTab.className = `ela-q-tab${onSubmitTab() ? ' is-active' : ''}`;
    submitTab.textContent = '提交';
    submitTab.addEventListener('click', () => emit({ kind: 'activate', index: snapshot.questions.length }));
    tabs.append(submitTab);

    body.replaceChildren();
    if (onSubmitTab()) drawSubmit();
    else drawQuestion();
    drawFooter();

    if (focusedDraft) {
      const input = body.querySelector<HTMLInputElement>('input.ela-q-input');
      if (input !== null) {
        input.focus();
        if (caret !== null) input.setSelectionRange(caret, caret);
      }
    }
  };

  const drawQuestion = (): void => {
    const question = activeQuestion();
    if (question === undefined) return;
    const questionText = document.createElement('div');
    questionText.className = 'ela-q-question';
    questionText.textContent = question.question;
    body.append(questionText);

    const list = document.createElement('div');
    list.className = 'ela-q-options';
    const rows = rowsFor(snapshot.active);
    const at = cursor();
    const answer = snapshot.answers[snapshot.active];
    rows.forEach((row, rowIndex) => {
      const focused = rowIndex === at;
      const line = document.createElement('div');
      line.className = 'ela-q-option';
      if (focused) line.classList.add('is-focused');
      if (row.kind === 'option') {
        const picked =
          answer?.kind === 'option' ? answer.index === row.index : answer?.kind === 'multi' ? selected().includes(row.index) : false;
        if (picked) line.classList.add('is-picked');
        const box = document.createElement('span');
        box.className = 'ela-q-box';
        box.textContent = question.multiSelect ? (picked ? '[x]' : '[ ]') : `${row.index + 1}.`;
        const text = document.createElement('span');
        const label = document.createElement('span');
        label.className = 'ela-q-label';
        label.textContent = question.options[row.index]?.label ?? '';
        const description = document.createElement('span');
        description.className = 'ela-q-desc';
        description.textContent = question.options[row.index]?.description ?? '';
        text.append(label, description);
        line.append(box, text);
        line.addEventListener('click', () => {
          cursors[snapshot.active] = rowIndex;
          emit(question.multiSelect ? { kind: 'toggle', index: row.index } : { kind: 'pick', index: row.index });
        });
      } else if (row.kind === 'commit') {
        const box = document.createElement('span');
        box.className = 'ela-q-box';
        box.textContent = '✓';
        const text = document.createElement('span');
        text.className = 'ela-q-label';
        text.textContent = '就这些（回车）';
        line.append(box, text);
        line.addEventListener('click', () => {
          cursors[snapshot.active] = rowIndex;
          emit({ kind: 'commit' });
        });
      } else {
        const box = document.createElement('span');
        box.className = 'ela-q-box';
        box.textContent = '✎';
        const input = document.createElement('input');
        input.className = 'ela-q-input';
        input.type = 'text';
        input.spellcheck = false;
        input.placeholder = OTHER_LABEL;
        input.value = drafts[snapshot.active] ?? '';
        input.addEventListener('input', () => {
          drafts[snapshot.active] = input.value;
          editing = true;
        });
        input.addEventListener('focus', () => {
          cursors[snapshot.active] = rowIndex;
          editing = true;
        });
        line.append(box, input);
      }
      list.append(line);
    });
    body.append(list);

    const previewIndex =
      rows[at]?.kind === 'option' ? (rows[at] as { index: number }).index : undefined;
    const preview = previewIndex === undefined ? '' : question.options[previewIndex]?.preview ?? '';
    if (preview !== '') {
      const pane = document.createElement('pre');
      pane.className = 'ela-q-preview';
      pane.textContent = preview;
      body.append(pane);
    }
  };

  const drawSubmit = (): void => {
    const hint = document.createElement('div');
    hint.className = 'ela-q-question';
    hint.textContent = '这就要提交了：';
    body.append(hint);
    const list = document.createElement('div');
    list.className = 'ela-q-summary';
    snapshot.questions.forEach((question, index) => {
      const line = document.createElement('div');
      line.className = 'ela-q-summary-row';
      const label = document.createElement('span');
      label.className = 'ela-q-summary-label';
      label.textContent = `${question.header === '' ? `第 ${index + 1} 题` : question.header}：`;
      const value = document.createElement('span');
      const answer = snapshot.answers[index];
      if (snapshot.settled[index] !== true || answer == null) {
        value.className = 'ela-q-warn';
        value.textContent = '（还没答）';
      } else if (answer.kind === 'custom') {
        value.textContent = answer.text;
      } else if (answer.kind === 'multi') {
        value.textContent =
          answer.custom !== undefined && answer.custom.trim() !== ''
            ? answer.custom
            : answer.selected.length === 0
              ? '（一个都没勾）'
              : answer.selected.map((i) => question.options[i]?.label ?? '').join('、');
      } else {
        value.textContent = question.options[answer.index]?.label ?? '';
      }
      line.append(label, value);
      list.append(line);
    });
    body.append(list);
  };

  const drawFooter = (): void => {
    const unanswered = snapshot.questions.length - answeredCount();
    const hint = document.createElement('div');
    hint.className = 'ela-q-hint';
    hint.textContent = onSubmitTab()
      ? 'Enter 提交 · ←/→ 切题 · Esc 放弃'
      : '←/→ 切题 · ↑↓ 选项 · Enter 选择 · Esc 放弃';
    const progress = document.createElement('div');
    progress.className = unanswered === 0 ? 'ela-q-progress is-done' : 'ela-q-progress';
    progress.textContent = unanswered === 0 ? '已答完' : `未答 ${unanswered}/${snapshot.questions.length}`;
    const actions = document.createElement('div');
    actions.className = 'ela-q-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ela-q-button';
    cancel.textContent = '放弃';
    cancel.addEventListener('click', () => emit({ kind: 'cancel' }));
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'ela-q-button is-primary';
    submit.textContent = '提交';
    submit.disabled = unanswered !== 0;
    submit.addEventListener('click', () => emit({ kind: 'submit' }));
    actions.append(cancel, submit);
    footer.replaceChildren(hint, progress, actions);
  };

  /** 终端的键位照搬一份 —— 两端同一套肌肉记忆。 */
  function onKeyDown(event: KeyboardEvent): void {
    if (closed) return;
    if (editing && document.activeElement instanceof HTMLInputElement) {
      // 输入态：Esc/回车归这个输入框，别的（切题）先不让动，免得打到一半跑掉。
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        editing = false;
        focusPanel();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        confirmCustom();
        return;
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      emit({ kind: 'cancel' });
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (snapshot.active > 0) emit({ kind: 'activate', index: snapshot.active - 1 });
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (snapshot.active < snapshot.questions.length) emit({ kind: 'activate', index: snapshot.active + 1 });
      return;
    }
    if (onSubmitTab()) {
      if (event.key === 'Enter') {
        event.preventDefault();
        emit({ kind: 'submit' });
      }
      return;
    }
    const question = activeQuestion();
    if (question === undefined) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor(cursor() + (event.key === 'ArrowDown' ? 1 : -1));
      draw();
      return;
    }
    if (event.key === ' ') {
      const row = rowsFor(snapshot.active)[cursor()];
      if (row?.kind === 'option' && question.multiSelect) {
        event.preventDefault();
        emit({ kind: 'toggle', index: row.index });
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const row = rowsFor(snapshot.active)[cursor()];
      if (row?.kind === 'option') {
        emit(question.multiSelect ? { kind: 'toggle', index: row.index } : { kind: 'pick', index: row.index });
        return;
      }
      if (row?.kind === 'commit') {
        emit({ kind: 'commit' });
        return;
      }
      const input = body.querySelector<HTMLInputElement>('input.ela-q-input');
      if (input !== null) {
        editing = true;
        input.focus();
      }
      return;
    }
    // 在别的行上直接打字：跳进自定义输入行（与终端那边同一个手感）。
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const rows = rowsFor(snapshot.active);
      setCursor(Math.max(0, rows.findIndex((row) => row.kind === 'custom')));
      draw();
      const input = body.querySelector<HTMLInputElement>('input.ela-q-input');
      if (input !== null) {
        editing = true;
        input.focus();
        input.value = event.key;
        drafts[snapshot.active] = event.key;
      }
    }
  }

  const focusPanel = (): void => {
    const first = body.querySelector<HTMLInputElement>('input.ela-q-input');
    if (first !== null && onCustomRow()) first.focus();
    else backdrop.focus();
  };

  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) {
      event.preventDefault();
      emit({ kind: 'cancel' });
    }
  });
  document.addEventListener('keydown', onKeyDown, true);
  // 一题都没答就打开面板时，光标在题上（不再需要"先点一下"）。
  backdrop.tabIndex = -1;
  backdrop.focus();

  draw();

  return {
    push(next) {
      const activeChanged = next.active !== snapshot.active;
      snapshot = next;
      if (activeChanged) editing = false;
      // 编辑态里服务端推来的帧不该把字吃掉：草稿是本地那份，重画只换外框。
      draw();
    },
    close,
  };
}

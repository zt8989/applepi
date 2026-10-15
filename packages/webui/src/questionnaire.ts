/**
 * 问卷（多题 tab）在浏览器里的呈现 —— 终端那一份的**镜像**。
 *
 * ## 分工
 *
 * 终端那份由扩展自己的组件画（`ask_user_question` 是本项目的内置扩展，见
 * `patches/`），这里画的是**浏览器这一份**：两边同时开着同一份问卷，谁先答完都算数
 * （扩展补丁里的握手段 `externalQuestionnaire`，见 `@ela/core/questionnaire` 的文件头）。
 *
 * ## 它不是状态的所有者
 *
 * 答案属于服务端（`@ela/core/questionnaire` 的 `QuestionnaireSession`）。这里做两件事：
 * 把快照画出来、把点击/按键变成**意图**发回去（`activate` / `pick` / `toggle` / `custom` /
 * `commit` / `note` / `globalNote` / `submit` / `cancel`）。
 *
 * **本地只有两样东西**：光标停在哪个选项上，以及**还没提交的备注草稿**
 * （备注在提交时一次性发过去 —— 每敲一个字发一条 WebSocket 太啰嗦；草稿丢了也只是
 * 少一句备注，不影响答案）。
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

/** 一题里的"行"：某个选项 / 自定义输入 / 多选的"就这些"。 */
type Row = { kind: 'option'; index: number } | { kind: 'custom' } | { kind: 'commit' };

const OTHER_LABEL = 'Type something.';

export function openQuestionnaireModal(options: QuestionnaireModalOptions): QuestionnaireModalHandle {
  let snapshot = options.snapshot;
  /** 每题自己的光标（切回来时"我上次停在第 3 项"还在）。 */
  const cursors: number[] = snapshot.questions.map(() => 0);
  /** 每题自定义答案的草稿（没按回车之前不算答案）。 */
  const drafts: string[] = snapshot.questions.map(() => '');
  /** 每题备注的草稿（提交时一次性发过去）。 */
  const notes: string[] = snapshot.questions.map((_, index) => snapshot.notes[index] ?? '');
  let globalNote = snapshot.globalNote;
  /** 预览是不是被"点开看全"了（默认按行数截断，与终端那份一致）。 */
  let previewExpanded = false;

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
    const rows: Row[] = question.options.map((_, i) => ({ kind: 'option', index: i }));
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

  /** 备注输入框（每题一个 + 提交页一个整份的）。`onChange` 只更新草稿。 */
  const noteField = (value: string, placeholder: string, onChange: (text: string) => void): HTMLElement => {
    const box = document.createElement('div');
    box.className = 'ela-q-note';
    const mark = document.createElement('span');
    mark.className = 'ela-q-box';
    mark.textContent = '✎';
    const input = document.createElement('input');
    input.className = 'ela-q-noteinput';
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = placeholder;
    input.value = value;
    input.addEventListener('input', () => onChange(input.value));
    box.append(mark, input);
    return box;
  };

  /** 提交：把备注草稿一并交出去（顺序就是它们的发送顺序）。 */
  const submit = (): void => {
    notes.forEach((text, index) => {
      if (text.trim() !== '') emit({ kind: 'note', index, text });
    });
    if (globalNote.trim() !== '') emit({ kind: 'globalNote', text: globalNote });
    emit({ kind: 'submit' });
  };

  /** 预览最多先给几行（终端那份是按终端高度算的，这里给个固定值）。 */
  const PREVIEW_LINES = 12;

  /**
   * 预览块：默认只给 `PREVIEW_LINES` 行，尾巴上留一行"还有 N 行（点开看全）"——
   * 与终端那份同一个做法（那边是 `… 预览还有 N 行`）。
   */
  const previewPane = (text: string): HTMLElement => {
    const box = document.createElement('div');
    box.className = 'ela-q-previewbox';
    const lines = text.split('\n');
    const shown = previewExpanded ? lines : lines.slice(0, Math.max(1, PREVIEW_LINES - 1));
    const pane = document.createElement('pre');
    pane.className = 'ela-q-preview';
    pane.textContent = shown.join('\n');
    box.append(pane);
    if (!previewExpanded && lines.length > shown.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'ela-q-more';
      more.textContent = `… 预览还有 ${lines.length - shown.length} 行（点开看全）`;
      more.addEventListener('click', () => {
        previewExpanded = true;
        draw();
      });
      box.append(more);
    }
    return box;
  };

  const draw = (): void => {
    if (closed) return;
    // 焦点与草稿要在重画前后自己接住（重画是整块 body 换掉）。
    const focused = document.activeElement;
    const caret = focused instanceof HTMLInputElement ? focused.selectionStart : null;
    const wasNote = focused instanceof HTMLInputElement && focused.classList.contains('ela-q-noteinput');
    const wasCustom = focused instanceof HTMLInputElement && focused.classList.contains('ela-q-input');

    tabs.replaceChildren();
    snapshot.questions.forEach((question, index) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      const answered = snapshot.settled[index] === true;
      tab.className = `ela-q-tab${index === snapshot.active ? ' is-active' : ''}${answered ? ' is-done' : ''}`;
      tab.textContent = `${answered ? '✓' : index + 1} ${question.header === '' ? `第 ${index + 1} 题` : question.header}`;
      tab.addEventListener('click', () => {
        previewExpanded = false;
        emit({ kind: 'activate', index });
      });
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

    if (wasCustom || wasNote) {
      const selector = wasCustom ? 'input.ela-q-input' : 'input.ela-q-noteinput';
      const input = body.querySelector<HTMLInputElement>(selector);
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
    // 宽屏时左右并排（与终端那份同一个形状）：左边选项、右边预览。
    const main = document.createElement('div');
    main.className = 'ela-q-main';
    const left = document.createElement('div');
    left.className = 'ela-q-left';
    body.append(main);
    main.append(left);

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
          answer?.kind === 'option'
            ? answer.index === row.index
            : answer?.kind === 'multi'
              ? selected().includes(row.index)
              : false;
        if (picked) line.classList.add('is-picked');
        // 多选用**真 checkbox**（用户报过：`[ ]` 那种写法宽度不够会自己换行，而且它不是
        // checkbox）。交互仍然由整行接管：`pointer-events: none` + `tabindex="-1"`，
        // 表单控件只负责"长什么样"。
        const box = question.multiSelect ? document.createElement('input') : document.createElement('span');
        box.className = 'ela-q-box';
        if (box instanceof HTMLInputElement) {
          box.type = 'checkbox';
          box.checked = picked;
          box.tabIndex = -1;
          box.setAttribute('aria-hidden', 'true');
        } else {
          box.textContent = `${row.index + 1}.`;
        }
        const label = document.createElement('span');
        label.className = 'ela-q-label';
        label.textContent = question.options[row.index]?.label ?? '';
        const description = document.createElement('span');
        description.className = 'ela-q-desc';
        description.textContent = question.options[row.index]?.description ?? '';
        line.append(box, label, description);
        line.addEventListener('click', () => {
          cursors[snapshot.active] = rowIndex;
          emit(question.multiSelect ? { kind: 'toggle', index: row.index } : { kind: 'pick', index: row.index });
        });
      } else if (row.kind === 'commit') {
        const box = document.createElement('span');
        box.className = 'ela-q-box';
        box.textContent = '✓';
        const label = document.createElement('span');
        label.className = 'ela-q-label';
        label.textContent = '就这些（回车）';
        line.append(box, label);
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
        });
        input.addEventListener('focus', () => {
          cursors[snapshot.active] = rowIndex;
        });
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          const text = input.value.trim();
          if (text === '') return;
          emit({ kind: 'custom', index: snapshot.active, text });
        });
        line.append(box, input);
      }
      list.append(line);
    });
    left.append(list);

    // 每题一句备注（可空）—— 与终端那份的 `n` 是同一个东西（这里 Tab 就能到）。
    left.append(
      noteField(notes[snapshot.active] ?? '', '这一题的备注（可选，Tab 到这里）', (text) => {
        notes[snapshot.active] = text;
      }),
    );

    const previewRow = rows[at];
    const previewIndex = previewRow?.kind === 'option' ? previewRow.index : undefined;
    const preview = previewIndex === undefined ? '' : question.options[previewIndex]?.preview ?? '';
    if (preview !== '') {
      main.append(previewPane(preview));
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
        value.textContent = '（留空——会作为 unanswered 告诉模型）';
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
      const note = notes[index] ?? '';
      if (note.trim() !== '') {
        const noteLine = document.createElement('div');
        noteLine.className = 'ela-q-summary-note';
        noteLine.textContent = `✎ ${note}`;
        list.append(noteLine);
      }
    });
    body.append(list);
    body.append(noteField(globalNote, '整份备注（可选）', (text) => { globalNote = text; }));
  };

  /**
   * 底栏。
   *
   * 问题页上是**翻页**（上一页 / 下一页），提交只在**最后一页**（提交页）—— 与终端那份
   * 的分页语义一致：答完一题自动进下一页，最后一题答完落到提交页，那里才按提交。
   */
  const drawFooter = (): void => {
    const unanswered = snapshot.questions.length - answeredCount();
    const last = snapshot.active >= snapshot.questions.length - 1;
    const hint = document.createElement('div');
    hint.className = 'ela-q-hint';
    hint.textContent = onSubmitTab()
      ? 'Enter 提交 · ←/→ 翻页 · Esc 放弃'
      : '←/→ 上一页/下一页 · ↑↓ 选项 · Enter 选择 · Tab 写备注 · Esc 放弃';
    const progress = document.createElement('div');
    progress.className = unanswered === 0 ? 'ela-q-progress is-done' : 'ela-q-progress is-pending';
    progress.textContent =
      unanswered === 0 ? '已答完' : `未答 ${unanswered}/${snapshot.questions.length}（留空也能提交）`;
    const actions = document.createElement('div');
    actions.className = 'ela-q-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ela-q-button';
    cancel.textContent = '放弃';
    cancel.addEventListener('click', () => emit({ kind: 'cancel' }));
    actions.append(cancel);
    if (onSubmitTab()) {
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'ela-q-button is-primary';
      confirm.textContent = '提交';
      // **留空也能提交**（扩展的信封会把它列成 `unanswered:`）—— 与它自己那份 TUI 一致。
      confirm.addEventListener('click', submit);
      actions.append(confirm);
      footer.replaceChildren(hint, progress, actions);
      return;
    }
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'ela-q-button';
    back.textContent = '上一页';
    back.disabled = snapshot.active === 0;
    back.addEventListener('click', () => emit({ kind: 'activate', index: snapshot.active - 1 }));
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'ela-q-button is-primary';
    // 最后一题的下一页是**提交页**（不是"提交"）—— 提交只在那一页上按。
    next.textContent = '下一页';
    next.addEventListener('click', () => emit({ kind: 'activate', index: snapshot.active + 1 }));
    actions.append(back, next);
    footer.replaceChildren(hint, progress, actions);
    void last;
  };

  /** 终端的键位照搬一份 —— 两端同一套肌肉记忆。 */
  function onKeyDown(event: KeyboardEvent): void {
    if (closed) return;
    // 按住不放的重复不算又一次操作（与终端那边同一个理由）。
    if (event.repeat) return;
    // 焦点在我们某个输入框里：只有 Esc / 回车归我们管，别的字让输入框自己收。
    const active = document.activeElement;
    if (active instanceof HTMLInputElement) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        active.blur();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        // 自定义答案：回车 = 交这一题；备注：回车 = 收起来（草稿留着，提交时带走）。
        if (active.classList.contains('ela-q-input')) {
          const text = active.value.trim();
          if (text !== '') emit({ kind: 'custom', index: snapshot.active, text });
        } else {
          active.blur();
        }
        return;
      }
      return;
    }
    if (event.key === 'Tab') {
      // 底栏写着"Tab 写备注"——那就得真的到得了（浏览器的默认 Tab 顺序会先落在 tab 按钮上）。
      event.preventDefault();
      const target = event.shiftKey ? 'input.ela-q-input' : 'input.ela-q-noteinput';
      const input = body.querySelector<HTMLInputElement>(target);
      if (input !== null) input.focus();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      emit({ kind: 'cancel' });
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (snapshot.active > 0) {
        previewExpanded = false;
        emit({ kind: 'activate', index: snapshot.active - 1 });
      }
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (snapshot.active < snapshot.questions.length) {
        previewExpanded = false;
        emit({ kind: 'activate', index: snapshot.active + 1 });
      }
      return;
    }
    if (onSubmitTab()) {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
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
      if (input !== null) input.focus();
      return;
    }
    // 在别的行上直接打字：跳进自定义输入行（与终端那边同一个手感）。
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const rows = rowsFor(snapshot.active);
      setCursor(Math.max(0, rows.findIndex((row) => row.kind === 'custom')));
      draw();
      const input = body.querySelector<HTMLInputElement>('input.ela-q-input');
      if (input !== null) {
        input.focus();
        input.value = event.key;
        drafts[snapshot.active] = event.key;
      }
    }
  }

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
      snapshot = next;
      // 服务端推来的帧不该把草稿吃掉（答案与备注草稿是两回事）。
      draw();
    },
    close,
  };
}

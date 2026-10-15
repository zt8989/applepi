import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuestionnaire,
  QuestionnaireHost,
  QuestionnaireSession,
  titleMatches,
  type QuestionnaireQuestion,
} from '../src/questionnaire';

/**
 * 问卷状态机 + 宿主侧的认领/翻译。
 *
 * 这一层写错的样子很隐蔽：界面画得好好的，交回扩展的字符串却认不出来 ——
 * 于是模型收到的是"用户拒绝了"而不是答案。所以每一条**运输格式**都要钉住：
 * 选项行原文、自定义答案原文、多选的 `"1,3"`、取消的 `undefined`。
 */

const QUESTIONS: QuestionnaireQuestion[] = [
  {
    question: '用哪个库？',
    header: '库',
    multiSelect: false,
    options: [
      { label: 'sqlite', description: '单文件' },
      { label: 'postgres', description: '要一台服务器', preview: '```sql\nselect 1;\n```' },
    ],
  },
  {
    question: '要哪些能力？',
    header: '能力',
    multiSelect: true,
    options: [
      { label: '缓存', description: '内存缓存' },
      { label: '重试', description: '失败重试' },
      { label: '日志', description: '结构化日志' },
    ],
  },
];

const PARAMS = {
  questions: QUESTIONS.map((question) => ({
    question: question.question,
    header: question.header,
    multiSelect: question.multiSelect,
    options: question.options.map((option) => ({ ...option })),
  })),
};

test('问卷：认形状（认不出就退回逐题弹窗，不猜）', () => {
  const ok = parseQuestionnaire({
    questions: [
      {
        question: 'Q1?',
        header: 'H',
        multiSelect: true,
        options: [
          { label: 'A', description: 'a', preview: '```\nx\n```' },
          { label: 'B', description: 'b' },
        ],
      },
    ],
  });
  assert.equal(ok?.length, 1);
  assert.equal(ok?.[0]?.multiSelect, true);
  assert.equal(ok?.[0]?.options[1]?.preview, undefined, '没给 preview 就不该编一个空的');

  assert.equal(parseQuestionnaire(undefined), undefined);
  assert.equal(parseQuestionnaire({}), undefined);
  assert.equal(parseQuestionnaire({ questions: [] }), undefined);
  assert.equal(parseQuestionnaire({ questions: 'nope' }), undefined);
  assert.equal(
    parseQuestionnaire({ questions: [{ question: 'Q', options: [{ label: 'A' }] }] }),
    undefined,
    '只有一个选项 = 不是问卷',
  );
  assert.equal(
    parseQuestionnaire({ questions: [{ question: '', options: [{ label: 'A' }, { label: 'B' }] }] }),
    undefined,
    '空题干认不出',
  );
  assert.equal(
    parseQuestionnaire({ questions: new Array(5).fill({ question: 'Q', options: [] }) }),
    undefined,
    '超过 4 题越界',
  );
});

test('问卷：标题前缀对得上（认领那一次 select 的唯一证据）', () => {
  const question = QUESTIONS[0]!;
  assert.equal(titleMatches(question, '[库] 用哪个库？'), true);
  assert.equal(
    titleMatches(question, '[库] 用哪个库？\n\n--- 2. postgres preview ---\n…'),
    true,
    '预览块挂在后面不影响',
  );
  assert.equal(titleMatches(question, '用哪个库？'), false);
  assert.equal(titleMatches(question, '[别的] 用哪个库？'), false);
  assert.equal(titleMatches(question, '[库] 换一个说法？'), false);
  assert.equal(titleMatches({ ...question, header: '' }, '用哪个库？'), true, '没有 header 时标题就是题干本身');
  assert.equal(
    titleMatches({ ...question, question: '用哪个\r\n库？' }, '[库] 用哪个\n库？'),
    true,
    '行终止符两边同规则归一',
  );
});

test('问卷：单选选定即下一题，多选勾完要回车才算', () => {
  const session = new QuestionnaireSession(QUESTIONS);
  assert.equal(session.snapshot().active, 0);

  session.apply({ kind: 'pick', index: 1 });
  assert.deepEqual(session.answerOf(0), { kind: 'option', index: 1 });
  assert.equal(session.snapshot().active, 1, '单选选完就进下一题');

  session.apply({ kind: 'toggle', index: 0 });
  session.apply({ kind: 'toggle', index: 2 });
  assert.deepEqual(session.answerOf(1), { kind: 'multi', selected: [0, 2] });
  assert.equal(session.snapshot().active, 1, '多选勾选还停在本题');
  assert.equal(session.complete, false, '勾了还没回车 = 草稿，不算答定');
  session.apply({ kind: 'commit' });
  assert.equal(session.snapshot().active, 2, '回车才进提交页');
  assert.equal(session.complete, true);

  assert.equal(session.apply({ kind: 'submit' }), true);
  assert.equal(session.submitted, true);
  assert.equal(session.apply({ kind: 'pick', index: 0 }), false, '提交之后不再接受改动');
});

test('问卷：多选一个不勾也能提交（扩展那边由空串表达）', () => {
  const session = new QuestionnaireSession([QUESTIONS[1]!]);
  session.apply({ kind: 'commit' });
  assert.deepEqual(session.answerOf(0), { kind: 'multi', selected: [] });
  assert.equal(session.complete, true);
  assert.equal(session.apply({ kind: 'submit' }), true);
});

test('问卷：没答完不许提交（未答的题没有"空答案"这种表示）', () => {
  const session = new QuestionnaireSession(QUESTIONS);
  session.apply({ kind: 'pick', index: 0 });
  assert.deepEqual(session.unanswered(), [1]);
  assert.equal(session.apply({ kind: 'submit' }), false);
  assert.equal(session.submitted, false);
});

test('问卷：离开一道题时草稿落地（否则会卡在"还有 1 题没答"）', () => {
  const session = new QuestionnaireSession(QUESTIONS);
  session.apply({ kind: 'activate', index: 1 });
  session.apply({ kind: 'toggle', index: 0 });
  assert.equal(session.complete, false);
  session.apply({ kind: 'activate', index: 2 });
  assert.equal(session.complete, false, '第 0 题本来就还没答');
  assert.equal(session.snapshot().settled[1], true, '切走 = 这一题按当前勾选答定');
  assert.deepEqual(session.unanswered(), [0]);
});

test('问卷：自定义答案 / 清空答案 / 多选上的自定义', () => {
  const session = new QuestionnaireSession(QUESTIONS);
  session.apply({ kind: 'custom', index: 0, text: '我自己的写法' });
  assert.deepEqual(session.answerOf(0), { kind: 'custom', text: '我自己的写法' });
  assert.equal(session.snapshot().active, 1);
  session.apply({ kind: 'activate', index: 0 });
  session.apply({ kind: 'custom', index: 0, text: '   ' });
  assert.equal(session.answerOf(0), undefined, '空白 = 清掉');
  assert.equal(session.snapshot().settled[0], false);

  session.apply({ kind: 'activate', index: 1 });
  session.apply({ kind: 'toggle', index: 1 });
  session.apply({ kind: 'custom', index: 1, text: '其实我想要别的' });
  assert.deepEqual(session.answerOf(1), { kind: 'multi', selected: [1], custom: '其实我想要别的' });
});

test('问卷：取消 = 整份放弃（等着的问法全都拿到 undefined）', async () => {
  const session = new QuestionnaireSession(QUESTIONS);
  const waiting = session.waitFor(0);
  session.apply({ kind: 'cancel' });
  assert.equal(await waiting, undefined);
  assert.equal(session.cancelled, true);
});

test('问卷：waitFor 只等**这一题**（草稿不算，答定才算）', async () => {
  const session = new QuestionnaireSession(QUESTIONS);
  const first = session.waitFor(0);
  let secondSettled = false;
  const second = session.waitFor(1).then((answer) => {
    secondSettled = true;
    return answer;
  });
  session.apply({ kind: 'pick', index: 1 });
  assert.deepEqual(await first, { kind: 'option', index: 1 });
  assert.equal(secondSettled, false, '第 1 题还停在草稿上，不该放行');
  session.apply({ kind: 'toggle', index: 0 });
  await Promise.resolve();
  assert.equal(secondSettled, false, '勾了一下还是草稿');
  session.apply({ kind: 'commit' });
  assert.deepEqual(await second, { kind: 'multi', selected: [0] });
});

/** 造一个宿主：内存里挂一次"正在跑的工具调用"，并记下界面层拿到的那个 session。 */
function makeHost(params: unknown) {
  const opened: QuestionnaireSession[] = [];
  let tornDown = 0;
  const host = new QuestionnaireHost(() => (session) => {
    opened.push(session);
    return () => {
      tornDown += 1;
    };
  });
  host.noteToolCall('call-1', 'ask_user_question', params);
  return { host, opened, session: () => opened[0], tornDown: () => tornDown };
}

const SELECT_OPTIONS = ['1. sqlite — 单文件', '2. postgres — 要一台服务器', '3. Type something.'];

test('宿主：认不出就当场返回 undefined（不推迟别的扩展的对话框一个微任务）', () => {
  const { host } = makeHost(PARAMS);
  assert.equal(host.tryServe('select', '别的东西', SELECT_OPTIONS), undefined);
  assert.equal(host.tryServe('input', '[库] 用哪个库？', SELECT_OPTIONS), undefined, '单选题不该由 input 认领');
  const bare = new QuestionnaireHost(undefined);
  bare.noteToolCall('call-1', 'ask_user_question', PARAMS);
  assert.equal(bare.tryServe('select', '[库] 用哪个库？', SELECT_OPTIONS), undefined, '没有视图的宿主不认领');
});

test('宿主：单选交回**那一行原文**（扩展靠自己拼的选项行认选项）', async () => {
  const { host, session } = makeHost(PARAMS);
  const answer = host.tryServe('select', '[库] 用哪个库？', SELECT_OPTIONS);
  assert.notEqual(answer, undefined);
  session()?.apply({ kind: 'pick', index: 1 });
  assert.equal(await answer, '2. postgres — 要一台服务器');
});

test('宿主：自定义答案交回原文（不匹配任何选项行 → 扩展判成 custom）', async () => {
  const { host, session } = makeHost(PARAMS);
  const answer = host.tryServe('select', '[库] 用哪个库？', SELECT_OPTIONS);
  session()?.apply({ kind: 'custom', index: 0, text: '都不对，用 duckdb' });
  assert.equal(await answer, '都不对，用 duckdb');
});

test('宿主：多选交回序号（"1,3"）', async () => {
  const { host, session } = makeHost(PARAMS);
  // 先答第 0 题（单选），把 ask 推到第 1 题。
  const first = host.tryServe('select', '[库] 用哪个库？', SELECT_OPTIONS);
  session()?.apply({ kind: 'pick', index: 0 });
  assert.equal(await first, '1. sqlite — 单文件');

  const second = host.tryServe('input', '[能力] 要哪些能力？', []);
  session()?.apply({ kind: 'toggle', index: 0 });
  session()?.apply({ kind: 'toggle', index: 2 });
  session()?.apply({ kind: 'commit' });
  assert.equal(await second, '1,3');
});

test('宿主：多选一个不勾交回空串（扩展那边是"故意空提交"）', async () => {
  const { host, session } = makeHost(PARAMS);
  const first = host.tryServe('select', '[库] 用哪个库？', SELECT_OPTIONS);
  session()?.apply({ kind: 'pick', index: 0 });
  await first;
  const second = host.tryServe('input', '[能力] 要哪些能力？', []);
  session()?.apply({ kind: 'commit' });
  assert.equal(await second, '');
});

test('宿主：取消交回 undefined（扩展的语义 = 用户放弃整份问卷）', async () => {
  const { host, session } = makeHost(PARAMS);
  const answer = host.tryServe('select', '[库] 用哪个库？', SELECT_OPTIONS);
  session()?.apply({ kind: 'cancel' });
  assert.equal(await answer, undefined);
});

test('宿主：提交之后还在按顺序问 —— 从已答的会话里取，不再弹窗', async () => {
  const { host, session } = makeHost(PARAMS);
  const first = host.tryServe('select', '[库] 用哪个库？', SELECT_OPTIONS);
  const one = session()!;
  one.apply({ kind: 'pick', index: 1 });
  assert.equal(await first, '2. postgres — 要一台服务器');

  const second = host.tryServe('input', '[能力] 要哪些能力？', []);
  assert.notEqual(second, undefined, '提交之后第二问仍归这份问卷（而不是退回逐题弹窗）');
  one.apply({ kind: 'toggle', index: 1 });
  one.apply({ kind: 'commit' });
  one.apply({ kind: 'submit' });
  assert.equal(await second, '2');
});

test('宿主：工具收尾就把整份收掉（视图拆台、下次从零认领）', async () => {
  const { host, session, tornDown } = makeHost(PARAMS);
  const answer = host.tryServe('select', '[库] 用哪个库？', SELECT_OPTIONS);
  session()?.apply({ kind: 'pick', index: 0 });
  await answer;
  assert.notEqual(host.current(), undefined);
  assert.equal(tornDown(), 0, '还在跑的时候不该拆台');
  host.settleToolCall('call-1');
  assert.equal(host.current(), undefined);
  assert.equal(tornDown(), 1, '工具收尾 = 拆视图');
});

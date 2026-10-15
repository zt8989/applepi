import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuestionnaire,
  QuestionnaireHost,
  QuestionnaireSession,
  type QuestionnaireAnswerPayload,
  type QuestionnaireQuestion,
} from '../src/questionnaire';

/**
 * 问卷在**宿主这一侧**的两块东西：
 *
 * 1. `QuestionnaireSession` —— 浏览器那份界面的状态机（点了什么 → 变成什么答案）；
 * 2. `QuestionnaireHost` —— 接扩展交过来的题目、开浏览器那份视图、把答案回给扩展。
 *
 * 这一层写错的样子很隐蔽：界面画得好好的，交回去的东西却对不上（label 写成了序号、
 * 备注丢了、留空的题把整份弄成"拒绝"）。所以每一条**运输形状**都钉住。
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

/** 扩展那边交给我们的东西（补丁里的 `QuestionParams` 形状）。 */
const PARAMS = {
  questions: QUESTIONS.map((question) => ({
    question: question.question,
    header: question.header,
    multiSelect: question.multiSelect,
    options: question.options.map((option) => ({ ...option })),
  })),
};

test('问卷：把扩展交来的题目收成本项目的形状（认不出就整份不要）', () => {
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
    parseQuestionnaire({ questions: new Array(5).fill({ question: 'Q', options: [] }) }),
    undefined,
    '超过 4 题越界',
  );
});

// ── 状态机 ────────────────────────────────────────────────────────────────

test('问卷：答完一题进下一页，最后一题 → 提交页；提交仍然要手动按', () => {
  const session = new QuestionnaireSession(QUESTIONS);
  assert.equal(session.snapshot().active, 0);

  session.apply({ kind: 'pick', index: 1 });
  assert.deepEqual(session.answerOf(0), { kind: 'option', index: 1 });
  assert.equal(session.snapshot().active, 1, '单选选完就进下一页');

  session.apply({ kind: 'toggle', index: 0 });
  session.apply({ kind: 'toggle', index: 2 });
  assert.deepEqual(session.answerOf(1), { kind: 'multi', selected: [0, 2] });
  assert.equal(session.snapshot().active, 1, '多选勾选还停在本题');
  assert.equal(session.snapshot().settled[1], false, '勾了还没回车 = 草稿，不算答定');
  session.apply({ kind: 'commit' });
  assert.equal(
    session.snapshot().active,
    session.submitIndex,
    '最后一题答完 → 落到提交页（与扩展那份 TUI 的 computeAutoAdvanceTab 同规则）',
  );
  assert.equal(session.answeredCount, 2);
  assert.equal(session.submitted, false, '落到提交页 ≠ 提交：提交得在那页上手动按');

  assert.equal(session.apply({ kind: 'submit' }), true);
  assert.equal(session.submitted, true);
  assert.equal(session.apply({ kind: 'pick', index: 0 }), false, '提交之后不再接受改动');
});

test('问卷：离开一道题时草稿落地（否则会卡在"还有 1 题没答"）', () => {
  const session = new QuestionnaireSession(QUESTIONS);
  session.apply({ kind: 'activate', index: 1 });
  session.apply({ kind: 'toggle', index: 0 });
  assert.deepEqual(session.unanswered(), [0, 1]);
  session.apply({ kind: 'activate', index: 2 });
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

test('问卷：备注与整份备注都不影响"答没答"', () => {
  const session = new QuestionnaireSession(QUESTIONS);
  session.apply({ kind: 'note', index: 0, text: '部署脚本也要改' });
  assert.equal(session.noteOf(0), '部署脚本也要改');
  assert.deepEqual(session.unanswered(), [0, 1], '只写了备注不算答过');
  session.apply({ kind: 'globalNote', text: '整体上随便' });
  assert.equal(session.globalNote, '整体上随便');
  assert.equal(session.snapshot().notes[0], '部署脚本也要改');
  // 清空备注
  session.apply({ kind: 'note', index: 0, text: '   ' });
  assert.equal(session.noteOf(0), undefined);
  assert.equal(session.snapshot().notes[0], null);
});

test('问卷：留空也能提交（信封那边会列成 unanswered）', () => {
  const session = new QuestionnaireSession(QUESTIONS);
  session.apply({ kind: 'pick', index: 0 });
  assert.deepEqual(session.unanswered(), [1]);
  assert.equal(session.apply({ kind: 'submit' }), true, '留空也允许提交');
  assert.equal(session.submitted, true);
});

// ── 交给扩展的答案 ──────────────────────────────────────────────────────────

test('问卷：答案是**表面**形状（label / selected / 自定义原文 / 备注），留空的不出现', () => {
  const session = new QuestionnaireSession(QUESTIONS);
  session.apply({ kind: 'pick', index: 1 });
  session.apply({ kind: 'note', index: 0, text: '要一起改部署' });
  session.apply({ kind: 'toggle', index: 2 });
  session.apply({ kind: 'commit' });
  session.apply({ kind: 'note', index: 1, text: '顺手' });
  session.apply({ kind: 'globalNote', text: '别的没有了' });
  session.apply({ kind: 'submit' });
  assert.deepEqual(session.payload(), {
    answers: [
      { questionIndex: 0, kind: 'option', answer: 'postgres', notes: '要一起改部署' },
      { questionIndex: 1, kind: 'multi', selected: ['日志'], notes: '顺手' },
    ],
    globalNote: '别的没有了',
  });
});

test('问卷：留空提交时 payload 里压根没有那几题', () => {
  const session = new QuestionnaireSession(QUESTIONS);
  session.apply({ kind: 'pick', index: 0 });
  session.apply({ kind: 'submit' });
  assert.deepEqual(session.payload(), {
    answers: [{ questionIndex: 0, kind: 'option', answer: 'sqlite' }],
  });
});

test('问卷：多选上的自定义原文跟在选中项后面（扩展那边只有 selected 一个位置）', () => {
  const session = new QuestionnaireSession(QUESTIONS);
  session.apply({ kind: 'pick', index: 0 });
  session.apply({ kind: 'toggle', index: 0 });
  session.apply({ kind: 'custom', index: 1, text: '其实都不需要' });
  session.apply({ kind: 'submit' });
  assert.deepEqual(session.payload(), {
    answers: [
      { questionIndex: 0, kind: 'option', answer: 'sqlite' },
      { questionIndex: 1, kind: 'multi', selected: ['缓存', '其实都不需要'] },
    ],
  });
});

test('问卷：取消 → `cancelled: true`（整份备注还带着）', () => {
  const session = new QuestionnaireSession(QUESTIONS);
  session.apply({ kind: 'pick', index: 0 });
  session.apply({ kind: 'globalNote', text: '先不问了' });
  session.apply({ kind: 'cancel' });
  assert.deepEqual(session.payload(), { answers: [], cancelled: true, globalNote: '先不问了' });
});

// ── 宿主（握手 / 视图） ──────────────────────────────────────────────────────

/** 造一个宿主：记下它开的视图（以及拆台几次），并收集回给扩展的答案。 */
function makeHost() {
  const views: { session: QuestionnaireSession; closed: number }[] = [];
  const host = new QuestionnaireHost(() => (session) => {
    const entry = { session, closed: 0 };
    views.push(entry);
    return () => {
      entry.closed += 1;
    };
  });
  const answers: QuestionnaireAnswerPayload[] = [];
  let dones = 0;
  const handoff = (params: unknown) => ({
    params,
    answer: (raw: QuestionnaireAnswerPayload) => answers.push(raw),
    done: () => {
      dones += 1;
    },
  });
  return {
    host,
    views,
    answers,
    dones: () => dones,
    session: () => views[0]?.session,
    closed: () => views[0]?.closed ?? 0,
    handoff,
  };
}

test('宿主：扩展交来题目 → 开浏览器那份视图；浏览器提交 → 答案回给扩展、视图拆掉', () => {
  const { host, session, answers, closed, handoff } = makeHost();
  const bridge = host.open(handoff(PARAMS));
  assert.equal(session()?.questions.length, 2, '题目进了状态机');
  assert.notEqual(host.current(), undefined);

  session()?.apply({ kind: 'pick', index: 0 });
  session()?.apply({ kind: 'toggle', index: 1 });
  session()?.apply({ kind: 'commit' });
  assert.deepEqual(answers, [], '还没提交就不该回答案');
  session()?.apply({ kind: 'activate', index: session()!.submitIndex });
  session()?.apply({ kind: 'submit' });

  assert.deepEqual(answers, [
    {
      answers: [
        { questionIndex: 0, kind: 'option', answer: 'sqlite' },
        { questionIndex: 1, kind: 'multi', selected: ['重试'] },
      ],
    },
  ]);
  assert.equal(closed(), 1, '提交完就把浏览器那份拆掉');
  assert.equal(host.current(), undefined);
  // 扩展那边收尾会再叫一次 done（幂等）。
  bridge.done?.();
  assert.equal(closed(), 1, 'done 不该再拆一次');
});

test('宿主：扩展交来题目 → 终端先答完（done）→ 视图拆掉、不回答案', () => {
  const { host, answers, closed, dones, handoff } = makeHost();
  const bridge = host.open(handoff(PARAMS));
  bridge.done?.();
  assert.equal(closed(), 1, '终端答完 = 收掉浏览器那份');
  assert.deepEqual(answers, [], '终端那份的答案由扩展自己送信封，我们不该再插一脚');
  assert.equal(dones(), 0);
});

test('宿主：取消（浏览器里按 Esc）→ cancelled 回给扩展', () => {
  const { host, session, answers, closed, handoff } = makeHost();
  host.open(handoff(PARAMS));
  session()?.apply({ kind: 'cancel' });
  assert.deepEqual(answers, [{ answers: [], cancelled: true }]);
  assert.equal(closed(), 1);
});

test('宿主：认不出的题目不开视图（也不接管收尾）', () => {
  const { host, views, answers, dones, handoff } = makeHost();
  host.open(handoff({ questions: 'nope' }));
  assert.equal(views.length, 0);
  assert.deepEqual(answers, []);
  assert.equal(dones(), 0);
});

test('宿主：上一份收了之后，旧的那次 done 不该关掉新的一份', () => {
  const { host, session, answers, closed, handoff } = makeHost();
  const first = host.open(handoff(PARAMS));
  session()?.apply({ kind: 'pick', index: 0 });
  session()?.apply({ kind: 'activate', index: session()!.submitIndex });
  session()?.apply({ kind: 'submit' });
  assert.equal(answers.length, 1);
  // 模型又问了一份（同一个宿主）。
  const second = host.open(handoff(PARAMS));
  const secondSession = session();
  assert.notEqual(secondSession, undefined);
  first.done?.();
  assert.notEqual(host.current(), undefined, '新那份还在');
  assert.equal(closed(), 1, '只拆过第一份（第二次 open 用的是新视图）');
  second.done?.();
  assert.equal(host.current(), undefined);
});

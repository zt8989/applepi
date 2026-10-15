import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { initTheme } from '@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { QuestionnaireSession, type QuestionnaireQuestion } from '@ela/core/questionnaire';
import { QuestionnairePanel } from '../src/questionnaire';

/**
 * 终端那一份问卷面板（`ask_user_question` 在 rpc 模式下的整份界面）。
 *
 * 它自己做主两件事：**画**（tab / 选项 / 预览 / 底部进度）与**按键路由**
 * （←/→ 切题、↑↓ 选项、Space 勾选、Enter 选择、打字进自定义输入、Esc 放弃）。
 * 状态不归它 —— 按键只变成意图交给 `QuestionnaireSession`，所以这里断言的是
 * 「按了什么键 → session 变成了什么」加「画出来的那几行里有没有该有的东西」。
 */

const QUESTIONS: QuestionnaireQuestion[] = [
  {
    question: '用哪个库？',
    header: '库',
    multiSelect: false,
    options: [
      { label: 'sqlite', description: '单文件' },
      { label: 'postgres', description: '要一台服务器', preview: '# 预览\n\n```sql\nselect 1;\n```' },
    ],
  },
  {
    question: '要哪些能力？',
    header: '能力',
    multiSelect: true,
    options: [
      { label: '缓存', description: '内存缓存' },
      { label: '日志', description: '结构化日志' },
    ],
  },
];

initTheme('dark', false);

function makePanel(questions: QuestionnaireQuestion[] = QUESTIONS, rows = 40) {
  const session = new QuestionnaireSession(questions);
  const panel = new QuestionnairePanel(session, {
    terminalRows: () => rows,
    onIntent: (intent) => {
      session.apply(intent);
    },
  });
  const draw = (width = 100): string => stripTerminalSequences(panel.render(width).join('\n'));
  return { session, panel, draw };
}

test('问卷面板：tab、题干、选项、进度都在（预览跟着焦点走）', () => {
  const { panel, draw } = makePanel();
  const out = draw();
  assert.match(out, /\[库\]|库/, '要有 tab');
  assert.match(out, /用哪个库？/, '要有题干');
  assert.match(out, /sqlite/, '要有选项');
  assert.match(out, /Type something\./, '要有"自定义"那一行');
  assert.match(out, /未答 2\/2/, '进度按"答定"算');

  // 第一个选项没有预览 → 不画预览块；移到第二个（带 preview）才出。
  assert.doesNotMatch(out, /select 1;/, '没焦点在那个带预览的选项上就不该画预览');
  panel.handleInput('\x1b[B');
  assert.match(draw(), /select 1;/, '焦点到了带 preview 的选项上，预览该出来');
});

test('问卷面板：Enter 选中即下一题；多选要 Space 勾 + Enter 回车', () => {
  const { session, panel, draw } = makePanel();
  panel.handleInput('\r');
  assert.deepEqual(session.answerOf(0), { kind: 'option', index: 0 });
  assert.equal(session.snapshot().active, 1, '单选答完自动进下一题');

  panel.handleInput(' ');
  assert.deepEqual(session.answerOf(1), { kind: 'multi', selected: [0] });
  assert.equal(session.complete, false, '勾选还是草稿');
  // ↓ 三次到"就这些"那一行（选项 2 行 + 自定义行 + 就这些行），回车提交这一题。
  panel.handleInput('\x1b[B');
  panel.handleInput('\x1b[B');
  panel.handleInput('\x1b[B');
  panel.handleInput('\r');
  assert.equal(session.snapshot().active, 2, '回车该进提交页');
  assert.equal(session.complete, true);
  assert.match(draw(), /回车提交/, '提交页该说怎么提交');
});

test('问卷面板：没答完时提交页明确说还差几题，回车不生效', () => {
  const { session, panel, draw } = makePanel();
  panel.handleInput('\x1b[C'); // → 第二题
  panel.handleInput('\x1b[C'); // → 提交页
  assert.equal(session.snapshot().active, 2);
  const out = draw();
  assert.match(out, /还有 2 题没答/);
  panel.handleInput('\r');
  assert.equal(session.submitted, false, '答不全不许提交');
});

test('问卷面板：在"Type something."上直接打字 = 自定义答案', () => {
  const { session, panel, draw } = makePanel();
  // ↓ 到自定义行，然后打一个字进输入态。
  panel.handleInput('\x1b[B');
  panel.handleInput('\x1b[B');
  panel.handleInput('d');
  assert.match(draw(), /d/, '打的字该出现在输入行里');
  panel.handleInput('uck');
  panel.handleInput('\r');
  assert.deepEqual(session.answerOf(0), { kind: 'custom', text: 'duck' });
  assert.equal(session.snapshot().active, 1, '自定义答案也算答完这一题');
});

test('问卷面板：多选时打字进自定义输入，Esc 退出输入（不是放弃整份）', () => {
  const { session, panel } = makePanel();
  panel.handleInput('\x1b[C'); // 第二题（多选）
  panel.handleInput('\x1b[B');
  panel.handleInput('\x1b[B');
  panel.handleInput('x');
  panel.handleInput('\x1b'); // Esc：只退输入，不该放弃整份
  assert.equal(session.cancelled, false, '输入态里的 Esc 只是退出输入');
  assert.equal(session.answerOf(1), undefined);
});

test('问卷面板：←/→ 切题，Esc 在非输入态 = 放弃整份', () => {
  const { session, panel } = makePanel();
  panel.handleInput('\x1b[C');
  assert.equal(session.snapshot().active, 1);
  panel.handleInput('\x1b[D');
  assert.equal(session.snapshot().active, 0);
  panel.handleInput('\x1b');
  assert.equal(session.cancelled, true);
});

test('问卷面板：窄屏不并排，超长内容被裁到行数上限内', () => {
  const long: QuestionnaireQuestion[] = [
    {
      question: '选一个',
      header: '长',
      multiSelect: false,
      options: [
        {
          label: 'A',
          description: 'a',
          preview: `\`\`\`\n${Array.from({ length: 60 }, (_, i) => `第 ${i} 行`).join('\n')}\n\`\`\``,
        },
        { label: 'B', description: 'b' },
      ],
    },
  ];
  const { panel } = makePanel(long, 20);
  const lines = panel.render(60);
  assert.ok(lines.length <= 12, `行数该被标题+比例裁住，实际 ${lines.length}`);
  const plain = stripTerminalSequences(lines.join('\n'));
  assert.match(plain, /还有 \d+ 行/, '被裁掉的部分要说一声');
  assert.match(plain, /选一个/, '题干不该被裁掉');
});

/**
 * 命令表与 pi 对齐（`tui/app.ts` 的 `SLASH_COMMANDS`）。
 *
 * ## 这条测试防的是什么
 *
 * 表里每一行的**名字、英文描述、argumentHint** 都是抄 pi 的 `core/slash-commands.js`。
 * 抄的东西会烂：pi 改一句文案、我们把某条命令改个名，用户就会在两个界面里看到两句
 * 不同的话 —— 那种偏差没有任何报错，只有人对文档时才看得出来。所以把它钉成断言：
 *
 * - 名字必须能在 pi 的表里找到（**只有 `/skills` 例外**，理由写在表的注释里）；
 * - 描述逐字相同（`/quit` 只换应用名：pi 是 `Quit pi`，我们是 `Quit ela`）；
 * - 顺序是 pi 表的**子序列** —— 不是「差一点」，而是「pi 的先后，缺的那几条就是不做的」；
 * - `sessions` / `clean` / `wipe` / `help` 这四条**已经删掉**，不能再回来。
 *
 * 从这里 import `SLASH_COMMANDS`（而不是正则扒源码）：表是纯数据，直接读才对得上真值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_SLASH_COMMANDS } from '@earendil-works/pi-coding-agent/dist/core/slash-commands.js';
import { SLASH_COMMANDS } from '../src/app';

const piByName = new Map(BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command]));

/** 本项目有、pi 没有的那几条（每一条都要有理由，见命令表的注释）。 */
const ELA_ONLY = new Set(['skills', 'continue']);

/** pi 有、本项目**故意不做**的（命令表的注释里逐条写了为什么）。 */
const PI_NOT_HERE = [
  'tree',
  'export',
  'import',
  'share',
  'bug',
  'changelog',
  'fork',
  'clone',
  'trust',
  'login',
  'logout',
];

test('命令表：每个名字要么在 pi 的表里，要么是写明了的 ela 自有命令', () => {
  for (const command of SLASH_COMMANDS) {
    if (ELA_ONLY.has(command.name)) continue;
    assert.ok(piByName.has(command.name), `/${command.name} 在 pi 的表里没有 —— 名字要与 pi 一致`);
  }
});

test('命令表：pi 有、这里不做的那些，确实都不在（不是忘了列，是决定不做）', () => {
  for (const name of PI_NOT_HERE) {
    assert.ok(
      !SLASH_COMMANDS.some((command) => command.name === name),
      `/${name} 不该出现在表里（理由见 SLASH_COMMANDS 的注释）`,
    );
  }
});

test('命令表：描述与 argumentHint 逐字照抄 pi（`/quit` 只换应用名）', () => {
  for (const command of SLASH_COMMANDS) {
    if (ELA_ONLY.has(command.name)) continue;
    const source = piByName.get(command.name);
    assert.ok(source);
    if (command.name === 'quit') {
      assert.equal(command.description, 'Quit ela', 'pi 的是 `Quit pi`，只换应用名');
      continue;
    }
    assert.equal(command.description, source.description, `/${command.name} 的描述与 pi 不一致`);
    assert.equal(
      command.argumentHint,
      source.argumentHint,
      `/${command.name} 的 argumentHint 与 pi 不一致`,
    );
  }
});

test('命令表：顺序是 pi 表的子序列（缺的那几条一眼看得出是没做）', () => {
  const piOrder = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
  const ours = SLASH_COMMANDS.map((command) => command.name).filter((name) => !ELA_ONLY.has(name));
  let cursor = -1;
  for (const name of ours) {
    const at = piOrder.indexOf(name);
    assert.ok(at > cursor, `/${name} 的位置与 pi 的先后不一致`);
    cursor = at;
  }
});

test('命令表：删掉的那几条 ela 自有命令不回来', () => {
  for (const name of ['sessions', 'clean', 'wipe', 'help', 'forget', 'mcp']) {
    assert.ok(
      !SLASH_COMMANDS.some((command) => command.name === name),
      `/${name} 已删除（/sessions→/resume；/clean /wipe 交给 /resume 面板的 ctrl+d；/help 交给补全）`,
    );
  }
});

test('命令表：会话类命令不下发浏览器（只有非会话类才标 web）', () => {
  const web = SLASH_COMMANDS.filter((command) => command.web === true).map((command) => command.name);
  // 浏览器侧只实现了这几条（见 `webui/src/commands.ts` 的 switch）。多标一个
  // `web: true` 的症状是「浏览器里能选到它，点了回一句未知命令」。
  assert.deepEqual(web.sort(), [
    'compact',
    'continue',
    'model',
    'reload',
    'scoped-models',
    'settings',
    'skills',
    'thinking',
  ]);
});

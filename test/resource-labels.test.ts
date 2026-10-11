/**
 * 开场「已装载资源」标签的单测 —— 与 pi 的 `getCompactExtensionLabels()` 同形。
 *
 * ## 为什么单独拆一个文件测
 *
 * 这些标签是**纯函数**（输入几条扩展，输出一行逗号分隔的清单），所以能单测；
 * 而它们早先根本没有这个函数 —— 开场那一节直接报的是 `tools`（扩展注册的**工具名**）。
 *
 * 那就是用户看到的 bug：`[扩展] ask_user_question` 里没有一个是扩展的名字，
 * 照着去 `settings.json` 的 `packages` 里找必然找不到。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { contextLabels, extensionLabels, tildePath } from '../src/tui/resource-labels';

test('npm 来源的扩展报 `包名:入口`，不是全路径', () => {
  const labels = extensionLabels([
    {
      path: path.join('C:', 'Users', 'me', '.pi', 'agent', 'npm', 'node_modules', 'pi-web-access', 'dist', 'index.js'),
      source: 'npm:pi-web-access',
      baseDir: path.join('C:', 'Users', 'me', '.pi', 'agent', 'npm', 'node_modules', 'pi-web-access'),
    },
  ]);
  assert.deepEqual(labels, ['pi-web-access:dist']);
});

test('包的顶层入口只报包名（`index.js` 不算名字）', () => {
  const base = path.join('repo', 'node_modules', 'pi-web-access');
  assert.deepEqual(
    extensionLabels([{ path: path.join(base, 'index.js'), source: 'npm:pi-web-access', baseDir: base }]),
    ['pi-web-access'],
  );
});test('本地扩展只报末尾文件名，不报全路径', () => {
  const labels = extensionLabels([
    { path: path.join('C:', 'Users', 'me', '.pi', 'agent', 'orca', 'orca-status.ts'), source: 'local' },
  ]);
  assert.deepEqual(labels, ['orca-status.ts']);
});

test('两个同名文件加长到唯一后缀（清单是用来认哪一个的）', () => {
  const labels = extensionLabels([
    { path: path.join('a', 'plugins', 'index.ts'), source: 'local' },
    { path: path.join('b', 'plugins', 'index.ts'), source: 'local' },
  ]);
  // 末尾的 `index.ts` 被去掉后仍然撞名，于是加长到目录段才唯一。
  assert.equal(labels.length, 2);
  assert.ok(labels.includes('a/plugins'), `实际：${labels.join(' | ')}`);
  assert.ok(labels.includes('b/plugins'), `实际：${labels.join(' | ')}`);
});

test('文件名单段就唯一时只报文件名（与 pi 一致）', () => {
  const labels = extensionLabels([
    { path: path.join('a', 'a.ts'), source: 'local' },
    { path: path.join('z', 'z.ts'), source: 'local' },
  ]);
  // pi 取「末尾最短的唯一后缀」：`a/a.ts` 的 `a.ts` 已经唯一，不必带目录。
  assert.deepEqual(labels, ['a.ts', 'z.ts']);
});

test('没有 sourceInfo.baseDir 时退到 node_modules 相对位置（老版本 pi）', () => {
  const labels = extensionLabels([
    {
      path: path.join('C:', 'x', 'node_modules', 'pi-web-access', 'dist', 'index.js'),
      source: 'npm:pi-web-access',
    },
  ]);
  assert.deepEqual(labels, ['pi-web-access:dist']);
});

test('带作用域的包名（`@scope/pkg`）也要能拆出来', () => {
  const base = path.join('repo', 'node_modules', '@juicesharp', 'rpiv-ask-user-question');
  assert.deepEqual(
    extensionLabels([{ path: path.join(base, 'index.js'), source: 'npm:@juicesharp/rpiv-ask-user-question', baseDir: base }]),
    ['@juicesharp/rpiv-ask-user-question'],
  );
  // 没有 baseDir 的那条退路也要认得两段包名。
  assert.deepEqual(
    extensionLabels([
      {
        path: path.join('repo', 'node_modules', '@juicesharp', 'rpiv-ask-user-question', 'dist', 'index.js'),
        source: 'npm:@juicesharp/rpiv-ask-user-question',
      },
    ]),
    ['@juicesharp/rpiv-ask-user-question:dist'],
  );
});

test('[Context] 清单：cwd 下的相对显示，家目录缩 ~', () => {
  const cwd = path.join('C:', 'work', 'proj');
  const home = path.join('C:', 'Users', 'me');
  const labels = contextLabels(
    [
      { path: path.join(home, 'AGENTS.md') },
      { path: path.join(cwd, 'AGENTS.md') },
      { path: path.join(home, '.pi', 'agent', 'APPEND_SYSTEM.md') },
    ],
    cwd,
    home,
  );
  assert.deepEqual(labels, ['~/AGENTS.md', 'AGENTS.md', '~/.pi/agent/APPEND_SYSTEM.md']);
});

test('tildePath 只在真前缀上替换（`/home/me2` 不是 `/home/me`）', () => {
  // 显式用 `/` 而不是 path.join —— 这个断言关心的是**分隔符无关**的前缀判断。
  assert.equal(tildePath('/home/me/x', '/home/me'), '~/x');
  assert.equal(tildePath('/home/me2/x', '/home/me'), '/home/me2/x');
});

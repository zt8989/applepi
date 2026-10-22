/**
 * `resolveWebuiDist()` 的注入口子。
 *
 * 打包运行（`packages/tui/dist/ela.mjs`）时 `import.meta.url` 落在 `dist/`，从那里
 * `require.resolve('@ela/webui/package.json')` 解析不到 workspace 那份 —— 启动器把真路径
 * 放进 `ELA_WEBUI_DIST`（见 `bin/ela.mjs`）。守的是两件事：
 *
 *   1. 注入的那条**优先**于 `require.resolve` 推出来的；
 *   2. 只有真的存在 `index.html` 才算数 —— 否则服务器会去 serve 一个空目录，
 *      症状是浏览器白屏，比「给一页说明」更难查。
 *
 * 断言都写成「和注入的那条比」，不假设 webui 到底构没构建过（`packages/webui/dist` 在有/无之间
 * 摇摆，写死 `undefined` 会让测试在两种机器上各挂一次）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveWebuiDist } from '../src/web/server';

/** 临时改一个环境变量跑 fn，跑完还原（不还原会污染同进程的其它测试）。 */
function withEnv(name: string, value: string, fn: () => void): void {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('resolveWebuiDist：注入了 ELA_WEBUI_DIST 且有 index.html 就用它', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ela-webui-dist-'));
  try {
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html>\n');
    withEnv('ELA_WEBUI_DIST', dir, () => {
      assert.equal(resolveWebuiDist(), dir);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveWebuiDist：注入的目录还没构建（没有 index.html）时不返回它', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ela-webui-empty-'));
  try {
    withEnv('ELA_WEBUI_DIST', dir, () => {
      assert.notEqual(resolveWebuiDist(), dir, '没有 index.html 的目录不能拿去 serve');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveWebuiDist：注入指向不存在的目录时不返回它', () => {
  const missing = path.join(tmpdir(), `ela-webui-missing-${process.pid}`);
  withEnv('ELA_WEBUI_DIST', missing, () => {
    assert.notEqual(resolveWebuiDist(), missing);
  });
});

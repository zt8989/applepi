/**
 * `ensurePiPackageDir()` 的单测。
 *
 * 这条路径的失败方式很隐蔽：它不抛错，只是让 pi 的主题静默回落到 system，
 * 表现成「卡片的颜色丢了」。所以这里测两件事 —— 真的找得到 pi 包根（主题 JSON 在
 * 它下面），以及已经设好的 `PI_PACKAGE_DIR` 不被覆盖（宿主/Nix 指定的路径优先）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ensurePiPackageDir } from '../src/pi-package-dir';

const KEY = 'PI_PACKAGE_DIR';

function withEnv<T>(value: string | undefined, run: () => T): T {
  const saved = process.env[KEY];
  try {
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    return run();
  } finally {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  }
}

test('没设 PI_PACKAGE_DIR 时解析出真的 pi 包根（主题 JSON 在它下面）', () => {
  const { packageDir, env } = withEnv(undefined, () => ({
    packageDir: ensurePiPackageDir(),
    env: process.env[KEY],
  }));

  assert.ok(packageDir, '应该解析出 pi 的包目录');
  assert.equal(path.basename(packageDir), 'pi-coding-agent');
  // getThemesDir 会在有 src 时走 src、否则走 dist；发布包里只有 dist。
  const themesDir = ['src', 'dist']
    .map((kind) => path.join(packageDir, kind, 'modes', 'interactive', 'theme'))
    .find((dir) => existsSync(dir));
  assert.ok(themesDir, `主题目录不存在：${packageDir}`);
  assert.ok(existsSync(path.join(themesDir, 'dark.json')), 'dark.json 应该随包发布');
  assert.equal(env, packageDir, '解析结果要写回环境变量');
});

test('已设置的 PI_PACKAGE_DIR 原样返回，不被覆盖', () => {
  const fake = path.join(path.sep, 'nix', 'store', 'fake-pi');
  const { packageDir, env } = withEnv(fake, () => ({
    packageDir: ensurePiPackageDir(),
    env: process.env[KEY],
  }));

  assert.equal(packageDir, fake);
  assert.equal(env, fake);
});

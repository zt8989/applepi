import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { configHome } from '../src/config-home';

/**
 * pnpm patch 打开的子路径。
 *
 * ## 这个测试守什么
 *
 * `@earendil-works/pi-coding-agent` 的 `exports` 只开放了 4 个入口（`.`、`./rpc-entry`、
 * `./client`、`./experimental/plugin`），其余全被封住。而我们需要它的**内部**模块：
 *
 *   - `dist/config.js`                    `getAgentDir()` —— 配置家目录的唯一真相
 *   - `dist/core/model-config.js`         `ModelConfig` —— models.json 的官方 schema 校验
 *   - `dist/core/model-runtime.js`        `ModelRuntime`（主入口也有，但子路径能顺带拿别的）
 *   - `dist/modes/interactive/*`          pi 自己的 TUI（见 docs/architecture/surfaces.md）
 *
 * 解法是 `patches/@earendil-works__pi-coding-agent.patch`：给 `exports` 加两条通配符
 * （`./dist/*` 与 `./dist/*.js`）。那个 patch 一旦丢了、或者 pnpm 升级后没重新应用，
 * 这些 import 会全部变成 `ERR_PACKAGE_PATH_NOT_EXPORTED` —— 所以要有测试盯着。
 *
 * **为什么值得盯**：这类失败的症状是「起不来」而不是「某个功能坏了」，报错信息里只有
 * 一个包名和一个 `exports` 字样，不看 patch 文件很难联想到是它没了。
 */

test('patch 生效：pi 的配置模块子路径可导入', async () => {
  const config = await import('@earendil-works/pi-coding-agent/dist/config.js');
  assert.equal(typeof config.getAgentDir, 'function', 'getAgentDir 应该在');
  // 它的返回值必须是个绝对路径 —— 这是我们与 pi 共用配置目录的前提。
  //
  // 注意**不能**断言它以 `/agent` 结尾：测试跑在 `PI_CODING_AGENT_DIR` 指向的临时目录里
  // （见 test/isolated-home.ts），目录名是 `redux-agent-test-home-<pid>-XXXX`，
  // 断言后缀等于在断言一个与本测试无关的东西。用户没设环境变量时才是 `~/.pi/agent`。
  const dir = config.getAgentDir();
  assert.ok(dir.length > 0, '不能为空');
  assert.ok(path.isAbsolute(dir), `应是绝对路径，实际 ${dir}`);
  // 而我们自己的 configHome() 必须与它**逐字相同** —— 这一条才是真正要守的不变量：
  // 两者一旦分家，models.json / auth.json / sessions/ 就各写各的。
  assert.equal(configHome(), dir, 'configHome() 必须与 pi 的 getAgentDir() 一致');
});

test('patch 生效：models.json 的官方校验器可导入', async () => {
  const { ModelConfig } = await import('@earendil-works/pi-coding-agent/dist/core/model-config.js');
  assert.equal(typeof ModelConfig.load, 'function');
  // 不传路径 = 不读文件（官方支持的用法），返回空配置且无错误。
  // （传 undefined 而不是 null：1.0.3 的类型签名是 `string | undefined` 且必填。）
  const empty = await ModelConfig.load(undefined);
  assert.equal(empty.getError(), undefined);
  assert.deepEqual(empty.getProviderIds(), []);
});

test('patch 生效：pi 的 TUI 与运行时子路径可导入', async () => {
  // 这两个是「未来可能用上」的：InteractiveMode 现在不接（要 75 个 settingsManager
  // 成员，见 docs/architecture/surfaces.md），但子路径可达意味着那条路没被 exports 堵死。
  const [interactive, runtime] = await Promise.all([
    import('@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js'),
    import('@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js'),
  ]);
  assert.equal(typeof interactive.InteractiveMode, 'function');
  assert.equal(typeof runtime.AgentSessionRuntime, 'function');
});

test('patch 文件本身在（丢了就会 ERR_PACKAGE_PATH_NOT_EXPORTED）', async () => {
  const { readFile, access } = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const patchFile = path.join(root, 'patches', '@earendil-works__pi-coding-agent.patch');
  await access(patchFile);
  const text = await readFile(patchFile, 'utf8');
  // 断言它确实改的是 exports 里的 dist 通配符 —— 只看文件存在不够，
  // 有人可能把无关的改动打进同一个 patch。
  assert.ok(text.includes('"./dist/*"'), 'patch 应该给 exports 加了 ./dist/* 通配符');
  assert.ok(text.includes('"./dist/*.js"'), 'patch 应该给 exports 加了 ./dist/*.js 通配符');
});
